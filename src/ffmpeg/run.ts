/**
 * ffmpeg / ffprobe の実行基盤（docs/08 §2 `ffmpeg/run.ts`, §4.1, docs/12 ADR-02, docs/13 B-1）。
 *
 * - `Bun.spawn` で配列引数のまま起動する（シェルは経由しない。docs/08 §4.5）
 * - `-progress pipe:1` を stdout から逐次読み、`progress=continue|end` 区切りのブロックを `onProgress` へ渡す
 * - stderr は行単位で読み、末尾 N 行をリングバッファに保持して失敗時の `detail.stderr_tail` にする
 * - キャンセル（AbortSignal）は SIGTERM → 猶予後 SIGKILL。タイムアウトも同じ経路で止める
 * - 非 0 終了は stderr の既知パターンから個別エラーコードへマップし、それ以外は `E_FFMPEG_FAILED`
 */
import { ExitCode, MontashError } from "../cli/errors.ts";
import type { Binaries } from "./locate.ts";

/** `-progress` の 1 ブロックを解釈した進捗 */
export interface Progress {
  /** 出力済みフレーム数（映像が無い場合は undefined） */
  frame?: number;
  /** 直近のエンコード fps */
  fps?: number;
  /** 出力位置（マイクロ秒） */
  out_time_us?: number;
  /** 出力位置（秒。out_time_us / 1e6） */
  out_time_s?: number;
  /** ffmpeg が報告する速度（例: "1.5x"） */
  speed?: string;
  /** 出力サイズ（バイト。`-f null` 等では N/A のため undefined） */
  total_size?: number;
  /** 0〜100。totalFrames / totalDurationS が与えられないときは null */
  percent?: number | null;
  /** 残り時間の推定（秒）。percent が無い／0 のときは null */
  eta_s?: number | null;
  /** ブロック末尾の progress= の値（"continue" | "end"） */
  status?: "continue" | "end";
}

export interface RunOptions {
  cwd?: string;
  /** 出力の総フレーム数（percent の算出に最優先で使う） */
  totalFrames?: number;
  /** 出力の総尺（秒）。totalFrames が無いときの percent 算出に使う */
  totalDurationS?: number;
  onProgress?: (p: Progress) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** ログ出力（コマンド行・所要時間など） */
  log?: (line: string) => void;
  /** 進捗の報告間隔（秒）。ffmpeg の `-stats_period`（既定 0.5 秒） */
  progressIntervalS?: number;
}

export interface RunResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string[];
  /** 実際に渡した引数（`-hide_banner -nostats -progress pipe:1` を含む。バイナリパスは含まない） */
  args: string[];
}

/** stderr 末尾として保持する行数 */
export const STDERR_TAIL_LINES = 30;
/** SIGTERM 後、SIGKILL へ切り替えるまでの猶予（ms） */
export const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// 進捗パース
// ---------------------------------------------------------------------------

export interface ProgressContext {
  totalFrames?: number;
  totalDurationS?: number;
  /** 開始からの経過時間（ms）。eta_s の推定に使う */
  elapsedMs?: number;
}

function parseNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === "" || t === "N/A") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `-progress` が出す `key=value` 行のブロックを Progress に変換する（純関数）。
 * ブロックは通常 `progress=continue` または `progress=end` で終わる。
 */
export function parseProgressBlock(lines: string[], ctx: ProgressContext = {}): Progress {
  const kv = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const p: Progress = {};
  const frame = parseNum(kv.get("frame"));
  if (frame !== undefined) p.frame = frame;
  const fps = parseNum(kv.get("fps"));
  if (fps !== undefined) p.fps = fps;
  // out_time_us が無い古いビルドでは out_time_ms（実際はマイクロ秒）で代替
  const outUs = parseNum(kv.get("out_time_us")) ?? parseNum(kv.get("out_time_ms"));
  if (outUs !== undefined) {
    p.out_time_us = outUs;
    p.out_time_s = outUs / 1e6;
  }
  const speed = kv.get("speed");
  if (speed !== undefined && speed !== "N/A" && speed !== "") p.speed = speed;
  const size = parseNum(kv.get("total_size"));
  if (size !== undefined) p.total_size = size;
  const status = kv.get("progress");
  if (status === "continue" || status === "end") p.status = status;

  // percent: totalFrames を優先、次に totalDurationS
  let percent: number | null = null;
  if (ctx.totalFrames !== undefined && ctx.totalFrames > 0 && p.frame !== undefined) {
    percent = (p.frame / ctx.totalFrames) * 100;
  } else if (ctx.totalDurationS !== undefined && ctx.totalDurationS > 0 && p.out_time_s !== undefined) {
    percent = (p.out_time_s / ctx.totalDurationS) * 100;
  }
  if (percent !== null) percent = Math.min(100, Math.max(0, percent));
  if (p.status === "end" && percent !== null) percent = 100;
  p.percent = percent;

  // eta: 経過時間と進捗率から線形に推定
  if (percent !== null && percent > 0 && ctx.elapsedMs !== undefined) {
    p.eta_s = p.status === "end" ? 0 : ((ctx.elapsedMs / 1000) * (100 - percent)) / percent;
  } else {
    p.eta_s = null;
  }
  return p;
}

