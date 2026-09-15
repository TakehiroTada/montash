/**
 * 素材 API（docs/06 §3.2, §3.3, W-17）。
 *
 * - `GET /api/assets`            一覧 + `usage`（参照クリップ）+ `missing` + `derived` 状態
 * - `GET /api/assets/:id`        詳細（probe 要約、usage、テキスト素材は本文）
 * - `GET /api/assets/:id/file`   原本の Range 配信（プロジェクト外でも `project.json` に登録済みなら可）
 * - `GET /api/assets/:id/proxy.mp4` `.montash/cache/<id>/proxy.mp4` の Range 配信
 * - `POST /api/upload`           multipart 保存（`assets/incoming/<YYYYMMDD>/`）→ `import <path> --proxy`
 *
 * 状態変更は必ず CLI（`POST /api/cli`）を通す（docs/06 §1.1）。このモジュールは
 * 読み取りと「ファイルを置くところまで」だけを担当し、素材の登録は CLI に委ねる。
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { assetUsage } from "../core/assets.ts";
import { loadProject, projectPaths } from "../core/project.ts";
import type { Asset, Project } from "../core/schema.ts";
import { resolveAssetPath } from "../core/validate.ts";
import { assetCacheDir, proxyEligible, proxyState } from "../ffmpeg/proxy.ts";
import { serveFileRange } from "./range.ts";

/** docs/13 A-5: `req.formData()` はメモリに載るので上限を 2GB に下げ、それ以上はパス指定 import を案内する */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** アップロードしたファイルの置き場所（プロジェクト相対） */
export const INCOMING_DIR = join("assets", "incoming");

// ---------------------------------------------------------------------------
// 一覧・詳細
// ---------------------------------------------------------------------------

export interface AssetUsageClip {
  clip_id: string;
  track: string;
  start_f: number;
  end_f: number;
}

export interface AssetView extends Record<string, unknown> {
  id: string;
  type: Asset["type"];
  /** `project.json` の値（相対なら相対のまま） */
  path: string;
  /** 解決後の絶対パス */
  abs_path: string;
  /** 原本が見つからない（docs/04 §1.7 E_ASSET_MISSING 相当の表示用フラグ） */
  missing: boolean;
  usage: { clips: AssetUsageClip[] };
  /** `project.json` の `derived` に、実ファイルから求めた proxy 状態を重ねたもの */
  derived: Record<string, { state: string; path?: string; built_at?: string }>;
  /** 映像・音声のみ。それ以外は null */
  proxy: "ready" | "building" | "missing" | "stale" | null;
  /** プロキシが配信可能か（`/api/assets/:id/proxy.mp4`） */
  has_proxy: boolean;
}

/** ID がパスやプロトタイプ汚染に使われないことを保証する（`assetCacheDir` と同じ規則） */
export function isSafeAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(id) && !Object.hasOwn(Object.prototype, id);
}

/**
 * 配信してよい原本の絶対パス。
 * 絶対パスの素材（外部メディア）はそのまま許すが、相対パスが `..` でプロジェクト外へ抜けるものは拒否する。
 */
