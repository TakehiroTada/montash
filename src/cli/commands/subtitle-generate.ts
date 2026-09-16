/**
 * `montash subtitle generate` — 音声から字幕を起こす（docs/03 W-22, docs/04 §12）。
 *
 * 実地では「`render audio` → ffmpeg で 16kHz 化 → whisper-cli → 自作スクリプトで整形 → `import` →
 * `subtitle add`」を手で繋いでいた。その 5 手をこのコマンド 1 つにまとめる。
 *
 * 設計の芯:
 *   - **書き起こしエンジンは組み込まない**。ネットワークから何も取得しない方針（docs/14「やらないこと」）と、
 *     モデルが数百 MB になるため。既定は `whisper-cli`（whisper.cpp）を**外部コマンド**として呼ぶ
 *     （`ffmpeg/transcribe.ts`。作法は `ffmpeg/run.ts` に合わせる）。
 *   - **整形ロジックは montash が持つ**。エンジンが返すトークン単位のタイムスタンプを
 *     「読める字幕」にするのが本体の価値で、`core/subtitle-format.ts` に純関数として置く。
 *   - 生成した SRT は**素材として取り込み、字幕クリップとして置く**ところまでやる（`--no-add` で SRT だけ）。
 *
 * 字幕スタイルの調整は `subtitle set` に任せる（このコマンドは起こすことに集中する）。
 *
 * **誤認識を直す経路**（W-24）: エンジンは固有名詞を外す。`--vocabulary` でも拾わないことがある
 * （実地で「フロントエンド運用」→「フロント演動」）。直すのは **SRT ではなくトークン列**で、
 *   - `--save-transcript <path>` で整形前のトークンを JSON に残す
 *   - `--from-transcript <path>` でそれを読み直す（**エンジンを再実行しない**ので速い）
 *   - `--replace "フロント演動=フロントエンド運用"` を**整形の前**に当てる
 * 整形はやり直されるので、語が長くなっても 2 行 x 20 字の折り返しは崩れない。
 * **何が誤りかは montash が決めない**（規則を書くのは人。docs/13 D-23 の線引きと同じ）。
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertIdAvailable, existingIds, nextId, slugAssetId } from "../../core/ids.ts";
import { atomicWrite, loadProject } from "../../core/project.ts";
import {
  type Asset,
  AssetSchema,
  type Project,
  SubtitleClipSchema,
  type Track,
  TrackSchema,
} from "../../core/schema.ts";
import { formatTranscript, SUBTITLE_FORMAT_DEFAULTS, type TranscriptToken, toSrt } from "../../core/subtitle-format.ts";
import { nextTrackId, requireTrack } from "../../core/timeline.ts";
import { applyReplacements } from "../../core/transcript.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { pickCjkFallback } from "../../ffmpeg/ass.ts";
import { listFonts } from "../../ffmpeg/fonts.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import {
  parseVocabulary,
  requireModel,
  requireTranscriber,
  runTranscriber,
  type TranscribeResult,
  type TranscriberLocation,
  whisperArgs,
} from "../../ffmpeg/transcribe.ts";
import { type ExtractAudioResult, extractFileAudio, extractTimelineAudio } from "../../ffmpeg/transcribe-audio.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, MontashError, type Warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput } from "../time-input.ts";
import {
  collectReplaceRules,
  loadTranscript,
  saveTranscript,
  TRANSCRIPT_OPTIONS,
  unusedRulesWarning,
} from "../transcript-input.ts";

type Args = Record<string, unknown>;

/** yargs は `--max-chars` を `maxChars` としても渡す */
function option(args: Args, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return args[camel] ?? args[name];
}

function has(args: Args, name: string): boolean {
  return option(args, name) !== undefined;
}

function optString(args: Args, name: string): string | undefined {
  const v = option(args, name);
  return v === undefined ? undefined : String(v);
}

function optNumber(args: Args, name: string, positive = true): number | undefined {
  if (!has(args, name)) return undefined;
  const n = Number(option(args, name));
  if (!Number.isFinite(n) || (positive && n <= 0)) throw errors.usage(`--${name} must be a positive number`);
  if (!positive && n < 0) throw errors.usage(`--${name} must be zero or a positive number`);
  return n;
}