// ---------------------------------------------------------------------------
// shell-quote（ログ／--dry-run 表示専用。実行はシェルを経由しない）
// ---------------------------------------------------------------------------

const SAFE_ARG = /^[A-Za-z0-9_\-./=:,+@%]+$/;

/** POSIX sh で安全に貼り付けられる形へ引用する。安全な文字だけの引数はそのまま */
export function shellQuote(args: string[]): string {
  return args
    .map((a) => {
      if (a === "") return "''";
      if (SAFE_ARG.test(a)) return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// stderr パターン → エラーコード
// ---------------------------------------------------------------------------

interface KnownPattern {
  re: RegExp;
  code: string;
  hint: string;
  exitCode?: ExitCode;
}

const KNOWN_PATTERNS: KnownPattern[] = [
  {
    re: /No such file or directory/i,
    code: "E_ASSET_MISSING",
    hint: "An input file does not exist. Check the path or run `montash assets relink`.",
    exitCode: ExitCode.IO,
  },
  {
    re: /No such filter|Unknown encoder|Unknown decoder|Encoder .* not found|Unrecognized option/i,
    code: "E_FFMPEG_FEATURE_MISSING",
    hint: "This ffmpeg build lacks a required filter/encoder. Run `montash doctor` and install a full build (scripts/install-deps.sh).",
  },
  {
    re: /Cannot find a valid font|Fontconfig|fontselect|font (?:file|provider|family).*not found|Glyph .* not found/i,
    code: "E_FONT_NOT_FOUND",
    hint: "A font could not be resolved. Run `montash fonts list` and pick an available family.",
  },
];

/** stderr 末尾から既知パターンを探し、該当するエラーコードを返す */
export function classifyFfmpegFailure(stderrTail: string[]): KnownPattern | undefined {
  const text = stderrTail.join("\n");
  return KNOWN_PATTERNS.find((p) => p.re.test(text));
}

// ---------------------------------------------------------------------------
// ストリーム読み取り
// ---------------------------------------------------------------------------

/** ReadableStream を行単位で読み切る（最後の改行無し行も渡す） */
async function readLines(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (text: string) => {
    buf += text;
    // ffmpeg の stderr は進捗行を \r で上書きするので \r も行区切りとして扱う
    for (;;) {
      const idx = buf.search(/\r\n|\n|\r/);
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf.startsWith("\r\n", idx) ? 2 : 1));
      onLine(line);
    }
  };
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  flush(decoder.decode());
  if (buf.length > 0) onLine(buf);
}

/** 末尾 N 行のリングバッファ */
class TailBuffer {
  private lines: string[] = [];
  constructor(private readonly max: number) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.shift();
  }
  toArray(): string[] {
    return [...this.lines];
  }
}

// ---------------------------------------------------------------------------
// ffmpeg 実行
// ---------------------------------------------------------------------------

/**
 * ffmpeg を実行し、進捗を逐次通知する。成功時（exit 0）のみ resolve。
 * 失敗は MontashError（E_FFMPEG_FAILED / E_ASSET_MISSING / E_FFMPEG_FEATURE_MISSING / E_FONT_NOT_FOUND /
 * E_FFMPEG_CANCELLED / E_FFMPEG_TIMEOUT）。
 */
