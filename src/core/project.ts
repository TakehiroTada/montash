/**
 * `project.json` の生成・読み書き・ハッシュ・ディレクトリ初期化（docs/05 §1, §3, §13）。
 *
 * - 書き込みは tmp → rename の原子的更新（途中で落ちても壊れた project.json を残さない）。
 * - `hashProject()` はキーをソートした決定的 JSON の sha1（履歴 object の内容アドレスと共有する）。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ZodError } from "zod";
import { errors, MontashError } from "../cli/errors.ts";
import { type Fps, type Project, ProjectSchema, type Resolution, SCHEMA_VERSION } from "./schema.ts";

export const PROJECT_FILE = "project.json";
export const STATE_DIR = ".montash";

// ---------------------------------------------------------------------------
// 時間演算（暫定）
// TODO(core-time): src/core/time.ts に置換。parseFps / fpsLabel / framesToSeconds / framesToTc /
//   secondsToFrames は core/time.ts が正となる。ここでは init / project show に必要な最小限のみ。
// ---------------------------------------------------------------------------

/** fps プリセット（docs/05 §4） */
export const FPS_PRESETS: Readonly<Record<string, Fps>> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * fps 文字列を有理数にする。プリセット名（"29.97"）、分数（"30000/1001"）、整数（"48"）を受理。
 * TODO(core-time): src/core/time.ts に置換
 */
export function parseFps(input: string | number): Fps {
  const s = String(input).trim();
  const preset = FPS_PRESETS[s];
  if (preset) return { ...preset };
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const num = Number.parseInt(frac[1]!, 10);
    const den = Number.parseInt(frac[2]!, 10);
    if (num <= 0 || den <= 0) throw errors.usage(`invalid fps "${s}": numerator and denominator must be positive`, fpsHint());
    const g = gcd(num, den);
    return { num: num / g, den: den / g };
  }
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    if (n <= 0) throw errors.usage(`invalid fps "${s}"`, fpsHint());
    return { num: n, den: 1 };
  }
  throw errors.usage(`invalid fps "${s}"`, fpsHint());
}

function fpsHint(): string {
  return `Use a preset (${Object.keys(FPS_PRESETS).join(", ")}) or a fraction like 30000/1001.`;
}

/**
 * fps の表示用ラベル（"29.97" / "30" / "48"）。
 * TODO(core-time): src/core/time.ts に置換
 */
export function fpsLabel(fps: Fps): string {
  for (const [label, p] of Object.entries(FPS_PRESETS)) {
    if (p.num === fps.num && p.den === fps.den) return label;
  }
  const v = fps.num / fps.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
}

/** フレーム → 秒（表示用。docs/05 §2.1）。TODO(core-time): src/core/time.ts に置換 */
export function framesToSeconds(f: number, fps: Fps): number {
  return (f * fps.den) / fps.num;
}

/** 秒 → フレーム（`round(t * num / den)`）。TODO(core-time): src/core/time.ts に置換 */
export function secondsToFrames(t: number, fps: Fps): number {
  return Math.round((t * fps.num) / fps.den);
}