// ---------------------------------------------------------------------------
// テスト用のフック（外部プロセスを呼ばずにコマンド全体を検証するため）
// ---------------------------------------------------------------------------

export interface TranscribeHooks {
  extractAudio?: (input: {
    dir: string;
    project: Project;
    output: string;
    /** 素材 1 つを書き起こすときの元ファイル（タイムライン全体なら null） */
    source: string | null;
  }) => Promise<ExtractAudioResult>;
  transcribe?: (input: {
    engine: string;
    model: string;
    audio: string;
    outPrefix: string;
    lang: string | undefined;
    vocabulary: string[];
  }) => Promise<TranscribeResult>;
}

let hooks: TranscribeHooks | null = null;

/** テスト用: 音声書き出しとエンジン呼び出しを差し替える（null で解除） */
export function __setTranscribeHooks(next: TranscribeHooks | null): void {
  hooks = next;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** テキストトラックを得る。名前指定が無く 1 つも無ければ T1 を自動作成する */
function textTrackFor(project: Project, name: unknown): { track: Track; created: boolean } {
  if (name !== undefined) {
    const track = requireTrack(project, String(name));
    if (track.kind !== "text")
      throw errors.usage(`track ${track.id} is a ${track.kind} track`, "Subtitles go on a text track (T1, T2 ...).");
    return { track, created: false };
  }
  const existing = project.tracks.find((t) => t.kind === "text");
  if (existing) return { track: existing, created: false };
  const id = nextTrackId(project, "text");
  const track = TrackSchema.parse({ id, kind: "text", name: id });
  project.tracks.push(track);
  return { track, created: true };
}

/** 焼き込みで CJK が豆腐にならないよう既定フォントを選ぶ（列挙できない環境では諦める） */
async function defaultBurnFont(ctx: CommandContext, project: Project): Promise<string | undefined> {
  if (project.settings.default_font) return project.settings.default_font;
  try {
    const { fonts } = await listFonts({ env: ctx.env });
    return pickCjkFallback(fonts)?.family;
  } catch {
    return undefined;
  }
}

/** 書き起こす音声の出どころ（素材 1 つ、またはタイムライン全体） */
function audioSource(
  project: Project,
  dir: string,
  assetId: string | undefined,
): { asset: Asset | null; path: string | null } {
  if (assetId === undefined) return { asset: null, path: null };
  const asset = project.assets[assetId];
  if (!asset)
    throw new MontashError("E_ASSET_NOT_FOUND", `asset "${assetId}" not found`, {
      hint: "Use `montash assets list --json` to see the imported assets.",
      detail: { asset: assetId },
    });
  if (asset.type !== "video" && asset.type !== "audio")
    throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${assetId}" is a ${asset.type} asset, not video/audio`, {
      hint: "Pass a video or audio asset, or omit --asset to transcribe the timeline mix.",
      detail: { asset: assetId, type: asset.type },
    });
  return { asset, path: resolveAssetPath(dir, asset.path) };
}

const SRT_DIR = "subtitles";

// ---------------------------------------------------------------------------
// subtitle generate
// ---------------------------------------------------------------------------