export async function runFfmpeg(bins: Binaries, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const fullArgs = ["-hide_banner", "-nostats", "-progress", "pipe:1"];
  if (opts.progressIntervalS !== undefined) fullArgs.push("-stats_period", String(opts.progressIntervalS));
  fullArgs.push(...args);

  if (opts.signal?.aborted) {
    throw new MontashError("E_FFMPEG_CANCELLED", "ffmpeg was cancelled before start", {
      exitCode: ExitCode.INTERRUPTED,
      detail: { args: fullArgs },
    });
  }

  const t0 = performance.now();
  opts.log?.(`$ ${shellQuote([bins.ffmpeg, ...fullArgs])}`);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bins.ffmpeg, ...fullArgs], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new MontashError(
      "E_FFMPEG_NOT_FOUND",
      `failed to spawn ffmpeg at ${bins.ffmpeg}: ${e instanceof Error ? e.message : String(e)}`,
      {
        hint: "Run `montash doctor` to check the ffmpeg installation.",
        cause: e,
        detail: { args: fullArgs },
      },
    );
  }

  // --- 停止制御（キャンセル／タイムアウト） ---
  let stopReason: "cancel" | "timeout" | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "cancel" | "timeout") => {
    if (stopReason !== null || proc.exitCode !== null) return;
    stopReason = reason;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      // 猶予内に終わらなければ強制終了
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
  };
  const onAbort = () => terminate("cancel");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutTimer =
    opts.timeoutMs !== undefined ? setTimeout(() => terminate("timeout"), opts.timeoutMs) : undefined;

  // --- stdout: -progress ブロック ---
  const ctx: ProgressContext = { totalFrames: opts.totalFrames, totalDurationS: opts.totalDurationS };
  let block: string[] = [];
  let progressCount = 0;
  const stdoutDone = readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
    block.push(line);
    if (line.startsWith("progress=")) {
      const lines = block;
      block = [];
      progressCount++;
      if (opts.onProgress) {
        ctx.elapsedMs = performance.now() - t0;
        opts.onProgress(parseProgressBlock(lines, ctx));
      }
    }
  });

  // --- stderr: 末尾保持 + 逐次通知 ---
  const tail = new TailBuffer(STDERR_TAIL_LINES);
  const stderrDone = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
    if (line.trim() === "") return;
    tail.push(line);
    opts.onStderrLine?.(line);
  });

  let exitCode: number;
  try {
    exitCode = await proc.exited;
    await Promise.all([stdoutDone, stderrDone]);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  const durationMs = Math.round(performance.now() - t0);
  const stderrTail = tail.toArray();
  const result: RunResult = { exitCode, durationMs, stderrTail, args: fullArgs };
  opts.log?.(
    `ffmpeg exited ${exitCode} in ${durationMs}ms (${progressCount} progress blocks${proc.signalCode ? `, signal ${proc.signalCode}` : ""})`,
  );

  if (stopReason === "cancel") {
    throw new MontashError("E_FFMPEG_CANCELLED", `ffmpeg was cancelled after ${durationMs}ms`, {
      exitCode: ExitCode.INTERRUPTED,
      detail: { exit_code: exitCode, signal: proc.signalCode, args: fullArgs, stderr_tail: stderrTail },
    });
  }
  if (stopReason === "timeout") {
    throw new MontashError("E_FFMPEG_TIMEOUT", `ffmpeg did not finish within ${opts.timeoutMs}ms`, {
      hint: "Increase the timeout or check whether the input is a stream / infinite loop.",
      detail: { exit_code: exitCode, timeout_ms: opts.timeoutMs, args: fullArgs, stderr_tail: stderrTail },
    });
  }
  if (exitCode !== 0) {
    const detail = { exit_code: exitCode, args: fullArgs, stderr_tail: stderrTail };
    const known = classifyFfmpegFailure(stderrTail);
    const lastLine = stderrTail.at(-1) ?? "(no stderr)";
    if (known) {
      throw new MontashError(known.code, `ffmpeg failed (exit ${exitCode}): ${lastLine}`, {
        hint: known.hint,
        detail,
        exitCode: known.exitCode,
      });
    }
    throw new MontashError("E_FFMPEG_FAILED", `ffmpeg failed (exit ${exitCode}): ${lastLine}`, {
      hint: "See detail.stderr_tail for the ffmpeg error output.",
      detail,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// ffprobe 実行（JSON）
// ---------------------------------------------------------------------------

/**
 * ffprobe を実行して stdout を JSON として返す。`-of json` は呼び出し側が付ける。
 * 非 0 終了や JSON 解釈失敗は E_FFMPEG_FAILED（probe.ts が E_ASSET_UNREADABLE に包み直す）。
 */
export async function runFfprobeJson(
  bins: Binaries,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bins.ffprobe, ...args], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new MontashError(
      "E_FFMPEG_NOT_FOUND",
      `failed to spawn ffprobe at ${bins.ffprobe}: ${e instanceof Error ? e.message : String(e)}`,
      {
        hint: "Run `montash doctor` to check the ffmpeg installation.",
        cause: e,
      },
    );
  }
  const timer = opts.timeoutMs !== undefined ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : undefined;
  const tail = new TailBuffer(STDERR_TAIL_LINES);
  let exitCode: number;
  let stdout: string;
  try {
    [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      readLines(proc.stderr as ReadableStream<Uint8Array>, (l) => {
        if (l.trim() !== "") tail.push(l);
      }).then(() => proc.exited),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const stderrTail = tail.toArray();
  if (exitCode !== 0) {
    throw new MontashError(
      "E_FFMPEG_FAILED",
      `ffprobe failed (exit ${exitCode}): ${stderrTail.at(-1) ?? "(no stderr)"}`,
      {
        detail: { exit_code: exitCode, args, stderr_tail: stderrTail },
      },
    );
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch (e) {
    throw new MontashError("E_FFMPEG_FAILED", "ffprobe returned invalid JSON", {
      cause: e,
      detail: { exit_code: exitCode, args, stderr_tail: stderrTail, stdout_head: stdout.slice(0, 200) },
    });
  }
}
