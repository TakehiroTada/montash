/**
 * Assets タブの純関数（docs/06 §2.6）。フィルタ・検索・並び替え・表示整形・CLI 例の生成。
 * DOM も React も触らないので tests/unit/web/assets-*.test.ts からそのまま呼べる。
 */

export type AssetType = "video" | "audio" | "image" | "text" | "subtitle";
export type AssetTypeFilter = "all" | AssetType;
export type AssetSort = "name" | "duration" | "imported";
export type ProxyState = "ready" | "building" | "missing" | "stale" | null;

export interface AssetUsageClip {
  clip_id: string;
  track: string;
  start_f: number;
  end_f: number;
}

export interface StreamInfo {
  codec?: string;
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  sample_rate?: number;
  channels?: number;
}

/** `GET /api/assets` の 1 要素（サーバの AssetView と同じ形。未知フィールドは保持する） */
export interface AssetView {
  id: string;
  type: AssetType;
  path: string;
  abs_path?: string;
  label?: string;
  note?: string;
  color?: string;
  tags: string[];
  owned?: boolean;
  size?: number;
  imported_at?: string;
  imported_by?: string;
  duration_s?: number | null;
  duration_f?: number | null;
  format?: string;
  text_preview?: string;
  line_count?: number;
  video?: StreamInfo;
  audio?: StreamInfo | null;
  missing: boolean;
  usage: { clips: AssetUsageClip[] };
  derived?: Record<string, { state: string }>;
  proxy: ProxyState;
  has_proxy?: boolean;
  [k: string]: unknown;
}

export const ASSET_TYPES: readonly AssetTypeFilter[] = ["all", "video", "audio", "image", "text", "subtitle"];

export const TYPE_LABELS: Record<AssetTypeFilter, string> = {
  all: "All",
  video: "Video",
  audio: "Audio",
  image: "Image",
  text: "Text",
  subtitle: "Sub",
};

/** 一覧の種別アイコン（docs/06 §2.6 の図） */
export function typeIcon(type: AssetType): string {
  switch (type) {
    case "video":
      return "▣";
    case "audio":
      return "♪";
    case "image":
      return "▤";
    case "text":
      return "T";
    case "subtitle":
      return "≡";
  }
}