export const subtitleGenerate = defineCommand({
  path: "subtitle generate",
  summary: "transcribe speech into a subtitle file with an external engine and place it on the timeline",
  description:
    "Runs an external transcription engine (whisper.cpp `whisper-cli` by default; montash never downloads it), " +
    "turns its token level timestamps into readable cues (sentence first, never mid-word, Japanese kinsoku, " +
    "max 2 lines x 20 chars, 1.2-5.5s), writes an SRT, imports it and adds a subtitle clip. " +
    "Misheard words are fixed on the tokens, not on the SRT: --save-transcript keeps them, --from-transcript " +
    "reads them back without the engine, and --replace rewrites words before formatting so the wrapping is redone.",
  workflows: ["W-22", "W-24"],
  mutates: true,
  options: {
    asset: { type: "string", describe: "transcribe this video/audio asset (default: the timeline mix)" },
    ...TRANSCRIPT_OPTIONS,
    lang: { type: "string", describe: "spoken language (ISO 639-1, or `auto`)", default: "ja" },
    vocabulary: {
      type: "array",
      describe: 'proper nouns to bias the engine, comma separated ("多面観察,総括次長")',
    },
    engine: { type: "string", describe: "engine executable name (default: whisper-cli, whisper-cpp, whisper)" },
    "engine-path": { type: "string", describe: "engine executable path (also MONTASH_TRANSCRIBER)" },
    model: {
      type: "string",
      describe: "model file (also MONTASH_TRANSCRIBER_MODEL; default: newest *.bin in the montash whisper home)",
    },
    threads: { type: "number", describe: "engine threads" },
    timeout: { type: "number", describe: "abort the engine after N seconds" },
    output: {
      type: "string",
      alias: "o",
      describe: `SRT output path (default: <project>/${SRT_DIR}/<name>.<lang>.srt)`,
    },
    overwrite: { type: "boolean", describe: "replace an existing SRT file", default: false },
    add: {
      type: "boolean",
      describe: "import the SRT and place it as a subtitle clip (--no-add writes the file only)",
      default: true,
    },
    mode: {
      type: "string",
      describe: "burn into the picture, or mux as a selectable track",
      choices: ["burn", "soft"] as const,
      default: "burn",
    },
    track: { type: "string", describe: "text track (default: the first text track, else a new T1)" },
    at: { type: "string", describe: "timeline position of the first cue (default 0)", time: true },
    font: { type: "string", describe: "font family for burned subtitles" },
    "asset-id": { type: "string", describe: "explicit ID for the generated subtitle asset" },
    id: { type: "string", describe: "explicit subtitle clip ID (default: the next s<N>)" },
    "max-chars": {
      type: "number",
      describe: `max characters per line (default ${SUBTITLE_FORMAT_DEFAULTS.maxCharsPerLine})`,
    },
    "max-lines": { type: "number", describe: `max lines per cue (default ${SUBTITLE_FORMAT_DEFAULTS.maxLines})` },
    "min-duration": {
      type: "number",
      describe: `min seconds a cue stays on screen (default ${SUBTITLE_FORMAT_DEFAULTS.minDurationMs / 1000})`,
    },
    "max-duration": {
      type: "number",
      describe: `max seconds a cue stays on screen (default ${SUBTITLE_FORMAT_DEFAULTS.maxDurationMs / 1000})`,
    },
    pause: {
      type: "number",
      describe:
        "split a cue where the speaker pauses this many seconds, even without a full stop " +
        `(default ${SUBTITLE_FORMAT_DEFAULTS.pauseGapMs / 1000}; 0 to only split on punctuation)`,
    },
  },
  examples: [
    { cmd: "montash subtitle generate --lang ja", note: "transcribe the timeline mix and burn the result in" },
    {
      cmd: 'montash subtitle generate --asset talk --lang ja --vocabulary "多面観察,総括次長"',
      note: "a term list changes the accuracy a lot on proper nouns",
    },
    { cmd: "montash subtitle generate --no-add -o subs/draft.srt", note: "only write the SRT, review it by hand" },
    {
      cmd: "montash subtitle generate --save-transcript subs/talk.json --no-add -o subs/draft.srt",
      note: "keep the tokens so the formatting can be redone without transcribing again",
    },
    {
      cmd: 'montash subtitle generate --from-transcript subs/talk.json --replace "フロント演動=フロントエンド運用" --overwrite',
      note: "fix a misheard word and re-format from the tokens (no engine, so the line wrapping is redone)",
    },
  ],
  async handler(ctx, args: Args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const warnings: Warning[] = [];

    // --- 置換規則（規則を書くのは人。montash は何が誤りかを判断しない。W-24） ---
    const replaceFile = optString(args, "replace-file");
    const rules = await collectReplaceRules({
      replace: option(args, "replace"),
      replaceFile: replaceFile === undefined ? undefined : resolve(ctx.cwd, replaceFile),
    });
    const fromTranscriptOpt = optString(args, "from-transcript");
    const fromTranscript = fromTranscriptOpt === undefined ? undefined : resolve(ctx.cwd, fromTranscriptOpt);
    const saveTranscriptOpt = optString(args, "save-transcript");
    const saveTo = saveTranscriptOpt === undefined ? undefined : resolve(ctx.cwd, saveTranscriptOpt);

    // --- 入力（素材 1 つ / タイムライン全体 / 保存済みの書き起こし） ---
    const assetId = optString(args, "asset");
    if (fromTranscript !== undefined && assetId !== undefined)
      throw errors.usage(
        "--from-transcript and --asset cannot be combined",
        "The saved transcript already says what was transcribed; --asset would have nothing to do.",
      );
    // 保存済みを読むなら、エンジンもモデルも音声も要らない（整形をやり直すだけ）
    const saved = fromTranscript === undefined ? null : await loadTranscript(fromTranscript);

    // --- エンジンとモデル（何より先に確かめる。無ければ何も書き出さずに終わる） ---
    const engine =
      saved !== null
        ? null
        : requireTranscriber({
            enginePath: optString(args, "engine-path"),
            engine: optString(args, "engine"),
            env: ctx.env,
          });
    const model =
      saved !== null ? (saved.model ?? null) : requireModel({ model: optString(args, "model"), env: ctx.env });
    const engineInfo = engine !== null ? { path: engine.path, source: engine.source } : (saved?.engine ?? null);

    const source = saved !== null ? { asset: null, path: null } : audioSource(project, dir, assetId);
    const sourceLabel =
      saved !== null
        ? saved.source === ""
          ? fromTranscript
          : (saved.source ?? fromTranscript)
        : (source.path ?? "timeline");

    // --- 出力先 ---
    const lang = String(option(args, "lang") ?? "ja");
    const stem = assetId ?? saved?.asset ?? project.name ?? basename(dir);
    const output = has(args, "output")
      ? resolve(ctx.cwd, String(option(args, "output")))
      : join(dir, SRT_DIR, `${stem}.${lang}.srt`);
    if (!option(args, "overwrite") && (await stat(output).catch(() => null)) !== null)
      throw new MontashError("E_OUTPUT_EXISTS", `output exists: ${output}`, {
        hint: "Choose another --output or pass --overwrite.",
      });

    const vocabulary = parseVocabulary(option(args, "vocabulary") as string | string[] | undefined);
    const format = {
      ...(optNumber(args, "max-chars") !== undefined
        ? { maxCharsPerLine: optNumber(args, "max-chars") as number }
        : {}),
      ...(optNumber(args, "max-lines") !== undefined ? { maxLines: optNumber(args, "max-lines") as number } : {}),
      ...(optNumber(args, "min-duration") !== undefined
        ? { minDurationMs: (optNumber(args, "min-duration") as number) * 1000 }
        : {}),
      ...(optNumber(args, "max-duration") !== undefined
        ? { maxDurationMs: (optNumber(args, "max-duration") as number) * 1000 }
        : {}),
      ...(optNumber(args, "pause", false) !== undefined
        ? { pauseGapMs: (optNumber(args, "pause", false) as number) * 1000 }
        : {}),
    };

    // --- --dry-run: 何が起きるかだけ返す ---
    if (ctx.globals.dryRun && saved !== null) {
      return {
        result: {
          dry_run: true,
          from_transcript: fromTranscript,
          engine: engineInfo,
          model,
          language: lang,
          vocabulary,
          replacements: rules.map((r) => ({ ...r, count: null })),
          source: sourceLabel,
          output,
          tokens: saved.tokens.length,
          command: null,
        },
        human: `would re-format ${saved.tokens.length} saved tokens from ${fromTranscript}${rules.length ? ` with ${rules.length} replacement(s)` : ""} and write ${output}`,
      };
    }
    if (ctx.globals.dryRun) {
      const plan = whisperArgs({
        model: model as string,
        audio: "<16kHz mono wav>",
        outPrefix: "<tmp>/transcript",
        lang: lang === "auto" ? undefined : lang,
        vocabulary,
        ...(optNumber(args, "threads") !== undefined ? { threads: optNumber(args, "threads") as number } : {}),
      });
      return {
        result: {
          dry_run: true,
          from_transcript: null,
          engine: engineInfo,
          model,
          language: lang,
          vocabulary,
          replacements: rules.map((r) => ({ ...r, count: null })),
          source: sourceLabel,
          output,
          command: [(engine as TranscriberLocation).path, ...plan],
        },
        human: `would transcribe ${source.path ?? "the timeline mix"} with ${(engine as TranscriberLocation).path} and write ${output}`,
      };
    }

    // --- 音声の書き出し → 書き起こし（保存済みを読むならどちらもやらない） ---
    let transcribed: TranscribeResult | null = null;
    let extracted: ExtractAudioResult | null = null;
    let rawTokens: TranscriptToken[] = saved?.tokens ?? [];
    if (saved === null) {
      const engineFound = engine as TranscriberLocation;
      const tmp = await mkdtemp(join(tmpdir(), "montash-transcribe-"));
      try {
        const wav = join(tmp, "audio.wav");
        if (hooks?.extractAudio) {
          extracted = await hooks.extractAudio({ dir, project, output: wav, source: source.path });
        } else {
          const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
          extracted =
            source.path === null
              ? await extractTimelineAudio(bins, dir, project, wav, {
                  cwd: dir,
                  ...(ctx.globals.verbose ? { log: (l: string) => ctx.stderr(`${l}\n`) } : {}),
                })
              : await extractFileAudio(bins, source.path, wav, {
                  cwd: dir,
                  ...(ctx.globals.verbose ? { log: (l: string) => ctx.stderr(`${l}\n`) } : {}),
                });
        }
        const outPrefix = join(tmp, "transcript");
        const timeout = optNumber(args, "timeout");
        transcribed = hooks?.transcribe
          ? await hooks.transcribe({
              engine: engineFound.path,
              model: model as string,
              audio: wav,
              outPrefix,
              lang: lang === "auto" ? undefined : lang,
              vocabulary,
            })
          : await runTranscriber({
              engine: engineFound.path,
              model: model as string,
              audio: wav,
              outPrefix,
              ...(lang === "auto" ? {} : { lang }),
              vocabulary,
              ...(optNumber(args, "threads") !== undefined ? { threads: optNumber(args, "threads") as number } : {}),
              ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
              ...(ctx.globals.verbose ? { log: (l: string) => ctx.stderr(`${l}\n`) } : {}),
            });
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      rawTokens = transcribed.tokens;
    }

    // --- 置換（整形の**前**に当てる。ここで直せば折り返しがやり直される。純関数） ---
    const replaced = applyReplacements(rawTokens, rules);
    const unused = unusedRulesWarning(replaced.applied);
    if (unused !== null) warnings.push(unused);
    const tokens: TranscriptToken[] = replaced.tokens;

    // --- 整形（ここが本体の価値。純関数） ---
    const cues = formatTranscript(tokens, format);
    if (cues.length === 0)
      throw new MontashError(
        "E_TRANSCRIPT_EMPTY",
        saved === null ? "the engine returned no speech for this audio" : `${fromTranscript} has no usable speech`,
        {
          hint:
            saved === null
              ? "Check that the timeline (or --asset) actually has speech, and that --lang matches it. A larger model helps on noisy audio."
              : "Check the `text` field of the transcript, and that the replacements did not delete everything.",
          exitCode: ExitCode.EXTERNAL,
          detail: { tokens: tokens.length, engine: engineInfo?.path ?? null, model, language: lang },
        },
      );
    await mkdir(dirname(output), { recursive: true });
    await atomicWrite(output, toSrt(cues));

    // --- 整形前のトークンを残す（次はエンジンを回さずにここから直せる） ---
    if (saveTo !== undefined)
      await saveTranscript(saveTo, tokens, {
        engine: engineInfo,
        model,
        language: lang,
        vocabulary,
        source: sourceLabel,
        asset: assetId ?? saved?.asset ?? null,
        replacements: replaced.applied,
      });

    const transcript = {
      engine: engineInfo,
      model,
      language: lang,
      vocabulary,
      source: sourceLabel,
      srt: output,
      cues: cues.length,
      tokens: tokens.length,
      duration_s: Math.round((cues.at(-1) as (typeof cues)[number]).endMs) / 1000,
      command: transcribed === null ? null : [(engine as TranscriberLocation).path, ...transcribed.args],
      ffmpeg_command: extracted === null ? null : extracted.args,
      from_transcript: fromTranscript ?? null,
      saved_transcript: saveTo ?? null,
      replacements: replaced.applied,
    };

    const engineLine =
      saved === null
        ? `engine ${engineInfo?.path ?? "(none)"}  model ${model === null ? "(none)" : basename(model)}  lang ${lang}` +
          `${vocabulary.length ? `  vocabulary ${vocabulary.length}` : ""}`
        : `from ${fromTranscript} (${tokens.length} tokens, no engine run)  lang ${lang}`;
    const replacedLine =
      replaced.applied.length === 0
        ? null
        : `replaced ${replaced.applied.map((r) => `${r.from}→${r.to || "(nothing)"} x${r.count}`).join(", ")}`;

    // --- SRT だけ欲しいとき ---
    if (option(args, "add") === false) {
      return {
        result: { ...transcript, asset: null, clip: null },
        warnings,
        human: [
          `wrote ${output} (${cues.length} cues)`,
          `  ${engineLine}`,
          ...(replacedLine === null ? [] : [`  ${replacedLine}`]),
          ...(saveTo === undefined ? [] : [`  transcript ${saveTo}`]),
        ].join("\n"),
      };
    }

    // --- 素材として取り込み、字幕クリップとして置く ---
    const mode = String(option(args, "mode") ?? "burn") as "burn" | "soft";
    const requestedFont = optString(args, "font");
    const font = mode === "burn" ? (requestedFont ?? (await defaultBurnFont(ctx, project))) : requestedFont;
    const fileStat = await stat(output);
    const head = await Bun.file(output).arrayBuffer();

    return runMutation(ctx, async ({ project: working, dir: projectDir, fps }) => {
      const explicitAssetId = optString(args, "asset-id");
      const srtAssetId = explicitAssetId ?? slugAssetId(output, existingIds(working));
      assertIdAvailable(working, srtAssetId);
      const asset = AssetSchema.parse({
        id: srtAssetId,
        type: "subtitle",
        format: "srt",
        language: lang,
        path: output,
        owned: false,
        imported_by: ctx.actor,
        imported_at: new Date().toISOString(),
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
        hash_head: `sha256:${new Bun.CryptoHasher("sha256").update(head).digest("hex")}`,
        tags: ["generated"],
        duration_s: null,
        duration_f: null,
      });
      working.assets[asset.id] = asset;

      const { track, created } = textTrackFor(working, option(args, "track"));
      if (track.locked) throw new MontashError("E_TRACK_LOCKED", `track ${track.id} is locked`);

      let startF = 0;
      if (has(args, "at")) {
        const parsed = parseTimeInput(String(option(args, "at")), fps, { allowRelative: false, allowEnd: false });
        if (parsed.warning) warnings.push(parsed.warning);
        if (parsed.value.kind !== "absolute") throw errors.usage("--at needs an absolute time");
        startF = parsed.value.frames;
      }

      const explicitId = optString(args, "id");
      if (explicitId !== undefined) assertIdAvailable(working, explicitId);
      const clipId = explicitId ?? (await nextId(projectDir, "s"));
      const clip = SubtitleClipSchema.parse({
        id: clipId,
        type: "subtitle",
        asset: asset.id,
        mode,
        start_f: startF,
        offset_f: 0,
        style: font === undefined ? {} : { font },
        lang,
      });
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start_f - b.start_f);

      return {
        result: { ...transcript, asset, clip: { ...clip, track: track.id }, track_created: created ? track.id : null },
        summary: `generate subtitles from ${transcript.source === "timeline" ? "the timeline" : (assetId ?? basename(String(transcript.source)))} (${cues.length} cues)`,
        affects: { clips: [clip.id], range_f: null },
        warnings,
        human: [
          `wrote ${output} (${cues.length} cues, ${tokens.length} tokens)`,
          `  asset ${asset.id}  clip ${clip.id}  ${track.id}  ${mode}${created ? `  (created text track ${track.id})` : ""}`,
          `  ${engineLine}`,
          ...(replacedLine === null ? [] : [`  ${replacedLine}`]),
        ].join("\n"),
      };
    });
  },
});
