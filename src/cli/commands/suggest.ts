/**
 * `montash suggest highlights` — ハイライト候補を提示する（docs/03 W-23, docs/04 §16, docs/13 D-23）。
 *
 * 21 分の会議から切り抜きを作るドッグフーディングで、**どこを使うかを決める材料を montash が
 * 一切出していない**ことが分かった。結局 AI が書き起こしを読んで独断で区間を選び、重要な話題を
 * 落としてやり直しになった（D-23）。その材料をコマンドとして出すのがこれ。
 *
 * 設計の芯:
 *   - **候補を出すだけで、タイムラインには触れない**（`mutates: false`）。出力を見て人（または
 *     人の指示を受けた AI）が `clip add` を打つ。決めるのは人、という前提を崩さない。
 *     そのまま打てる `clip add` を候補ごとに `command` として添えるが、**実行はしない**。
 *   - **要約に LLM を使わない**。`lead` は書き起こしの先頭の文をそのまま切り出したもの、
 *     `keywords` はその区間に偏って出る語（tf-idf）。どちらも機械的に出せるものだけで、
 *     何を根拠にしているかは `evidence` に必ず載せる。
 *   - **検出そのものは純関数**（`core/highlights.ts`）。ここは I/O（音声の書き出し・silencedetect・
 *     書き起こしエンジンの起動）だけを持ち、測った値を注入する。loudnorm / ducking と同じ作法。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { timelineDurationF } from "../../core/assets.ts";
import {
  HIGHLIGHT_DEFAULTS,
  type HighlightCandidate,
  type HighlightResult,
  suggestHighlights,
} from "../../core/highlights.ts";
import { loadProject } from "../../core/project.ts";
import type { Asset, Project } from "../../core/schema.ts";
import type { TranscriptToken } from "../../core/subtitle-format.ts";
import { type Fps, framesToSeconds, framesToTimecode, secondsToFrames } from "../../core/time.ts";
import { applyReplacements } from "../../core/transcript.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { type AudioAnalysis, analyzeAudioFile } from "../../ffmpeg/audio-analysis.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import {
  parseVocabulary,
  requireModel,
  requireTranscriber,
  runTranscriber,
  type TranscribeResult,
} from "../../ffmpeg/transcribe.ts";
import { type ExtractAudioResult, extractFileAudio, extractTimelineAudio } from "../../ffmpeg/transcribe-audio.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, MontashError, type Warning } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { parseTimeInput } from "../time-input.ts";
import {
  collectReplaceRules,
  loadTranscript,
  saveTranscript,
  TRANSCRIPT_OPTIONS,
  unusedRulesWarning,
} from "../transcript-input.ts";

type Args = Record<string, unknown>;

function option(args: Args, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return args[camel] ?? args[name];
}

function optString(args: Args, name: string): string | undefined {
  const v = option(args, name);
  return v === undefined ? undefined : String(v);
}

function optNumber(args: Args, name: string, positive = true): number | undefined {
  const v = option(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || (positive && n <= 0)) throw errors.usage(`--${name} must be a positive number`);
  return n;
}

/** 時間表記（`300` / `5:00` / `f:9000`）を秒で読む */
function optSeconds(args: Args, name: string, fps: Fps): number | undefined {
  const raw = optString(args, name);
  if (raw === undefined) return undefined;
  const parsed = parseTimeInput(raw, fps, { allowRelative: false, allowEnd: false });
  if (parsed.value.kind !== "absolute") throw errors.usage(`--${name} needs an absolute time`);
  return framesToSeconds(parsed.value.frames, fps);
}

// ---------------------------------------------------------------------------
// テスト用のフック（外部プロセスを呼ばずにコマンド全体を検証するため）
// ---------------------------------------------------------------------------

export interface SuggestHooks {
  extractAudio?: (input: {
    dir: string;
    project: Project;
    output: string;
    source: string | null;
  }) => Promise<ExtractAudioResult>;
  analyze?: (input: { audio: string; duration: number }) => Promise<AudioAnalysis>;
  transcribe?: (input: {
    engine: string;
    model: string;
    audio: string;
    outPrefix: string;
    lang: string | undefined;
    vocabulary: string[];
  }) => Promise<TranscribeResult>;
}