/** フレーム → "HH:MM:SS.mmm"（ミリ秒は `round(f * den * 1000 / num)`）。TODO(core-time): src/core/time.ts に置換 */
export function framesToTc(f: number, fps: Fps): string {
  const ms = Math.round((f * fps.den * 1000) / fps.num);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const mm = ms % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}.${p(mm, 3)}`;
}

/** "1920x1080" を解像度にする（偶数 px。yuv420p 制約） */
export function parseResolution(input: string): Resolution {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(input.trim());
  if (!m) throw errors.usage(`invalid resolution "${input}"`, "Use WIDTHxHEIGHT, e.g. 1920x1080 or 1080x1920.");
  const width = Number.parseInt(m[1]!, 10);
  const height = Number.parseInt(m[2]!, 10);
  if (width <= 0 || height <= 0) throw errors.usage(`invalid resolution "${input}"`, "Width and height must be positive.");
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw errors.usage(`resolution ${width}x${height} must be even (yuv420p)`, `Use ${width + (width % 2)}x${height + (height % 2)}.`);
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// パス
// ---------------------------------------------------------------------------

export interface ProjectPaths {
  root: string;
  projectFile: string;
  assetsDir: string;
  outDir: string;
  gitignore: string;
  stateDir: string;
  idsFile: string;
  historyDir: string;
  cacheDir: string;
  previewDir: string;
  renderDir: string;
  tmpDir: string;
  logsDir: string;
}

export function projectPaths(dir: string): ProjectPaths {
  const root = resolve(dir);
  const stateDir = join(root, STATE_DIR);
  return {
    root,
    projectFile: join(root, PROJECT_FILE),
    assetsDir: join(root, "assets"),
    outDir: join(root, "out"),
    gitignore: join(root, ".gitignore"),
    stateDir,
    idsFile: join(stateDir, "ids.json"),
    historyDir: join(stateDir, "history"),
    cacheDir: join(stateDir, "cache"),
    previewDir: join(stateDir, "preview"),
    renderDir: join(stateDir, "render"),
    tmpDir: join(stateDir, "tmp"),
    logsDir: join(stateDir, "logs"),
  };
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export interface CreateProjectOptions {
  name: string;
  fps: Fps;
  resolution: Resolution;
  sampleRate?: number;
  channels?: number;
  /** テスト用に時刻を固定する */
  now?: Date;
}

/** ISO 8601（秒精度、Z） */
export function isoNow(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 空のプロジェクト。既定トラック V1 / A1、画像の既定尺 5 秒（docs/04 §3 init） */
export function createProject(opts: CreateProjectOptions): Project {
  const now = isoNow(opts.now);
  const fps = { num: opts.fps.num, den: opts.fps.den };
  const input = {
    schema_version: SCHEMA_VERSION,
    name: opts.name,
    created_at: now,
    updated_at: now,
    settings: {
      fps,
      resolution: { width: opts.resolution.width, height: opts.resolution.height },
      sample_rate: opts.sampleRate ?? 48000,
      channels: opts.channels ?? 2,
      background: "#000000",
      default_image_duration_f: secondsToFrames(5, fps),
      default_font: "Noto Sans CJK JP",
      text_engine: "libass" as const,
      proxy: { height: 360, crf: 28 },
      preview: { auto_build: true, debounce_ms: 1500 },
    },
    assets: {},
    tracks: [
      { id: "V1", kind: "video" as const, name: "V1", muted: false, locked: false, fade: { in_f: 0, out_f: 0, color: "black" }, clips: [] },
      { id: "A1", kind: "audio" as const, name: "A1", muted: false, locked: false, fade: { in_f: 0, out_f: 0, color: "black" }, clips: [] },
    ],
    transitions: [],
    audio: { master_gain_db: 0, normalize: { enabled: true, i: -14, tp: -1, lra: 11 }, ducking: [], track_gain_db: {} },
    text_presets: {},
    render_presets: {},
    meta: { tags: [] },
  };
  // スキーマを通して既定値を確定させる（生成物が常にスキーマ準拠であることを保証）
  return ProjectSchema.parse(input);
}

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  path: string;
  message: string;
  code: string;
}

export function formatZodIssues(err: ZodError): SchemaIssue[] {
  return err.issues.map((i) => ({ path: "/" + i.path.map(String).join("/"), message: i.message, code: i.code }));
}

/** 任意の JSON 値を Project として検証する（E_PROJECT_INVALID / E_SCHEMA_TOO_NEW） */
export function parseProject(raw: unknown, source = PROJECT_FILE): Project {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MontashError("E_PROJECT_INVALID", `${source} must be a JSON object`, { detail: { source } });
  }
  const version = (raw as Record<string, unknown>).schema_version;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    throw new MontashError("E_SCHEMA_TOO_NEW", `${source} has schema_version ${version}; this montash supports up to ${SCHEMA_VERSION}`, {
      hint: "Upgrade montash to a newer version.",
      detail: { source, schema_version: version, supported: SCHEMA_VERSION },
    });
  }
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    const hint =
      typeof version === "number" && version < SCHEMA_VERSION
        ? `schema_version ${version} is older than ${SCHEMA_VERSION}; automatic migration is not implemented yet.`
        : "Fix the listed fields, or restore a snapshot with `montash checkout`.";
    throw new MontashError("E_PROJECT_INVALID", `${source} does not match schema v${SCHEMA_VERSION}: ${issues[0]?.path ?? ""} ${issues[0]?.message ?? ""}`.trim(), {
      hint,
      detail: { source, issues },
    });
  }
  return parsed.data;
}

export async function loadProject(dir: string): Promise<Project> {
  const paths = projectPaths(dir);
  let text: string;
  try {
    text = await readFile(paths.projectFile, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw errors.projectNotFound(paths.root);
    throw new MontashError("E_IO", `cannot read ${paths.projectFile}: ${String(e)}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MontashError("E_PROJECT_INVALID", `${paths.projectFile} is not valid JSON: ${(e as Error).message}`, {
      hint: "Fix the JSON syntax, or restore a snapshot with `montash checkout`.",
      detail: { source: paths.projectFile },
      cause: e,
    });
  }
  return parseProject(raw, paths.projectFile);
}

