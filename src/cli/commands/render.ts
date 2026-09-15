/**
 * `montash render` とその派生（docs/04 §14, docs/07 §9, W-09 / W-11 / W-12）。
 *
 *   render               タイムライン全体を書き出す（`--preset` / `--reframe` / `--hwaccel` / `--two-pass` / `--last`）
 *   render verify        出力ファイルの厳密検証
 *   render presets       プリセット一覧（`project.render_presets` 込み）
 *   render batch         複数プリセットを一括で（`<project>_<preset>.<ext>`）
 *   render still|gif|audio  静止画 / GIF / 音声のみ
 *
 * `result.command` は配列（docs/04 §14）。人間向け表示だけ `shellQuote` で整形する。
 */
import { existsSync } from "node:fs";
import { link, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { timelineDurationF } from "../../core/assets.ts";
import { atomicWrite, loadProject, parseResolution, projectPaths } from "../../core/project.ts";
import type { Project } from "../../core/schema.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { type Binaries, locateBinaries, parseNames } from "../../ffmpeg/locate.ts";
import { type AudioPasses, describeLoudnorm, prepareAudio } from "../../ffmpeg/loudnorm.ts";
import {
  buildRenderPlan,
  HWACCEL_CHOICES,
  type HwaccelChoice,
  PRESET_NAMES,
  type PresetSpec,
  parseReframe,
  type RenderOptions,
  type RenderPlan,
  resolvePresets,
  verifyRender,
} from "../../ffmpeg/render.ts";
import { runFfmpeg, shellQuote } from "../../ffmpeg/run.ts";
import type { CommandContext } from "../context.ts";
import type { CommandResult } from "../define-command.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";

const SPEED_CHOICES = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

/** render / render batch / still / gif / audio で共通のエンコード系オプション */
const ENCODE_OPTIONS = {
  preset: { type: "string", describe: `encoding preset (default youtube-1080p; see \`render presets\`)` },
  resolution: { type: "string", describe: "override output WxH" },
  crf: { type: "number", describe: "H.264/H.265 quality (0..51)" },
  "preset-speed": { type: "string", describe: "x264/x265 encoding speed", choices: SPEED_CHOICES },
  vcodec: { type: "string", describe: "override the video encoder" },
  vbitrate: { type: "string", describe: "target video bitrate (8M); switches off CRF" },
  acodec: { type: "string", describe: "override the audio encoder" },
  abitrate: { type: "string", describe: "audio bitrate (192k)" },
  "pix-fmt": { type: "string", describe: "override the pixel format" },
  fps: { type: "number", describe: "output frame rate (re-times the output; verification is skipped)" },
  reframe: {
    type: "string",
    describe:
      "crop anchor when the output aspect differs from the timeline: center|left|right|<x>% (default: letterbox)",
  },
  hwaccel: { type: "string", describe: "hardware encoder", choices: HWACCEL_CHOICES },
  "two-pass": { type: "boolean", describe: "two-pass encoding (libx264/libx265 with --vbitrate)" },
  threads: { type: "number", describe: "encoder threads" },
  overwrite: { type: "boolean", describe: "replace an existing output after successful verification" },
  progress: { type: "string", describe: "progress output", choices: ["text", "jsonl", "none"], default: "text" },
} as const;

// ---------------------------------------------------------------------------
// 出力先の安全確認（プロジェクト・素材・.montash を壊さない）
// ---------------------------------------------------------------------------

/** 新しいディレクトリがシンボリックリンクの下にあることもあるので、存在する祖先まで解決する */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw e;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}

