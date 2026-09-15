/**
 * 書き起こしエンジンの探索と実行（docs/03 W-22, docs/04 §12）。
 *
 * **エンジン本体は montash に組み込まない。** ネットワークから何も取得しない方針（docs/14「やらないこと」）
 * と、モデルが数百 MB になるため。既定は whisper.cpp の `whisper-cli` を外部コマンドとして呼び、
 * `--output-json-full` が書く JSON からトークン単位のタイムスタンプを読む。
 * そこから「読める字幕」への整形は `core/subtitle-format.ts`（純関数）が行う。
 *
 * 実行の作法は `ffmpeg/run.ts` に合わせる: `Bun.spawn` で配列引数のまま起動し、シェルを経由しない。
 * stderr は末尾 N 行だけ保持して失敗時の `detail.stderr_tail` にする。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExitCode, MontashError } from "../cli/errors.ts";
import type { TranscriptToken } from "../core/subtitle-format.ts";
import { STDERR_TAIL_LINES, shellQuote } from "./run.ts";

/** モデルの置き場（ffmpeg の STATIC_FFMPEG_HOME と同じ考え方で montash 管理下に置く） */
export const TRANSCRIBER_HOME = join(homedir(), ".local", "share", "montash", "whisper");

/** 既定のエンジン（whisper.cpp）。ビルドによって名前が違うので順に探す */
export const TRANSCRIBER_CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper"] as const;

export const TRANSCRIBER_INSTALL_HINT =
  "Install whisper.cpp (macOS: `brew install whisper-cpp`, Linux: build https://github.com/ggml-org/whisper.cpp) " +
  "and pass --engine-path / set MONTASH_TRANSCRIBER. montash never downloads it for you (docs/14).";

export const MODEL_INSTALL_HINT =
  `Download a ggml model (e.g. ggml-large-v3-turbo.bin) and put it in ${TRANSCRIBER_HOME}/, ` +
  "or pass --model / set MONTASH_TRANSCRIBER_MODEL.";

export interface TranscriberLocation {
  /** 実行ファイルのパス */
  path: string;
  /** どこで見つけたか */
  source: "explicit" | "env" | "montash-home" | "path";
}

export interface LocateTranscriberOptions {
  /** `--engine-path`（最優先） */
  enginePath?: string | undefined;
  /** `--engine`（実行ファイル名。既定は TRANSCRIBER_CANDIDATES を順に） */
  engine?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** エンジンを探すディレクトリ（既定 TRANSCRIBER_HOME） */
  home?: string;
  /** PATH 探索（テストで差し替える） */
  which?: (name: string) => string | null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 書き起こしエンジンを探す。見つからなければ null（doctor はこれを使う）。
 *
 * 探索順: `--engine-path` → `MONTASH_TRANSCRIBER` → `~/.local/share/montash/whisper/bin`
 *       → PATH（whisper-cli → whisper-cpp → whisper）
 */
export function findTranscriber(opts: LocateTranscriberOptions = {}): TranscriberLocation | null {
  const env = opts.env ?? process.env;
  const which = opts.which ?? ((name: string) => Bun.which(name));
  const explicit = opts.enginePath;
  if (explicit) return isFile(explicit) ? { path: explicit, source: "explicit" } : null;
  const fromEnv = env.MONTASH_TRANSCRIBER;
  if (fromEnv) return isFile(fromEnv) ? { path: fromEnv, source: "env" } : null;
  const names = opts.engine ? [opts.engine] : [...TRANSCRIBER_CANDIDATES];
  const binDir = join(opts.home ?? TRANSCRIBER_HOME, "bin");
  for (const name of names) {
    const candidate = join(binDir, name);
    if (isFile(candidate)) return { path: candidate, source: "montash-home" };
  }
  for (const name of names) {
    const found = which(name);
    if (found) return { path: found, source: "path" };
  }
  return null;
}

/** 書き起こしエンジンを必ず得る。無ければ E_TRANSCRIBER_NOT_FOUND */
export function requireTranscriber(opts: LocateTranscriberOptions = {}): TranscriberLocation {
  const found = findTranscriber(opts);
  if (found) return found;
  const looked = opts.enginePath ?? (opts.env ?? process.env).MONTASH_TRANSCRIBER;
  return throwNotFound(looked, opts.engine, opts.home ?? TRANSCRIBER_HOME);
}

function throwNotFound(looked: string | undefined, engine: string | undefined, home: string): never {
  throw new MontashError(
    "E_TRANSCRIBER_NOT_FOUND",
    looked
      ? `transcription engine not found at ${looked}`
      : `transcription engine not found (looked for ${(engine ? [engine] : [...TRANSCRIBER_CANDIDATES]).join(", ")} in ${home}/bin and on PATH)`,
    {
      hint: TRANSCRIBER_INSTALL_HINT,
      exitCode: ExitCode.EXTERNAL,
      detail: {
        looked_for: engine ? [engine] : [...TRANSCRIBER_CANDIDATES],
        searched: [join(home, "bin"), "PATH"],
      },
    },
  );
}

export interface LocateModelOptions {
  /** `--model`（最優先） */
  model?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** モデルを探すディレクトリ（既定 TRANSCRIBER_HOME） */
  home?: string;
}

/** モデル（ggml-*.bin）を探す。見つからなければ null */
export function findModel(opts: LocateModelOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const explicit = opts.model ?? env.MONTASH_TRANSCRIBER_MODEL;
  if (explicit) return isFile(explicit) ? explicit : null;
  const home = opts.home ?? TRANSCRIBER_HOME;
  if (!existsSync(home)) return null;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return null;
  }
  // 名前順で最後のものを使う（large > medium > base > small ではないので、迷うなら --model を使う）
  const models = entries.filter((e) => e.endsWith(".bin")).sort();
  const pick = models.at(-1);
  return pick === undefined ? null : join(home, pick);
}

