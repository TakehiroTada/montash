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
  whisperArgs,
} from "../../ffmpeg/transcribe.ts";
import { type ExtractAudioResult, extractFileAudio, extractTimelineAudio } from "../../ffmpeg/transcribe-audio.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, MontashError, type Warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput } from "../time-input.ts";

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
    "max 2 lines x 20 chars, 1.2-5.5s), writes an SRT, imports it and adds a subtitle clip.",
  workflows: ["W-22"],
  mutates: true,
  options: {
    asset: { type: "string", describe: "transcribe this video/audio asset (default: the timeline mix)" },
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
  },
  examples: [
    { cmd: "montash subtitle generate --lang ja", note: "transcribe the timeline mix and burn the result in" },
    {
      cmd: 'montash subtitle generate --asset talk --lang ja --vocabulary "多面観察,総括次長"',
      note: "a term list changes the accuracy a lot on proper nouns",
    },
    { cmd: "montash subtitle generate --no-add -o subs/draft.srt", note: "only write the SRT, review it by hand" },
  ],
  async handler(ctx, args: Args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const warnings: Warning[] = [];

    // --- エンジンとモデル（何より先に確かめる。無ければ何も書き出さずに終わる） ---
    const engine = requireTranscriber({
      enginePath: optString(args, "engine-path"),
      engine: optString(args, "engine"),
      env: ctx.env,
    });
    const model = requireModel({ model: optString(args, "model"), env: ctx.env });

    // --- 入力（素材 1 つ / タイムライン全体） ---
    const assetId = optString(args, "asset");
    const source = audioSource(project, dir, assetId);

    // --- 出力先 ---
    const lang = String(option(args, "lang") ?? "ja");
    const stem = assetId ?? project.name ?? basename(dir);
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
    };

    // --- --dry-run: 何が起きるかだけ返す ---
    if (ctx.globals.dryRun) {
      const plan = whisperArgs({
        model,
        audio: "<16kHz mono wav>",
        outPrefix: "<tmp>/transcript",
        lang: lang === "auto" ? undefined : lang,
        vocabulary,
        ...(optNumber(args, "threads") !== undefined ? { threads: optNumber(args, "threads") as number } : {}),
      });
      return {
        result: {
          dry_run: true,
          engine: { path: engine.path, source: engine.source },
          model,
          language: lang,
          vocabulary,
          source: source.path ?? "timeline",
          output,
          command: [engine.path, ...plan],
        },
        human: `would transcribe ${source.path ?? "the timeline mix"} with ${engine.path} and write ${output}`,
      };
    }

    // --- 音声の書き出し → 書き起こし ---
    const tmp = await mkdtemp(join(tmpdir(), "montash-transcribe-"));
    let transcribed: TranscribeResult;
    let extracted: ExtractAudioResult;
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
            engine: engine.path,
            model,
            audio: wav,
            outPrefix,
            lang: lang === "auto" ? undefined : lang,
            vocabulary,
          })
        : await runTranscriber({
            engine: engine.path,
            model,
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

    // --- 整形（ここが本体の価値。純関数） ---
    const tokens: TranscriptToken[] = transcribed.tokens;
    const cues = formatTranscript(tokens, format);
    if (cues.length === 0)
      throw new MontashError("E_TRANSCRIPT_EMPTY", "the engine returned no speech for this audio", {
        hint: "Check that the timeline (or --asset) actually has speech, and that --lang matches it. A larger model helps on noisy audio.",
        exitCode: ExitCode.EXTERNAL,
        detail: { tokens: tokens.length, engine: engine.path, model, language: lang },
      });
    await mkdir(dirname(output), { recursive: true });
    await atomicWrite(output, toSrt(cues));

    const transcript = {
      engine: { path: engine.path, source: engine.source },
      model,
      language: lang,
      vocabulary,
      source: source.path ?? "timeline",
      srt: output,
      cues: cues.length,
      tokens: tokens.length,
      duration_s: Math.round((cues.at(-1) as (typeof cues)[number]).endMs) / 1000,
      command: [engine.path, ...transcribed.args],
      ffmpeg_command: extracted.args,
    };

    // --- SRT だけ欲しいとき ---
    if (option(args, "add") === false) {
      return {
        result: { ...transcript, asset: null, clip: null },
        warnings,
        human: `wrote ${output} (${cues.length} cues)`,
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
        summary: `generate subtitles from ${transcript.source === "timeline" ? "the timeline" : (assetId as string)} (${cues.length} cues)`,
        affects: { clips: [clip.id], range_f: null },
        warnings,
        human: [
          `wrote ${output} (${cues.length} cues, ${tokens.length} tokens)`,
          `  asset ${asset.id}  clip ${clip.id}  ${track.id}  ${mode}${created ? `  (created text track ${track.id})` : ""}`,
          `  engine ${engine.path}  model ${basename(model)}  lang ${lang}${vocabulary.length ? `  vocabulary ${vocabulary.length}` : ""}`,
        ].join("\n"),
      };
    });
  },
});