async function guardOutput(dir: string, project: Project, output: string, overwrite: boolean): Promise<void> {
  const canonicalOutput = await canonicalDestination(output);
  const protectedFiles = [
    projectPaths(dir).projectFile,
    ...Object.values(project.assets).map((a) => resolveAssetPath(dir, a.path)),
  ];
  const outputStat = await stat(output).catch(() => null);
  for (const path of protectedFiles) {
    const canonical = await realpath(path).catch(() => resolve(path));
    const sourceStat = outputStat ? await stat(path).catch(() => null) : null;
    if (
      canonical === canonicalOutput ||
      path === output ||
      (sourceStat && outputStat && sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino)
    )
      throw errors.usage("render output must not overwrite the project or a source asset");
  }
  for (const path of [projectPaths(dir).stateDir, projectPaths(dir).assetsDir]) {
    const rel = relative(await realpath(path).catch(() => path), canonicalOutput);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")))
      throw errors.usage("render output must be outside assets/ and .montash/");
  }
  if (existsSync(output) && !overwrite)
    throw new MontashError("E_OUTPUT_EXISTS", `output exists: ${output}`, {
      hint: "Choose a new output path or use --overwrite.",
    });
}

// ---------------------------------------------------------------------------
// オプションの解釈
// ---------------------------------------------------------------------------

/** `.montash/render/last.json` に残す値（`--last` で読み戻す） */
const LAST_KEYS = [
  "preset",
  "resolution",
  "crf",
  "presetSpeed",
  "vcodec",
  "vbitrate",
  "acodec",
  "abitrate",
  "pixFmt",
  "fps",
  "reframe",
  "hwaccel",
  "twoPass",
  "threads",
] as const;

type ArgRecord = Record<string, unknown>;

function pickLast(args: ArgRecord): ArgRecord {
  const out: ArgRecord = {};
  for (const key of LAST_KEYS) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

async function readLast(dir: string): Promise<{ args: ArgRecord; output?: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(projectPaths(dir).renderDir, "last.json"), "utf8")) as ArgRecord;
    // 旧形式（オプションを平らに持つ）も読めるようにする
    const args = (raw.args as ArgRecord | undefined) ?? pickLast(raw);
    return { args, ...(typeof raw.output === "string" ? { output: raw.output } : {}) };
  } catch {
    return null;
  }
}

/** `--last` を反映した引数（CLI で明示した値が優先） */
async function withLast(ctx: CommandContext, dir: string, args: ArgRecord): Promise<ArgRecord> {
  if (!args.last) return args;
  const last = await readLast(dir);
  if (!last)
    throw new MontashError("E_RENDER_NO_LAST", "no previous render options were found", {
      hint: "Run `montash render -o <path>` once; its options are stored in .montash/render/last.json.",
      detail: { path: join(projectPaths(dir).renderDir, "last.json") },
    });
  const merged: ArgRecord = { ...last.args };
  for (const [k, v] of Object.entries(args)) if (v !== undefined) merged[k] = v;
  if (merged.output === undefined && last.output !== undefined) merged.output = last.output;
  if (!ctx.globals.json && !ctx.globals.quiet)
    ctx.stderr(`using the previous render options: ${JSON.stringify(last.args)}\n`);
  return merged;
}