/** モデルを必ず得る。無ければ E_TRANSCRIBER_MODEL_NOT_FOUND */
export function requireModel(opts: LocateModelOptions = {}): string {
  const found = findModel(opts);
  if (found) return found;
  const explicit = opts.model ?? (opts.env ?? process.env).MONTASH_TRANSCRIBER_MODEL;
  throw new MontashError(
    "E_TRANSCRIBER_MODEL_NOT_FOUND",
    explicit
      ? `transcription model not found at ${explicit}`
      : `no transcription model (*.bin) found in ${opts.home ?? TRANSCRIBER_HOME}`,
    {
      hint: MODEL_INSTALL_HINT,
      exitCode: ExitCode.EXTERNAL,
      detail: { searched: opts.home ?? TRANSCRIBER_HOME },
    },
  );
}

// ---------------------------------------------------------------------------
// 引数の組み立て（純関数）
// ---------------------------------------------------------------------------

export interface TranscriberArgsOptions {
  model: string;
  /** 16kHz モノラルの wav */
  audio: string;
  /** `--output-file` に渡す接頭辞（`<prefix>.json` が書かれる） */
  outPrefix: string;
  /** ISO 639-1（`auto` で自動判定） */
  lang?: string | undefined;
  /**
   * 用語リスト（`--prompt`）。固有名詞を並べると認識精度が上がる。
   * 実地では「多面観察」「総括次長」のような語で結果が大きく変わった。
   */
  vocabulary?: readonly string[];
  threads?: number | undefined;
  /** 追加の引数（エンジン固有） */
  extra?: readonly string[];
}

/** whisper.cpp（whisper-cli）の引数を組み立てる（純関数） */
export function whisperArgs(opts: TranscriberArgsOptions): string[] {
  const args = [
    "--model",
    opts.model,
    "--file",
    opts.audio,
    "--output-json",
    "--output-json-full",
    "--output-file",
    opts.outPrefix,
    "--no-prints",
  ];
  if (opts.lang) args.push("--language", opts.lang);
  if (opts.threads !== undefined) args.push("--threads", String(opts.threads));
  const vocabulary = (opts.vocabulary ?? []).map((v) => v.trim()).filter((v) => v !== "");
  if (vocabulary.length > 0) args.push("--prompt", vocabulary.join("、"));
  if (opts.extra) args.push(...opts.extra);
  return args;
}