/** 2 スペース整形の JSON 文字列（末尾改行あり）。保存形式。 */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + "\n";
}

/** tmp に書いて rename する原子的書き込み */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new MontashError("E_IO", `cannot write ${path}: ${String(e)}`, { cause: e });
  }
}

/** `updated_at` を更新して保存する（引数の project も更新される） */
export async function saveProject(dir: string, project: Project, opts: { now?: Date } = {}): Promise<void> {
  const paths = projectPaths(dir);
  project.updated_at = isoNow(opts.now);
  await atomicWrite(paths.projectFile, serializeProject(project));
}

// ---------------------------------------------------------------------------
// ハッシュ
// ---------------------------------------------------------------------------

/** キーをソートした決定的 JSON（配列順は保持）。undefined のキーは省く（JSON.stringify と同じ） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** `"sha1:" + sha1(canonical JSON)`。履歴 object の内容アドレスと一致させる */
export function hashProject(project: Project): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(canonicalJson(project));
  return "sha1:" + h.digest("hex");
}

// ---------------------------------------------------------------------------
// ディレクトリ初期化（docs/05 §1）
// ---------------------------------------------------------------------------

export const GITIGNORE_CONTENT = ["# montash: regenerable state and render output", ".montash/cache/", ".montash/preview/", ".montash/tmp/", "out/", ""].join("\n");

/** ids.json の初期内容（カウンタは「次に発行する番号」。docs/05 §2.3） */
export const INITIAL_IDS = { counters: { c: 1, t: 1, x: 1, s: 1, d: 1 } } as const;

export interface InitProjectDirOptions {
  force?: boolean;
  now?: Date;
}

/**
 * プロジェクトディレクトリを作る。既に project.json があれば E_PROJECT_EXISTS（`force` で `.montash/` を捨てて再作成）。
 * `assets/` と `out/` の既存内容は force でも消さない。
 */
export async function initProjectDir(dir: string, project: Project, opts: InitProjectDirOptions = {}): Promise<ProjectPaths> {
  const paths = projectPaths(dir);
  if (existsSync(paths.projectFile)) {
    if (!opts.force) throw errors.projectExists(paths.root);
    await rm(paths.stateDir, { recursive: true, force: true });
  }
  for (const d of [paths.root, paths.assetsDir, paths.outDir, paths.stateDir, paths.historyDir, paths.cacheDir, paths.previewDir, paths.renderDir, paths.tmpDir, paths.logsDir]) {
    await mkdir(d, { recursive: true });
  }
  await atomicWrite(paths.idsFile, JSON.stringify(INITIAL_IDS, null, 2) + "\n");
  if (!existsSync(paths.gitignore)) await atomicWrite(paths.gitignore, GITIGNORE_CONTENT);
  await saveProject(paths.root, project, { now: opts.now });
  return paths;
}

/** ディレクトリ名からプロジェクト名の既定値 */
export function defaultProjectName(dir: string): string {
  const b = basename(resolve(dir));
  return b.length > 0 ? b : "project";
}