/** パスのファイル名部分（Windows 区切りも見る） */
export function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** 検索対象は ID・ラベル・タグ・ファイル名（docs/06 §2.6） */
export function matchesQuery(asset: AssetView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [asset.id, asset.label ?? "", ...asset.tags, fileName(asset.path)].join(" ").toLowerCase();
  // 空白区切りの AND 検索
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export interface AssetFilter {
  type?: AssetTypeFilter;
  query?: string;
  /** true なら未使用素材のみ */
  unusedOnly?: boolean;
  /** true なら欠落素材のみ */
  missingOnly?: boolean;
}

export function filterAssets(assets: readonly AssetView[], filter: AssetFilter): AssetView[] {
  return assets.filter(
    (a) =>
      (!filter.type || filter.type === "all" || a.type === filter.type) &&
      (!filter.unusedOnly || a.usage.clips.length === 0) &&
      (!filter.missingOnly || a.missing) &&
      matchesQuery(a, filter.query ?? ""),
  );
}

/** 表示名（ラベルがあればラベル、無ければ ID） */
export function displayName(asset: AssetView): string {
  return asset.label && asset.label !== "" ? asset.label : asset.id;
}

/**
 * 並び替え。
 * - `name`     表示名 → ID（ロケール比較）
 * - `duration` 尺の長い順（尺を持たない画像・テキストは末尾）
 * - `imported` 取込日の新しい順（不明は末尾）
 */
export function sortAssets(assets: readonly AssetView[], sort: AssetSort): AssetView[] {
  const byId = (a: AssetView, b: AssetView) => a.id.localeCompare(b.id);
  const copy = [...assets];
  if (sort === "name") return copy.sort((a, b) => displayName(a).localeCompare(displayName(b)) || byId(a, b));
  if (sort === "duration") return copy.sort((a, b) => (b.duration_f ?? -1) - (a.duration_f ?? -1) || byId(a, b));
  return copy.sort((a, b) => (b.imported_at ?? "").localeCompare(a.imported_at ?? "") || byId(a, b));
}

// ---------------------------------------------------------------------------
// 表示整形
// ---------------------------------------------------------------------------

/** 使用箇所を `c1 (V1), c2 (V2)` に整形する。未使用は空文字 */
export function formatUsage(clips: readonly AssetUsageClip[], limit = 4): string {
  if (clips.length === 0) return "";
  const shown = clips.slice(0, limit).map((c) => `${c.clip_id} (${c.track})`);
  return clips.length > limit ? `${shown.join(", ")} 他 ${clips.length - limit} 件` : shown.join(", ");
}

/** 尺。60 秒未満は `14.2s`、それ以上は `3:12`。尺を持たない素材は `—` */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatFps(fps: { num: number; den: number } | undefined): string {
  if (!fps || fps.den === 0) return "";
  const value = fps.num / fps.den;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 解像度 / チャンネル数などの 1 行サマリー */
export function formatSpec(asset: AssetView): string {
  const parts: string[] = [];
  if (asset.video?.width && asset.video.height) parts.push(`${asset.video.width}x${asset.video.height}`);
  const fps = formatFps(asset.video?.fps);
  if (fps && asset.type === "video") parts.push(fps);
  if (asset.audio?.channels) parts.push(asset.audio.channels === 1 ? "mono" : `${asset.audio.channels}ch`);
  if (asset.audio?.sample_rate) parts.push(`${Math.round(asset.audio.sample_rate / 1000)}k`);
  if (asset.type === "text" && asset.line_count !== undefined) parts.push(`${asset.line_count} 行`);
  if (asset.type === "subtitle" && asset.format) parts.push(asset.format);
  return parts.join(" ");
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** プロキシ状態の表示文字列（対象外は空） */
export function formatProxy(asset: AssetView): string {
  switch (asset.proxy) {
    case "ready":
      return "▶ proxy ready";
    case "building":
      return "⟳ proxy building";
    case "stale":
      return "⚠ proxy stale";
    case "missing":
      return "· proxy なし";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 単体プレビュー（docs/06 §2.6）
// ---------------------------------------------------------------------------

export type PreviewKind = "video" | "audio" | "image" | "text" | "none";

export interface PreviewSource {
  kind: PreviewKind;
  /** `<video>` / `<audio>` / `<img>` に渡す URL。text / none は null */
  src: string | null;
  /** プロキシではなく原本を再生しているか（UI の注記用） */
  original: boolean;
}

/**
 * 単体プレビューの参照先。動画・音声はプロキシがあればそれを、無ければ原本を使う。
 * 欠落素材は none。
 */
export function previewSource(asset: AssetView): PreviewSource {
  if (asset.missing) return { kind: "none", src: null, original: false };
  const file = `/api/assets/${encodeURIComponent(asset.id)}/file`;
  const proxy = `/api/assets/${encodeURIComponent(asset.id)}/proxy.mp4`;
  switch (asset.type) {
    case "video":
      return asset.has_proxy
        ? { kind: "video", src: proxy, original: false }
        : { kind: "video", src: file, original: true };
    case "audio":
      return asset.has_proxy
        ? { kind: "audio", src: proxy, original: false }
        : { kind: "audio", src: file, original: true };
    case "image":
      return { kind: "image", src: file, original: true };
    default:
      return { kind: "text", src: null, original: true };
  }
}

// ---------------------------------------------------------------------------
// CLI コマンド（docs/06 §1.1, §3.6）
// ---------------------------------------------------------------------------

/** 引数配列を `montash a b "c d"` の表示用文字列にする */
export function formatCommand(args: readonly string[]): string {
  return `montash ${args.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
}

/**
 * 「タイムラインへ追加」で見せる CLI 例（docs/06 §3.6 の「アセット」行）。
 * Web はこれを **実行しない**。コピーして AI／CLI に渡してもらう。
 */
export function timelineExamples(asset: AssetView, playheadF: number): string[] {
  const at = `f:${Math.max(0, Math.floor(playheadF))}`;
  switch (asset.type) {
    case "video":
    case "audio":
      return [
        formatCommand(["clip", "add", "--asset", asset.id, "--at", at]),
        formatCommand(["clip", "add", "--asset", asset.id, "--at", at, "--in", "f:0", "--duration", "f:90"]),
      ];
    case "image":
      return [
        formatCommand(["clip", "add", "--asset", asset.id, "--at", at, "--duration", "f:150"]),
        formatCommand([
          "overlay",
          "add",
          "--asset",
          asset.id,
          "--track",
          "V2",
          "--at",
          at,
          "--duration",
          "5",
          "--position",
          "top-right",
        ]),
      ];
    case "text":
      return [
        formatCommand(["text", "add", "--asset", asset.id, "--at", at, "--duration", "3"]),
        formatCommand(["text", "add", "--asset", asset.id, "--at", at, "--duration", "3", "--preset", "title-center"]),
      ];
    case "subtitle":
      return [formatCommand(["subtitle", "add", "--asset", asset.id, "--at", at])];
  }
}

export interface MetadataEdit {
  label?: string;
  /** カンマ区切りの入力そのまま（空文字ならタグを全消し） */
  tags?: string;
  color?: string;
}

/** `assets set` の引数。変更が無ければ null（空振りの op を作らない） */
export function assetsSetArgs(id: string, edit: MetadataEdit, current: AssetView): string[] | null {
  const args = ["assets", "set", id];
  if (edit.label !== undefined && edit.label !== (current.label ?? "")) args.push("--label", edit.label);
  if (edit.tags !== undefined && normalizeTags(edit.tags) !== current.tags.join(",")) args.push("--tags", edit.tags);
  if (edit.color !== undefined && edit.color !== (current.color ?? "")) args.push("--color", edit.color);
  return args.length > 3 ? args : null;
}

/** `--tags a, b ,a` → `a,b`（CLI の toTagList と同じ規則） */
export function normalizeTags(input: string): string {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out.join(",");
}

/** 取り込み（パス指定）の引数。glob もそのまま CLI に渡す */
export function importArgs(path: string, proxy = true): string[] {
  return proxy ? ["import", path.trim(), "--proxy"] : ["import", path.trim()];
}

export function newTextArgs(id: string, text: string, label?: string): string[] {
  const args = ["assets", "new-text", id.trim(), "--text", text];
  if (label && label.trim() !== "") args.push("--label", label.trim());
  return args;
}

export function setTextArgs(id: string, text: string): string[] {
  return ["assets", "set-text", id, "--text", text];
}

export function removeArgs(id: string, force: boolean): string[] {
  return force ? ["assets", "remove", id, "--force"] : ["assets", "remove", id];
}

export function relinkArgs(id: string, by: { path?: string; search?: string }): string[] {
  if (by.path !== undefined) return ["assets", "relink", id, "--path", by.path.trim()];
  return ["assets", "relink", id, "--search", (by.search ?? "").trim()];
}

export function proxyBuildArgs(id: string): string[] {
  return ["proxy", "build", id, "--force"];
}

/** `assets new-text` に渡せる ID か（CLI の assetCacheDir と同じ規則） */
export function isValidAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}