export function resolveServablePath(dir: string, assetPath: string): string | null {
  if (assetPath.includes("\0")) return null;
  const root = resolve(dir);
  if (isAbsolute(assetPath)) return resolve(assetPath);
  const abs = resolve(root, assetPath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

async function proxyStateOf(dir: string, asset: Asset, project: Project): Promise<AssetView["proxy"]> {
  if (!proxyEligible(asset)) return null;
  // 宣言されている「生成中」は project.json 側が正（ファイルはまだ無い）
  if (asset.derived?.proxy?.state === "building") return "building";
  try {
    return await proxyState(dir, asset, project);
  } catch {
    // 原本が消えているとフィンガープリントが取れない
    return existsSync(join(assetCacheDir(dir, asset.id), "proxy.mp4")) ? "stale" : "missing";
  }
}

/** 1 素材の一覧向けビュー */
export async function assetView(dir: string, project: Project, asset: Asset): Promise<AssetView> {
  const abs = resolveServablePath(dir, asset.path) ?? resolveAssetPath(dir, asset.path);
  const proxy = await proxyStateOf(dir, asset, project);
  const derived: AssetView["derived"] = { ...(asset.derived ?? {}) };
  if (proxy !== null) derived.proxy = { ...(derived.proxy ?? {}), state: proxy };
  return {
    ...asset,
    abs_path: abs,
    missing: !existsSync(abs),
    usage: {
      clips: assetUsage(project, asset.id).clips.map((c) => ({
        clip_id: c.id,
        track: c.track,
        start_f: c.start_f,
        end_f: c.end_f,
      })),
    },
    derived,
    proxy,
    has_proxy: proxy !== null && existsSync(join(assetCacheDir(dir, asset.id), "proxy.mp4")),
  };
}

/** 全素材の一覧（`project.json` のキー順） */
export async function assetViews(dir: string, project: Project): Promise<AssetView[]> {
  return Promise.all(Object.values(project.assets).map((a) => assetView(dir, project, a)));
}

/** 字幕の先頭プレビューに読む最大バイト数 */
const SUBTITLE_PREVIEW_BYTES = 4096;

export interface AssetDetail {
  asset: AssetView;
  /** ffprobe の要約（`.montash/cache/<id>/probe.json` があればそれも） */
  probe?: unknown;
  /** テキスト素材の本文 / 字幕の先頭 */
  text?: string;
  /** text が本文全体ではなく先頭のみか */
  text_truncated?: boolean;
}

export async function assetDetail(dir: string, project: Project, asset: Asset): Promise<AssetDetail> {
  const view = await assetView(dir, project, asset);
  const detail: AssetDetail = { asset: view };
  if (!view.missing && (asset.type === "text" || asset.type === "subtitle")) {
    try {
      const file = Bun.file(view.abs_path);
      if (asset.type === "text") {
        detail.text = await file.text();
      } else {
        const head = await file.slice(0, SUBTITLE_PREVIEW_BYTES).text();
        detail.text = head;
        detail.text_truncated = file.size > SUBTITLE_PREVIEW_BYTES;
      }
    } catch {
      /* 読めない本文は返さない（一覧の missing / E_ASSET_UNREADABLE で十分） */
    }
  }
  try {
    const probe = join(assetCacheDir(dir, asset.id), "probe.json");
    if (existsSync(probe)) detail.probe = await Bun.file(probe).json();
  } catch {
    /* 壊れた probe.json は無視する（再生成は `proxy build` / import 側の仕事） */
  }
  return detail;
}

// ---------------------------------------------------------------------------
// assets.changed の差分（docs/06 §3.4）
// ---------------------------------------------------------------------------

export interface AssetsDiff {
  added: string[];
  removed: string[];
  updated: string[];
}

/** 素材ごとの内容指紋。キーの増減と値の変化で added / removed / updated を判定する */
export function assetsSnapshot(
  project: { assets?: Record<string, unknown> } | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, asset] of Object.entries(project?.assets ?? {})) out[id] = JSON.stringify(asset);
  return out;
}

export function diffAssets(prev: Record<string, string>, next: Record<string, string>): AssetsDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const id of Object.keys(next)) {
    if (!Object.hasOwn(prev, id)) added.push(id);
    else if (prev[id] !== next[id]) updated.push(id);
  }
  for (const id of Object.keys(prev)) if (!Object.hasOwn(next, id)) removed.push(id);
  return { added: added.sort(), removed: removed.sort(), updated: updated.sort() };
}

export function hasAssetChanges(diff: AssetsDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.updated.length > 0;
}

// ---------------------------------------------------------------------------
// アップロード（docs/06 §3.3）
// ---------------------------------------------------------------------------