let hooks: SuggestHooks | null = null;

/** テスト用: 音声書き出し・解析・エンジン呼び出しを差し替える（null で解除） */
export function __setSuggestHooks(next: SuggestHooks | null): void {
  hooks = next;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** 対象（素材 1 つ、またはタイムライン全体）とその長さ（秒） */
function resolveSource(
  project: Project,
  dir: string,
  assetId: string | undefined,
): { asset: Asset | null; path: string | null; duration: number } {
  const fps = project.settings.fps;
  if (assetId === undefined) {
    const total = timelineDurationF(project);
    if (!total)
      throw new MontashError("E_EMPTY_TIMELINE", "the timeline is empty", {
        hint: "Import the recording and place it (`montash import` + `montash clip add`), or pass --asset <id>.",
      });
    return { asset: null, path: null, duration: framesToSeconds(total, fps) };
  }
  const asset = project.assets[assetId];
  if (!asset)
    throw new MontashError("E_ASSET_NOT_FOUND", `asset "${assetId}" not found`, {
      hint: "Use `montash assets list --json` to see the imported assets.",
      detail: { asset: assetId },
    });
  if (asset.type !== "video" && asset.type !== "audio")
    throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${assetId}" is a ${asset.type} asset, not video/audio`, {
      hint: "Pass a video or audio asset, or omit --asset to analyze the timeline mix.",
      detail: { asset: assetId, type: asset.type },
    });
  return {
    asset,
    path: resolveAssetPath(dir, asset.path),
    duration: asset.duration_f == null ? 0 : framesToSeconds(asset.duration_f, fps),
  };
}

/** 候補に「そのまま打てる `clip add`」を添える（打つかどうかは人が決める） */
function clipAddCommand(candidate: HighlightCandidate, assetId: string | null, fps: Fps): string | null {
  if (assetId === null) return null;
  const tc = (s: number) => framesToTimecode(secondsToFrames(s, fps).frames, fps);
  return `montash clip add --asset ${assetId} --in ${tc(candidate.start)} --out ${tc(candidate.end)}`;
}

function describe(candidate: HighlightCandidate, assetId: string | null, fps: Fps) {
  const frames = (s: number) => secondsToFrames(s, fps).frames;
  return {
    rank: candidate.rank,
    selected: candidate.selected,
    start_s: candidate.start,
    end_s: candidate.end,
    duration_s: candidate.duration,
    start_f: frames(candidate.start),
    end_f: frames(candidate.end),
    start_tc: framesToTimecode(frames(candidate.start), fps),
    end_tc: framesToTimecode(frames(candidate.end), fps),
    score: candidate.score,
    speech_ratio: candidate.speech_ratio,
    lead: candidate.lead,
    keywords: candidate.keywords,
    evidence: candidate.evidence,
    command: clipAddCommand(candidate, assetId, fps),
  };
}