/** ffmpeg が持っているエンコーダ（`--hwaccel auto` の判定用。失敗したら空集合） */
async function availableEncoders(bins: Binaries): Promise<Set<string>> {
  try {
    const proc = Bun.spawn([bins.ffmpeg, "-hide_banner", "-encoders"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return parseNames(out + err);
  } catch {
    return new Set();
  }
}

interface BuildOptionsInput {
  args: ArgRecord;
  project: Project;
  bins: Binaries;
  /** プリセットを上書きする（still / gif / audio） */
  forcePreset?: string;
  range?: { from_f: number; to_f: number };
  /** レンダー前の音声パス（ダッキング解析・loudnorm 測定。docs/07 §8.3, §8.4） */
  audio?: AudioPasses;
}

async function toRenderOptions(input: BuildOptionsInput): Promise<RenderOptions> {
  const { args, project } = input;
  const presets = resolvePresets(project);
  const crf = args.crf === undefined ? undefined : Number(args.crf);
  if (crf !== undefined && (!Number.isFinite(crf) || crf < 0 || crf > 51))
    throw errors.usage("--crf must be between 0 and 51");
  const threads = args.threads === undefined ? undefined : Number(args.threads);
  if (threads !== undefined && (!Number.isSafeInteger(threads) || threads < 1))
    throw errors.usage("--threads must be a positive integer");
  const fps = args.fps === undefined ? undefined : Number(args.fps);
  if (fps !== undefined && (!Number.isFinite(fps) || fps <= 0)) throw errors.usage("--fps must be a positive number");
  const hwaccel = args.hwaccel === undefined ? undefined : (String(args.hwaccel) as HwaccelChoice);
  const encoders = hwaccel !== undefined && hwaccel !== "none" ? await availableEncoders(input.bins) : undefined;
  return {
    presets,
    // テキストエンジン（libass / drawtext）の検出に使う（docs/07 §6.1）
    bins: input.bins,
    ...(input.audio ? { audio: input.audio } : {}),
    preset: input.forcePreset ?? (args.preset === undefined ? "youtube-1080p" : String(args.preset)),
    ...(args.resolution ? { resolution: parseResolution(String(args.resolution)) } : {}),
    ...(crf !== undefined ? { crf } : {}),
    ...(args.presetSpeed ? { speed: String(args.presetSpeed) } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(args.reframe ? { reframe: parseReframe(String(args.reframe)) } : {}),
    ...(hwaccel !== undefined ? { hwaccel } : {}),
    ...(encoders !== undefined ? { encoders } : {}),
    ...(args.vcodec ? { vcodec: String(args.vcodec) } : {}),
    ...(args.vbitrate ? { vbitrate: String(args.vbitrate) } : {}),
    ...(args.acodec ? { acodec: String(args.acodec) } : {}),
    ...(args.abitrate ? { abitrate: String(args.abitrate) } : {}),
    ...(args.pixFmt ? { pixFmt: String(args.pixFmt) } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(args.twoPass ? { twoPass: true } : {}),
    ...(input.range ? { range: input.range } : {}),
  };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

interface ExecuteInput {
  ctx: CommandContext;
  dir: string;
  project: Project;
  bins: Binaries;
  output: string;
  plan: RenderPlan;
  overwrite: boolean;
  progress: string;
}

interface ExecuteResult {
  output: string;
  preset: string;
  duration_f: number;
  resolution: { width: number; height: number };
  /** `verifyRender` の結果（全尺の A/V レンダー以外は null） */
  verified: Record<string, unknown> | null;
  size: number;
}

/** 一時ファイルに書いて検証してから公開する（既存の render と同じ手順） */
async function executeRender(input: ExecuteInput): Promise<ExecuteResult> {
  const { ctx, bins, output, plan } = input;
  await mkdir(dirname(output), { recursive: true });
  const tmp = join(dirname(output), `.montash-render-${crypto.randomUUID()}${extname(output) || ".tmp"}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const onProgress = (p: {
      frame?: number;
      fps?: number;
      out_time_s?: number;
      percent?: number | null;
      eta_s?: number | null;
      speed?: string;
    }) => {
      if (input.progress === "jsonl")
        ctx.stdout(
          `${JSON.stringify({ frame: p.frame, fps: p.fps, time: p.out_time_s, percent: p.percent, eta: p.eta_s, speed: p.speed })}\n`,
        );
      else if (input.progress !== "none" && !ctx.globals.json && !ctx.globals.quiet)
        ctx.stderr(`\rrender ${p.percent?.toFixed(1) ?? "0"}%`);
    };
    if (plan.pass1_args) {
      await runFfmpeg(bins, ["-y", ...plan.pass1_args], {
        totalFrames: plan.duration_f,
        totalDurationS: plan.duration,
        signal: controller.signal,
        onProgress,
      });
    }
    await runFfmpeg(bins, ["-n", ...plan.args.slice(0, -1), tmp], {
      totalFrames: plan.duration_f,
      totalDurationS: plan.duration,
      signal: controller.signal,
      onProgress,
    });
    const verified = plan.verifiable ? await verifyRender(bins, tmp, input.project, plan.resolution) : null;
    if (controller.signal.aborted) throw new MontashError("E_FFMPEG_CANCELLED", "render cancelled", { exitCode: 130 });
    if (input.overwrite) await rename(tmp, output);
    else {
      // ハードリンクでの公開: 誰かが同時に output を作っていたら EEXIST で確実に失敗する
      try {
        await link(tmp, output);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new MontashError("E_OUTPUT_EXISTS", `output appeared during rendering: ${output}`);
        throw e;
      }
    }
    const size = (await stat(output)).size;
    return {
      output,
      preset: plan.preset,
      duration_f: plan.duration_f,
      resolution: plan.resolution,
      verified: verified ? { ...verified, output: { ...verified.output, path: output } } : null,
      size,
    };
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await rm(tmp, { force: true });
    await rm(`${output}.passlog-0.log`, { force: true });
    await rm(`${output}.passlog-0.log.mbtree`, { force: true });
    if (input.progress !== "none" && input.progress !== "jsonl" && !ctx.globals.json && !ctx.globals.quiet)
      ctx.stderr("\n");
  }
}

function commandArray(bins: Binaries, plan: RenderPlan, overwrite: boolean): string[] {
  return [bins.ffmpeg, overwrite ? "-y" : "-n", ...plan.args];
}

/**
 * 出力結果の JSON。`render verify` と同じ形（valid / expected_frames / actual_frames / output）を保ち、
 * 検証しない出力（still / gif / audio）では `valid: null` にする。
 */
function renderResult(
  done: ExecuteResult,
  command: string[],
  loudnorm: ReturnType<typeof describeLoudnorm> = null,
): Record<string, unknown> {
  const base = done.verified ?? {
    valid: null,
    expected_frames: done.duration_f,
    actual_frames: null,
    errors: [],
    output: { path: done.output, size: done.size },
  };
  return {
    ...base,
    preset: done.preset,
    duration_f: done.duration_f,
    resolution: done.resolution,
    size: done.size,
    path: done.output,
    loudnorm,
    command,
  };
}

/**
 * レンダー前の音声パス（docs/07 §8.3, §8.4）。`--simple` ダッキングの解析と loudnorm の測定を走らせる。
 * 映像だけの出力（still / gif）では音声を組み立てないので呼ばない。
 */
async function audioPasses(
  ctx: CommandContext,
  dir: string,
  project: Project,
  bins: Binaries,
): Promise<{ passes: AudioPasses; warnings: Warning[] }> {
  return prepareAudio(bins, project, {
    source: (asset) => resolveAssetPath(dir, asset.path),
    measure: !ctx.globals.dryRun,
  });
}

function planWarnings(plan: RenderPlan): Warning[] {
  const warnings = [...plan.warnings];
  if (!plan.verifiable)
    warnings.push(
      warning(
        "W_VERIFY_SKIPPED",
        "this output is not a full-length A/V render at the timeline fps, so the exact-frame verification is skipped",
        {
          hint: "Use `montash render verify <path>` on a full render to check frame counts.",
        },
      ),
    );
  return warnings;
}

// ---------------------------------------------------------------------------
// montash render
// ---------------------------------------------------------------------------

export const render = defineCommand({
  path: "render",
  summary: "render the timeline and verify the exact frame count",
  workflows: ["W-09", "W-11", "W-12"],
  options: {
    output: { type: "string", alias: "o", describe: "output path", required: true },
    ...ENCODE_OPTIONS,
    last: { type: "boolean", describe: "reuse the options of the previous render (.montash/render/last.json)" },
  },
  examples: [
    { cmd: "montash render -o out/final.mp4 --preset youtube-1080p" },
    { cmd: "montash render -o out/reel.mp4 --preset instagram-reel --reframe center" },
    { cmd: "montash render --last -o out/v2.mp4", note: "same settings as last time" },
  ],
  async handler(ctx, rawArgs) {
    const dir = ctx.requireProjectDir();
    const args = await withLast(ctx, dir, rawArgs as ArgRecord);
    const project = await loadProject(dir);
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    if (!args.output) throw errors.usage("missing -o <path>", "montash render -o <path> [--preset <name>]");
    const output = resolve(ctx.cwd, String(args.output));
    const overwrite = Boolean(args.overwrite);
    await guardOutput(dir, project, output, overwrite);
    const audio = await audioPasses(ctx, dir, project, bins);
    const options = await toRenderOptions({ args, project, bins, audio: audio.passes });
    const plan = await buildRenderPlan(project, dir, output, options);
    const loudnorm = describeLoudnorm(audio.passes.loudnorm, project);
    const command = commandArray(bins, plan, overwrite);
    const warnings = [...planWarnings(plan), ...audio.warnings];

    if (ctx.globals.dryRun)
      return {
        result: {
          dry_run: true,
          ...plan,
          loudnorm,
          command,
          ...(plan.pass1_args ? { pass1_command: [bins.ffmpeg, "-y", ...plan.pass1_args] } : {}),
        },
        warnings,
        human: shellQuote(command),
      };

    const done = await executeRender({
      ctx,
      dir,
      project,
      bins,
      output,
      plan,
      overwrite,
      progress: String(args.progress ?? "text"),
    });
    await atomicWrite(
      join(projectPaths(dir).renderDir, "last.json"),
      `${JSON.stringify({ args: pickLast(args), output, duration_f: plan.duration_f, rendered_at: new Date().toISOString() }, null, 2)}\n`,
    );
    return {
      result: renderResult(done, command, loudnorm),
      warnings,
      human: `rendered ${output} (${plan.duration_f} frames, ${plan.resolution.width}x${plan.resolution.height}, ${plan.preset}${plan.verifiable ? "; verified" : ""})`,
    };
  },
});

// ---------------------------------------------------------------------------
// montash render verify / presets
// ---------------------------------------------------------------------------

export const renderVerify = defineCommand({
  path: "render verify",
  summary: "verify frame count, FPS, audio duration and stream configuration",
  workflows: ["W-09"],
  positionals: [{ name: "path", describe: "rendered MP4", required: true }],
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const result = await verifyRender(
      locateBinaries({ ...ctx.globals, env: ctx.env }),
      resolve(ctx.cwd, String(args.path)),
      project,
    );
    return { result, human: `verified ${result.actual_frames} frames with audio: ${result.output.path}` };
  },
});

function presetRow(name: string, spec: PresetSpec) {
  return {
    name,
    source: spec.source ?? "builtin",
    ...(spec.base !== undefined ? { base: spec.base } : {}),
    format: spec.format,
    ext: spec.ext,
    resolution: spec.resolution ?? null,
    ...(spec.scaleWidth !== undefined ? { scale_width: spec.scaleWidth } : {}),
    ...(spec.fps !== undefined ? { fps: spec.fps } : {}),
    vcodec: spec.video?.codec ?? null,
    crf: spec.video?.crf ?? null,
    preset_speed: spec.video?.speed ?? null,
    vbitrate: spec.video?.bitrate ?? null,
    pix_fmt: spec.video?.pixFmt ?? null,
    acodec: spec.audio?.codec ?? null,
    abitrate: spec.audio?.bitrate ?? null,
    note: spec.note ?? "",
  };
}

export const renderPresets = defineCommand({
  path: "render presets",
  summary: "list the encoding presets (built-in and project.render_presets)",
  noProject: true,
  workflows: ["W-09", "W-12"],
  examples: [{ cmd: "montash render presets --json" }],
  async handler(ctx) {
    const dir = ctx.findProjectDir();
    const project = dir ? await loadProject(dir).catch(() => null) : null;
    const table = resolvePresets(project);
    const presets = Object.entries(table).map(([name, spec]) => presetRow(name, spec));
    const human = () =>
      presets
        .map(
          (p) =>
            `${p.name.padEnd(16)} ${p.source.padEnd(8)} ${(p.resolution ? `${p.resolution.width}x${p.resolution.height}` : "timeline").padEnd(10)} ${String(p.vcodec ?? "-").padEnd(18)} ${p.note}`,
        )
        .join("\n");
    return { result: { presets }, human };
  },
});

// ---------------------------------------------------------------------------
// montash render batch
// ---------------------------------------------------------------------------

/** `instagram-reel:--reframe=center,--crf=22` を { name, overrides } に分解する */
export function parseBatchPreset(spec: string): { name: string; overrides: ArgRecord } {
  const colon = spec.indexOf(":");
  if (colon === -1) return { name: spec.trim(), overrides: {} };
  const name = spec.slice(0, colon).trim();
  const overrides: ArgRecord = {};
  for (const token of spec
    .slice(colon + 1)
    .split(/[,\s]+/)
    .filter((t) => t !== "")) {
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(token);
    if (!m)
      throw errors.usage(
        `cannot parse preset option ${JSON.stringify(token)} in ${JSON.stringify(spec)}`,
        "Use --preset <name>[:--opt=value[,--opt2=value]], e.g. instagram-reel:--reframe=center.",
      );
    const key = (m[1] as string).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    overrides[key] = m[2] === undefined ? true : m[2];
  }
  return { name, overrides };
}

/** プロジェクト名をファイル名に使える形にする */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\w.-]/g, "");
  return slug === "" ? "project" : slug;
}

export const renderBatch = defineCommand({
  path: "render batch",
  summary: "render the same timeline with several presets into one directory",
  description:
    "Each output is named <project>_<preset><ext>. Per-preset options: --preset name:--opt=value[,--opt2=v].",
  workflows: ["W-12"],
  options: {
    preset: { type: "array", describe: "preset name, optionally with options (repeatable)", required: true },
    output: { type: "string", alias: "o", describe: "output directory", required: true },
    parallel: { type: "number", describe: "how many renders to run at once", default: 1 },
    overwrite: { type: "boolean", describe: "replace existing outputs" },
    progress: { type: "string", describe: "progress output", choices: ["text", "jsonl", "none"], default: "text" },
    "dry-run-each": { type: "boolean", describe: "only build the commands (same as --dry-run)", hidden: true },
  },
  examples: [
    { cmd: "montash render batch --preset youtube-1080p --preset web-preview -o out/" },
    { cmd: "montash render batch --preset instagram-reel:--reframe=center --preset web-preview -o out/" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    const raw = Array.isArray(args.preset) ? (args.preset as unknown[]).map(String) : [String(args.preset ?? "")];
    const specs = raw.filter((s) => s.trim() !== "").map(parseBatchPreset);
    if (specs.length === 0)
      throw errors.usage(
        "render batch needs at least one --preset",
        "montash render batch --preset web-preview -o out/",
      );
    if (!args.output) throw errors.usage("missing -o <dir>", "montash render batch --preset <name> -o <dir>");
    const outDir = resolve(ctx.cwd, String(args.output));
    const parallel = Math.max(1, Number(args.parallel ?? 1));
    if (!Number.isSafeInteger(parallel)) throw errors.usage("--parallel must be a positive integer");
    const overwrite = Boolean(args.overwrite);
    const table = resolvePresets(project);
    const slug = slugify(project.name);
    // 音声の事前パスはタイムライン単位なので 1 回だけ走らせ、すべてのジョブで使い回す
    const audio = await audioPasses(ctx, dir, project, bins);
    const loudnorm = describeLoudnorm(audio.passes.loudnorm, project);

    const jobs: Array<{ name: string; output: string; plan: RenderPlan; command: string[]; warnings: Warning[] }> = [];
    for (const spec of specs) {
      const preset = table[spec.name];
      if (!preset) throw errors.usage(`unknown render preset '${spec.name}' (see \`montash render presets\`)`);
      const output = join(outDir, `${slug}_${spec.name}${preset.ext}`);
      await guardOutput(dir, project, output, overwrite);
      const options = await toRenderOptions({
        args: { ...spec.overrides, preset: spec.name },
        project,
        bins,
        audio: audio.passes,
      });
      const plan = await buildRenderPlan(project, dir, output, options);
      jobs.push({
        name: spec.name,
        output,
        plan,
        command: commandArray(bins, plan, overwrite),
        warnings: planWarnings(plan),
      });
    }

    const warnings = [
      ...audio.warnings,
      ...jobs.flatMap((j) => j.warnings.map((w) => ({ ...w, message: `${j.name}: ${w.message}` }))),
    ];
    if (ctx.globals.dryRun) {
      return {
        result: {
          dry_run: true,
          dir: outDir,
          outputs: jobs.map((j) => ({
            preset: j.name,
            output: j.output,
            resolution: j.plan.resolution,
            duration_f: j.plan.duration_f,
            command: j.command,
          })),
        },
        warnings,
        human: jobs.map((j) => `${j.name}: ${shellQuote(j.command)}`).join("\n"),
      };
    }

    await mkdir(outDir, { recursive: true });
    const outputs: ExecuteResult[] = [];
    const queue = [...jobs];
    const progress = String(args.progress ?? "text");
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        outputs.push(
          await executeRender({ ctx, dir, project, bins, output: job.output, plan: job.plan, overwrite, progress }),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
    outputs.sort((a, b) => specs.findIndex((s) => s.name === a.preset) - specs.findIndex((s) => s.name === b.preset));
    return {
      result: { dir: outDir, count: outputs.length, loudnorm, outputs },
      warnings,
      human: outputs
        .map(
          (o) => `${o.preset.padEnd(16)} ${o.output} (${o.resolution.width}x${o.resolution.height}, ${o.size} bytes)`,
        )
        .join("\n"),
    };
  },
});

// ---------------------------------------------------------------------------
// montash render still / gif / audio
// ---------------------------------------------------------------------------

/** 時間表記をタイムライン上のフレームへ。`exclusive` なら末尾（= 全長）も許す */
function frameAt(project: Project, input: string, what: string, exclusive = false): number {
  const total = timelineDurationF(project);
  const max = exclusive ? total : total - 1;
  const parsed = parseTimeInput(input, project.settings.fps, { allowRelative: false });
  const frame = resolveAbsolute(parsed, { fps: project.settings.fps, end: total, timelineLength: total });
  if (frame < 0 || frame > max)
    throw new MontashError("E_USAGE", `${what} ${input} is outside the timeline (0..f:${max})`, {
      detail: { frame, timeline_f: total },
    });
  return frame;
}

/** 拡張子から既定のプリセットを決める（still: png/jpg, audio: wav/mp3） */
function presetForExtension(output: string, fallback: string, map: Record<string, string>): string {
  return map[extname(output).toLowerCase()] ?? fallback;
}

interface VariantInput {
  ctx: CommandContext;
  args: ArgRecord;
  presetName: string;
  range?: { from_f: number; to_f: number };
  extraPreset?: Partial<PresetSpec>;
  /** 音声を書き出す出力（`render audio`）だけ、ダッキング解析と loudnorm 測定を先に走らせる */
  withAudio?: boolean;
}

async function runVariant(input: VariantInput): Promise<CommandResult> {
  const { ctx, args } = input;
  const dir = ctx.requireProjectDir();
  const project = await loadProject(dir);
  const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
  const output = resolve(ctx.cwd, String(args.output));
  const overwrite = Boolean(args.overwrite);
  await guardOutput(dir, project, output, overwrite);
  const audio = input.withAudio ? await audioPasses(ctx, dir, project, bins) : null;
  const options = await toRenderOptions({
    args,
    project,
    bins,
    forcePreset: input.presetName,
    ...(input.range ? { range: input.range } : {}),
    ...(audio ? { audio: audio.passes } : {}),
  });
  if (input.extraPreset) {
    const table = { ...(options.presets as Record<string, PresetSpec>) };
    const base = table[input.presetName] as PresetSpec;
    table[input.presetName] = { ...base, ...input.extraPreset };
    options.presets = table;
  }
  const plan = await buildRenderPlan(project, dir, output, options);
  const loudnorm = audio ? describeLoudnorm(audio.passes.loudnorm, project) : null;
  const command = commandArray(bins, plan, overwrite);
  const warnings = [...planWarnings(plan), ...(audio?.warnings ?? [])];
  if (ctx.globals.dryRun)
    return { result: { dry_run: true, ...plan, loudnorm, command }, warnings, human: shellQuote(command) };
  const done = await executeRender({
    ctx,
    dir,
    project,
    bins,
    output,
    plan,
    overwrite,
    progress: String(args.progress ?? "none"),
  });
  return {
    result: renderResult(done, command, loudnorm),
    warnings,
    human: `wrote ${output} (${plan.duration_f} frame${plan.duration_f === 1 ? "" : "s"}, ${plan.preset})`,
  };
}

export const renderStill = defineCommand({
  path: "render still",
  summary: "write one frame of the timeline as a PNG/JPEG",
  workflows: ["W-09"],
  options: {
    output: { type: "string", alias: "o", describe: "output image path (.png / .jpg)", required: true },
    at: {
      type: "string",
      describe: "timeline position (12.5 / 00:00:12.500 / f:375 / end-1)",
      time: true,
      default: "0",
    },
    resolution: { type: "string", describe: "override output WxH" },
    reframe: { type: "string", describe: "crop anchor: center|left|right|<x>%" },
    overwrite: { type: "boolean", describe: "replace an existing file" },
  },
  examples: [{ cmd: "montash render still --at 00:00:03.000 -o out/thumb.png" }],
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const at = frameAt(project, String(args.at ?? "0"), "--at");
    const output = resolve(ctx.cwd, String(args.output));
    const ext = extname(output).toLowerCase();
    const jpeg = ext === ".jpg" || ext === ".jpeg";
    return runVariant({
      ctx,
      args: args as ArgRecord,
      presetName: "thumbnail",
      range: { from_f: at, to_f: at + 1 },
      extraPreset: jpeg
        ? { ext: ".jpg", video: { codec: "mjpeg", frames: 1, pixFmt: "yuvj420p", extra: ["-q:v", "2"] } }
        : { ext: ".png" },
    });
  },
});

export const renderGif = defineCommand({
  path: "render gif",
  summary: "write a range of the timeline as an animated GIF (palettegen/paletteuse)",
  workflows: ["W-09"],
  options: {
    output: { type: "string", alias: "o", describe: "output .gif path", required: true },
    from: { type: "string", describe: "range start (default 0)", time: true },
    to: { type: "string", describe: "range end, exclusive (default: end of timeline)", time: true },
    resolution: { type: "string", describe: "override output WxH" },
    fps: { type: "number", describe: "GIF frame rate (default 15)" },
    reframe: { type: "string", describe: "crop anchor: center|left|right|<x>%" },
    overwrite: { type: "boolean", describe: "replace an existing file" },
    progress: { type: "string", describe: "progress output", choices: ["text", "jsonl", "none"], default: "none" },
  },
  examples: [{ cmd: "montash render gif --from 2 --to 4 -o out/loop.gif" }],
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const total = timelineDurationF(project);
    const from = args.from === undefined ? 0 : frameAt(project, String(args.from), "--from");
    const to = args.to === undefined ? total : frameAt(project, String(args.to), "--to", true);
    if (to <= from) throw errors.usage(`--to must be after --from (got f:${from}..f:${to})`);
    return runVariant({ ctx, args: args as ArgRecord, presetName: "gif", range: { from_f: from, to_f: to } });
  },
});

export const renderAudio = defineCommand({
  path: "render audio",
  summary: "write the mixed audio of the timeline (no video)",
  workflows: ["W-09"],
  options: {
    output: { type: "string", alias: "o", describe: "output .wav / .mp3 / .m4a path", required: true },
    acodec: { type: "string", describe: "override the audio encoder" },
    abitrate: { type: "string", describe: "audio bitrate (192k)" },
    overwrite: { type: "boolean", describe: "replace an existing file" },
    progress: { type: "string", describe: "progress output", choices: ["text", "jsonl", "none"], default: "none" },
  },
  examples: [{ cmd: "montash render audio -o out/mix.wav" }],
  async handler(ctx, args) {
    const output = resolve(ctx.cwd, String(args.output));
    const preset = presetForExtension(output, "audio-only-mp3", { ".mp3": "audio-only-mp3" });
    const ext = extname(output).toLowerCase();
    const extraPreset: Partial<PresetSpec> | undefined =
      ext === ".wav"
        ? { format: "wav", ext: ".wav", audio: { codec: "pcm_s16le" } }
        : ext === ".m4a"
          ? { format: "ipod", ext: ".m4a", audio: { codec: "aac", bitrate: "192k" } }
          : undefined;
    return runVariant({
      ctx,
      args: args as ArgRecord,
      presetName: preset,
      withAudio: true,
      ...(extraPreset ? { extraPreset } : {}),
    });
  },
});