/** `YYYYMMDD`（ローカル時刻） */
export function uploadDayDir(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/**
 * アップロードされたファイル名を安全な 1 セグメントにする。
 * `../` や絶対パス、制御文字、Windows で使えない文字を落とし、空になったら `upload`。
 */
export function sanitizeUploadName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/").split("/").pop() ?? "");
  const cleaned = base
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字こそ落とす対象
    .replace(/[ -]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[\s]+$/, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "upload";
  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  return `${stem.slice(0, 160) || "upload"}${ext.slice(0, 20)}`;
}

/** 同名があれば `name-1.ext`, `name-2.ext` … と連番を振る */
export function uniqueUploadPath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${stem}-${n}${ext}`);
  return candidate;
}

export interface SavedUpload {
  /** 保存した絶対パス */
  path: string;
  /** プロジェクトルートからの相対パス */
  relative: string;
  size: number;
  original_name: string;
}

/** multipart のファイルを `assets/incoming/<YYYYMMDD>/` に保存する（登録は import に任せる） */
export async function saveUpload(dir: string, file: File, now: Date = new Date()): Promise<SavedUpload> {
  const target = join(projectPaths(dir).root, INCOMING_DIR, uploadDayDir(now));
  await mkdir(target, { recursive: true });
  const path = uniqueUploadPath(target, sanitizeUploadName(file.name));
  await Bun.write(path, file);
  return {
    path,
    relative: relative(projectPaths(dir).root, path),
    size: file.size,
    original_name: file.name,
  };
}

// ---------------------------------------------------------------------------
// HTTP ハンドラ
// ---------------------------------------------------------------------------

export interface AssetsHttpDeps {
  projectDir: string;
  json(body: unknown, status?: number, headers?: Record<string, string>): Response;
  jsonError(status: number, code: string, message: string, hint?: string): Response;
}

/** `project.json` を読む。読めなければ返すべき Response を返す */
async function loadOr(deps: AssetsHttpDeps): Promise<Project | Response> {
  try {
    return await loadProject(deps.projectDir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "E_PROJECT_NOT_FOUND") return deps.jsonError(404, "E_PROJECT_NOT_FOUND", "project.json not found");
    return deps.jsonError(500, code ?? "E_IO", `cannot read project.json: ${(e as Error).message}`);
  }
}

/** `GET /api/assets` */
export async function handleAssetList(deps: AssetsHttpDeps): Promise<Response> {
  const project = await loadOr(deps);
  if (project instanceof Response) return project;
  return deps.json({ assets: await assetViews(deps.projectDir, project) });
}

function lookup(deps: AssetsHttpDeps, project: Project, id: string): Asset | Response {
  if (!isSafeAssetId(id)) return deps.jsonError(400, "E_USAGE", `unsafe asset id: ${id}`);
  const asset = Object.hasOwn(project.assets, id) ? project.assets[id] : undefined;
  if (!asset)
    return deps.jsonError(
      404,
      "E_ASSET_NOT_FOUND",
      `asset "${id}" not found`,
      "Use GET /api/assets to list the known asset IDs.",
    );
  return asset;
}

/** `GET /api/assets/:id` */
export async function handleAssetShow(deps: AssetsHttpDeps, id: string): Promise<Response> {
  const project = await loadOr(deps);
  if (project instanceof Response) return project;
  const asset = lookup(deps, project, id);
  if (asset instanceof Response) return asset;
  return deps.json(await assetDetail(deps.projectDir, project, asset));
}

/** `GET /api/assets/:id/file` — 原本（Range 対応） */
export async function handleAssetFile(deps: AssetsHttpDeps, id: string, req: Request): Promise<Response> {
  const project = await loadOr(deps);
  if (project instanceof Response) return project;
  const asset = lookup(deps, project, id);
  if (asset instanceof Response) return asset;
  const path = resolveServablePath(deps.projectDir, asset.path);
  if (path === null)
    return deps.jsonError(
      403,
      "E_PATH_OUTSIDE_PROJECT",
      `asset "${id}" has a path that escapes the project directory`,
      `Re-link the asset with an absolute path: \`montash assets relink ${id} --path <p>\`.`,
    );
  const res = await serveFileRange(path, req);
  return (
    res ??
    deps.jsonError(404, "E_ASSET_MISSING", `no file at ${path}`, `Run \`montash assets relink ${id} --path <p>\`.`)
  );
}

/** `GET /api/assets/:id/proxy.mp4` — プロキシ（無ければ 404） */
export async function handleAssetProxy(deps: AssetsHttpDeps, id: string, req: Request): Promise<Response> {
  if (!isSafeAssetId(id)) return deps.jsonError(400, "E_USAGE", `unsafe asset id: ${id}`);
  const path = join(assetCacheDir(deps.projectDir, id), "proxy.mp4");
  const res = await serveFileRange(path, req, { contentType: "video/mp4" });
  return (
    res ??
    deps.jsonError(
      404,
      "E_NOT_FOUND",
      `no proxy for asset "${id}"`,
      `Run \`montash proxy build ${id}\` (the web UI can issue it via POST /api/cli).`,
    )
  );
}