function humanLines(result: HighlightResult, assetId: string | null, fps: Fps, transcript: boolean): string {
  const mmss = (s: number) => {
    const total = Math.round(s);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  const lines = [
    `${result.candidates.length} candidate(s) from ${mmss(result.duration)} ` +
      `(signals: ${transcript ? "transcript + " : ""}silence)`,
  ];
  for (const c of result.candidates) {
    lines.push(
      `${c.selected ? "*" : " "} #${String(c.rank).padStart(2)}  ${mmss(c.start)}-${mmss(c.end)}  ` +
        `${String(Math.round(c.duration)).padStart(4)}s  score ${c.score.toFixed(2)}  ` +
        `speech ${(c.speech_ratio * 100).toFixed(0)}%`,
    );
    if (c.keywords.length > 0) lines.push(`        keywords: ${c.keywords.join(" / ")}`);
    if (c.lead !== "") lines.push(`        lead: ${c.lead}`);
    lines.push(
      `        why: pause ${c.evidence.lead_silence_s}s before, ${c.evidence.trail_silence_s}s after; ` +
        `lexical shift ${c.evidence.lexical_shift}${c.evidence.cue ? `; cue "${c.evidence.cue}"` : ""}; ` +
        `${c.evidence.chars_per_s} chars/s`,
    );
    const cmd = clipAddCommand(c, assetId, fps);
    if (cmd !== null) lines.push(`        ${cmd}`);
  }
  lines.push(
    `selected ${result.candidates.filter((c) => c.selected).length} candidate(s), ` +
      `${Math.round(result.selected_duration)}s total — montash does not place them; you decide.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// suggest highlights
// ---------------------------------------------------------------------------

export const suggestHighlightsCommand = defineCommand({
  path: "suggest highlights",
  summary: "propose cut candidates (start, end, evidence) from silence, the transcript and topic shifts",
  description:
    "Reads only: it never touches the timeline. Splits the recording into topical blocks using pauses, " +
    "vocabulary shifts and cue phrases, then reports each block with the evidence behind it " +
    "(pause length, lexical shift, speech ratio, distinctive terms, the opening sentence of the transcript). " +
    "No LLM is involved — `lead` is the transcript's own first sentence and `keywords` are tf-idf terms, " +
    "so the output is material for a decision, not the decision. You place what you pick with `clip add`.",
  workflows: ["W-23", "W-24"],
  mutates: false,
  options: {
    asset: { type: "string", describe: "analyze this video/audio asset (default: the timeline mix)" },
    max: { type: "string", describe: "total length to select, as a time (5:00); the rest is still listed", time: true },
    count: { type: "number", describe: "how many candidates to select (default: as many as fit --max)" },
    "min-length": {
      type: "string",
      describe: `shortest candidate (default ${HIGHLIGHT_DEFAULTS.minDuration}s)`,
      time: true,
    },
    "max-length": {
      type: "string",
      describe: `longest candidate; longer blocks get split (default ${HIGHLIGHT_DEFAULTS.maxDuration}s)`,
      time: true,
    },
    pause: {
      type: "number",
      describe: `pause that separates utterances, in seconds (default ${HIGHLIGHT_DEFAULTS.pause})`,
    },
    threshold: {
      type: "number",
      describe: `boundary score needed to cut, 0-1 (default ${HIGHLIGHT_DEFAULTS.threshold})`,
    },
    pad: { type: "number", describe: `padding around each candidate, in seconds (default ${HIGHLIGHT_DEFAULTS.pad})` },
    keywords: {
      type: "number",
      describe: `how many distinctive terms to report (default ${HIGHLIGHT_DEFAULTS.keywords})`,
    },
    transcribe: {
      type: "boolean",
      describe: "run the transcription engine (--no-transcribe uses silence only, no whisper needed)",
      default: true,
    },
    lang: { type: "string", describe: "spoken language (ISO 639-1, or `auto`)", default: "ja" },
    vocabulary: { type: "array", describe: 'proper nouns to bias the engine, comma separated ("多面観察,総括次長")' },
    ...TRANSCRIPT_OPTIONS,
    engine: { type: "string", describe: "engine executable name (default: whisper-cli, whisper-cpp, whisper)" },
    "engine-path": { type: "string", describe: "engine executable path (also MONTASH_TRANSCRIBER)" },
    model: { type: "string", describe: "model file (also MONTASH_TRANSCRIBER_MODEL)" },
    threads: { type: "number", describe: "engine threads" },
    timeout: { type: "number", describe: "abort the engine after N seconds" },
    "noise-db": { type: "number", describe: "silence threshold in dBFS (default -40)" },
    "min-silence": { type: "number", describe: "shortest silence to count, in seconds (default 0.3)" },
  },
  examples: [
    { cmd: "montash suggest highlights --asset rec --max 5:00 --json", note: "top candidates within 5 minutes" },
    {
      cmd: "montash suggest highlights --asset rec --no-transcribe",
      note: "silence only — no transcription engine needed, but no lead/keywords either",
    },
    {
      cmd: "montash suggest highlights --asset rec --min-length 45 --count 6",
      note: "fewer, longer blocks; then place the ones you want with `clip add`",
    },
    {
      cmd: 'montash suggest highlights --asset rec --from-transcript subs/rec.json --replace "フロント演動=フロントエンド運用"',
      note: "reuse the transcript written by `subtitle generate --save-transcript` (no engine run) and fix a misheard term",
    },
  ],
  async handler(ctx, args: Args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const fps = project.settings.fps;
    const assetId = optString(args, "asset");
    const source = resolveSource(project, dir, assetId);

    // --- 書き起こしの出どころ（エンジン / 保存済み）と置換規則（W-24） ---
    const warnings: Warning[] = [];
    const replaceFile = optString(args, "replace-file");
    const rules = await collectReplaceRules({
      replace: option(args, "replace"),
      replaceFile: replaceFile === undefined ? undefined : resolve(ctx.cwd, replaceFile),
    });
    const fromTranscriptOpt = optString(args, "from-transcript");
    const fromTranscript = fromTranscriptOpt === undefined ? undefined : resolve(ctx.cwd, fromTranscriptOpt);
    const saveTranscriptOpt = optString(args, "save-transcript");
    const saveTo = saveTranscriptOpt === undefined ? undefined : resolve(ctx.cwd, saveTranscriptOpt);
    // 保存済みを読むなら書き起こしはすでにある（エンジンは要らない。無音解析だけ走る）
    const saved = fromTranscript === undefined ? null : await loadTranscript(fromTranscript);
    const wantTranscript = saved !== null || option(args, "transcribe") !== false;
    const runEngine = saved === null && wantTranscript;
    // エンジンとモデルは何より先に確かめる（無ければ ffmpeg を走らせる前に終わる）
    const engine = runEngine
      ? requireTranscriber({
          enginePath: optString(args, "engine-path"),
          engine: optString(args, "engine"),
          env: ctx.env,
        })
      : null;
    const model = runEngine ? requireModel({ model: optString(args, "model"), env: ctx.env }) : (saved?.model ?? null);

    const lang = String(option(args, "lang") ?? "ja");
    const vocabulary = parseVocabulary(option(args, "vocabulary") as string | string[] | undefined);
    const options = {
      ...(optSeconds(args, "min-length", fps) !== undefined
        ? { minDuration: optSeconds(args, "min-length", fps) as number }
        : {}),
      ...(optSeconds(args, "max-length", fps) !== undefined
        ? { maxDuration: optSeconds(args, "max-length", fps) as number }
        : {}),
      ...(optNumber(args, "pause") !== undefined ? { pause: optNumber(args, "pause") as number } : {}),
      ...(optNumber(args, "threshold", false) !== undefined
        ? { threshold: optNumber(args, "threshold", false) as number }
        : {}),
      ...(optNumber(args, "pad", false) !== undefined ? { pad: optNumber(args, "pad", false) as number } : {}),
      ...(optNumber(args, "keywords") !== undefined ? { keywords: optNumber(args, "keywords") as number } : {}),
      ...(optSeconds(args, "max", fps) !== undefined ? { budget: optSeconds(args, "max", fps) as number } : {}),
      ...(optNumber(args, "count") !== undefined ? { count: optNumber(args, "count") as number } : {}),
    };

    if (ctx.globals.dryRun) {
      return {
        result: {
          dry_run: true,
          source: source.path ?? "timeline",
          asset: assetId ?? null,
          duration_s: source.duration,
          transcribe: wantTranscript,
          from_transcript: fromTranscript ?? null,
          engine: engine === null ? (saved?.engine ?? null) : { path: engine.path, source: engine.source },
          model,
          replacements: rules.map((r) => ({ ...r, count: null })),
          options,
        },
        human: `would analyze ${source.path ?? "the timeline mix"}${
          saved !== null
            ? ` and reuse ${saved.tokens.length} tokens from ${fromTranscript}`
            : wantTranscript
              ? ` and transcribe it with ${engine?.path}`
              : " (silence only)"
        }`,
      };
    }

    // --- 音声を 1 度だけ書き出し、無音解析と書き起こしの両方に使う ---
    const tmp = await mkdtemp(join(tmpdir(), "montash-suggest-"));
    let analysis: AudioAnalysis;
    let tokens: TranscriptToken[] = [];
    let transcribed: TranscribeResult | null = null;
    let extracted: ExtractAudioResult;
    try {
      const wav = join(tmp, "audio.wav");
      const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
      const log = ctx.globals.verbose ? (l: string) => ctx.stderr(`${l}\n`) : undefined;
      if (hooks?.extractAudio) {
        extracted = await hooks.extractAudio({ dir, project, output: wav, source: source.path });
      } else {
        extracted =
          source.path === null
            ? await extractTimelineAudio(bins, dir, project, wav, { cwd: dir, ...(log ? { log } : {}) })
            : await extractFileAudio(bins, source.path, wav, { cwd: dir, ...(log ? { log } : {}) });
      }
      const analyzeOpts = {
        ...(optNumber(args, "noise-db", false) !== undefined
          ? { noiseDb: optNumber(args, "noise-db", false) as number }
          : {}),
        ...(optNumber(args, "min-silence") !== undefined
          ? { minSilence: optNumber(args, "min-silence") as number }
          : {}),
      };
      analysis = hooks?.analyze
        ? await hooks.analyze({ audio: wav, duration: source.duration })
        : await analyzeAudioFile(bins, wav, source.duration || Number.POSITIVE_INFINITY, analyzeOpts);

      if (saved !== null) tokens = saved.tokens;
      if (runEngine) {
        const timeout = optNumber(args, "timeout");
        transcribed = hooks?.transcribe
          ? await hooks.transcribe({
              engine: (engine as { path: string }).path,
              model: model as string,
              audio: wav,
              outPrefix: join(tmp, "transcript"),
              lang: lang === "auto" ? undefined : lang,
              vocabulary,
            })
          : await runTranscriber({
              engine: (engine as { path: string }).path,
              model: model as string,
              audio: wav,
              outPrefix: join(tmp, "transcript"),
              ...(lang === "auto" ? {} : { lang }),
              vocabulary,
              ...(optNumber(args, "threads") !== undefined ? { threads: optNumber(args, "threads") as number } : {}),
              ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
              ...(log ? { log } : {}),
            });
        tokens = transcribed.tokens;
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }

    // --- 置換（人が書いた規則をそのまま当てる。lead / keywords が読めるようになる。W-24） ---
    const replaced = applyReplacements(tokens, rules);
    tokens = replaced.tokens;
    const unused = unusedRulesWarning(replaced.applied);
    if (unused !== null) warnings.push(unused);
    if (saveTo !== undefined && tokens.length > 0)
      await saveTranscript(saveTo, tokens, {
        engine: engine === null ? (saved?.engine ?? null) : { path: engine.path, source: engine.source },
        model,
        language: lang,
        vocabulary,
        source: source.path ?? "timeline",
        asset: assetId ?? null,
        replacements: replaced.applied,
      });

    // 素材の長さが分からないときは解析結果から埋める
    const duration = source.duration > 0 ? source.duration : (analysis.silence.at(-1)?.to ?? 0);

    // --- 検出（純関数） ---
    const found = suggestHighlights({ duration, tokens, silence: analysis.silence }, options);
    if (found.candidates.length === 0)
      throw new MontashError("E_NO_HIGHLIGHTS", "no speech found, so there is nothing to suggest", {
        hint: "Check that the timeline (or --asset) has audible speech (`montash audio analyze`), lower --min-length, or raise --noise-db.",
        exitCode: ExitCode.EXTERNAL,
        detail: { duration_s: duration, silence_spans: analysis.silence.length, tokens: tokens.length },
      });

    return {
      result: {
        source: source.path ?? "timeline",
        asset: assetId ?? null,
        duration_s: found.duration,
        fps: `${fps.num}/${fps.den}`,
        signals: found.signals,
        transcript:
          transcribed === null && saved === null
            ? null
            : {
                engine: engine === null ? (saved?.engine ?? null) : { path: engine.path, source: engine.source },
                model,
                language: lang,
                vocabulary,
                tokens: tokens.length,
                from_transcript: fromTranscript ?? null,
                saved_transcript: saveTo ?? null,
                replacements: replaced.applied,
                command: transcribed === null ? null : [(engine as { path: string }).path, ...transcribed.args],
              },
        ffmpeg_command: extracted.args,
        candidates: found.candidates.map((c) => describe(c, assetId ?? null, fps)),
        selected_count: found.candidates.filter((c) => c.selected).length,
        selected_duration_s: found.selected_duration,
        options: found.options,
        /** このコマンドはタイムラインを書き換えない。候補を採るかどうかは人が決める */
        applied: false,
      },
      head: await currentHead(dir),
      warnings,
      human: humanLines(found, assetId ?? null, fps, found.signals.transcript),
    };
  },
});