/** `--vocabulary "多面観察,総括次長"` / 複数指定 をひとつの語彙リストにする（純関数） */
export function parseVocabulary(input: string | readonly string[] | undefined): string[] {
  if (input === undefined) return [];
  const list = Array.isArray(input) ? input : [input as string];
  return list
    .flatMap((v) => String(v).split(/[,、\n]/))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

// ---------------------------------------------------------------------------
// 出力 JSON の解釈（純関数）
// ---------------------------------------------------------------------------

interface WhisperOffsets {
  from?: unknown;
  to?: unknown;
}

function offsetMs(offsets: unknown, key: "from" | "to"): number | null {
  if (typeof offsets !== "object" || offsets === null) return null;
  const v = (offsets as WhisperOffsets)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * whisper.cpp の `--output-json-full` をトークン列に変換する（純関数）。
 *
 * `transcription[].tokens[]` があればトークン単位、無ければセグメント単位で読む。
 * `offsets` はミリ秒。特殊トークン（`[_BEG_]` など）は整形側（cleanTokens）が落とす。
 */
export function parseWhisperJson(raw: unknown): TranscriptToken[] {
  if (typeof raw !== "object" || raw === null) return [];
  const segments = (raw as { transcription?: unknown }).transcription;
  if (!Array.isArray(segments)) return [];
  const out: TranscriptToken[] = [];
  for (const segment of segments) {
    if (typeof segment !== "object" || segment === null) continue;
    const seg = segment as { offsets?: unknown; text?: unknown; tokens?: unknown };
    const segStart = offsetMs(seg.offsets, "from");
    const segEnd = offsetMs(seg.offsets, "to");
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
    let pushed = 0;
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { offsets?: unknown; text?: unknown };
      if (typeof t.text !== "string") continue;
      const startMs = offsetMs(t.offsets, "from") ?? segStart;
      const endMs = offsetMs(t.offsets, "to") ?? segEnd;
      if (startMs === null || endMs === null) continue;
      out.push({ text: t.text, startMs, endMs });
      pushed++;
    }
    // トークンが取れないビルドではセグメント単位に落とす（整形の粒度は粗くなる）
    if (pushed === 0 && typeof seg.text === "string" && segStart !== null && segEnd !== null) {
      out.push({ text: seg.text, startMs: segStart, endMs: segEnd });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export interface TranscribeOptions extends TranscriberArgsOptions {
  /** エンジンの実行ファイル */
  engine: string;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface TranscribeResult {
  tokens: TranscriptToken[];
  /** 実際に渡した引数（エンジンのパスは含まない） */
  args: string[];
  durationMs: number;
  stderrTail: string[];
  /** エンジンが書いた JSON のパス */
  jsonPath: string;
}

/**
 * エンジンを起動して書き起こす。成功（exit 0 かつ JSON が読める）時のみ resolve。
 * 失敗は E_TRANSCRIBER_FAILED（`ffmpeg/run.ts` と同じく stderr 末尾を detail に載せる）。
 */
export async function runTranscriber(opts: TranscribeOptions): Promise<TranscribeResult> {
  const args = whisperArgs(opts);
  const t0 = performance.now();
  opts.log?.(`$ ${shellQuote([opts.engine, ...args])}`);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.engine, ...args], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new MontashError(
      "E_TRANSCRIBER_NOT_FOUND",
      `failed to spawn the transcription engine at ${opts.engine}: ${e instanceof Error ? e.message : String(e)}`,
      { hint: TRANSCRIBER_INSTALL_HINT, exitCode: ExitCode.EXTERNAL, cause: e, detail: { args } },
    );
  }

  let timedOut = false;
  const terminate = () => {
    timedOut = true;
    proc.kill("SIGTERM");
  };
  const onAbort = () => proc.kill("SIGTERM");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutMs !== undefined ? setTimeout(terminate, opts.timeoutMs) : undefined;

  const tail: string[] = [];
  const collect = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > STDERR_TAIL_LINES) tail.shift();
      opts.onStderrLine?.(line);
    }
  };

  let exitCode: number;
  try {
    // stdout には書き起こし本文が出る。読み捨てないとパイプが詰まるので読むだけ読む
    const [, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    collect(stderr);
    exitCode = code;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
  const durationMs = Math.round(performance.now() - t0);
  opts.log?.(`transcriber exited ${exitCode} in ${durationMs}ms`);

  if (opts.signal?.aborted)
    throw new MontashError("E_TRANSCRIBER_CANCELLED", `transcription was cancelled after ${durationMs}ms`, {
      exitCode: ExitCode.INTERRUPTED,
      detail: { args, stderr_tail: tail },
    });
  if (timedOut)
    throw new MontashError("E_TRANSCRIBER_TIMEOUT", `transcription did not finish within ${opts.timeoutMs}ms`, {
      hint: "Increase --timeout, use a smaller model, or transcribe a shorter range.",
      exitCode: ExitCode.EXTERNAL,
      detail: { args, stderr_tail: tail },
    });
  if (exitCode !== 0)
    throw new MontashError(
      "E_TRANSCRIBER_FAILED",
      `transcription engine failed (exit ${exitCode}): ${tail.at(-1) ?? "(no stderr)"}`,
      {
        hint: "See detail.stderr_tail. Check that the model matches the engine build and that the audio is 16kHz mono WAV.",
        exitCode: ExitCode.EXTERNAL,
        detail: { exit_code: exitCode, args, stderr_tail: tail },
      },
    );

  const jsonPath = `${opts.outPrefix}.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(jsonPath).text());
  } catch (e) {
    throw new MontashError("E_TRANSCRIBER_FAILED", `the engine did not write a readable JSON at ${jsonPath}`, {
      hint: "The engine must support whisper.cpp's --output-json-full (token level timestamps).",
      exitCode: ExitCode.EXTERNAL,
      cause: e,
      detail: { args, stderr_tail: tail, json_path: jsonPath },
    });
  }
  return { tokens: parseWhisperJson(raw), args, durationMs, stderrTail: tail, jsonPath };
}
