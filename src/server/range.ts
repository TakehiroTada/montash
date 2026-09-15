/**
 * ローカルファイルの Range 配信（docs/06 §3.2）。
 *
 * `/api/assets/:id/file` と `/api/assets/:id/proxy.mp4` が共有する。
 * プレビュー（`preview.ts`）はマニフェスト由来の ETag を持つので独自実装のまま。
 */
import { lstat } from "node:fs/promises";
import { extname } from "node:path";

/** 拡張子 → Content-Type。表に無い拡張子は application/octet-stream（決して text/html にはしない） */
const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** ファイル名（またはパス）から Content-Type を決める */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export interface RangeOptions {
  /** 追加のレスポンスヘッダ */
  headers?: Record<string, string>;
  /** Content-Type の上書き（既定は拡張子から） */
  contentType?: string;
}

function notSatisfiable(headers: Record<string, string>, size: number): Response {
  return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
}

/**
 * ファイルを Range 対応で返す。通常ファイルでなければ（シンボリックリンク・ディレクトリ含む）null。
 * 呼び出し側が 404 の JSON を組み立てられるよう、見つからない場合は Response ではなく null を返す。
 */
export async function serveFileRange(path: string, req: Request, opts: RangeOptions = {}): Promise<Response | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;

  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? contentTypeOf(path),
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    // 原本が入れ替わっても取り違えないよう、サイズと mtime を弱い ETag にする
    etag: `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
    ...opts.headers,
  };
  if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });

  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  if (range && req.method !== "HEAD" && (!ifRange || ifRange === headers.etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) return notSatisfiable(headers, info.size);
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size)
      return notSatisfiable(headers, info.size);
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["content-length"] = String(end - start + 1);
  // 0 バイトファイルは slice すると空ボディになるので素直に null を返す
  const body = req.method === "HEAD" || info.size === 0 ? null : Bun.file(path).slice(start, end + 1);
  return new Response(body, { status, headers });
}
