/**
 * システムフォントの列挙（docs/04 §4 `fonts list`, W-06）。
 *
 * - `fc-list : family style file` が使えればそれを使う（fontconfig が正）。
 * - 無ければ OS 別の標準ディレクトリを再帰走査し、ファイル名からファミリー／スタイルを推測する。
 * - CJK 判定はファミリー名のパターンによる暫定判定（charset の検査は未実装。docs/04 §4）。
 */
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export interface FontEntry {
  family: string;
  style: string;
  path: string;
  /** 日本語を含む可能性が高いか（ファミリー名による暫定判定） */
  cjk: boolean;
}

export interface ListFontsResult {
  /** 列挙に使った手段 */
  source: "fc-list" | "scan";
  fonts: FontEntry[];
}

/** フォントファイルとして扱う拡張子 */
const FONT_EXTENSIONS = new Set(["ttf", "ttc", "otf", "otc", "dfont", "pfb"]);
/** 走査するディレクトリの深さ上限（フォントディレクトリは浅い） */
const MAX_SCAN_DEPTH = 6;
/** fc-list のタイムアウト（ms） */
const FC_LIST_TIMEOUT_MS = 5000;

/**
 * CJK（日本語）対応とみなすファミリー名のパターン。
 * charset を読まずに名前だけで判定する暫定版のため、`Century Gothic` のような誤検出はあり得る。
 */
export const CJK_FAMILY_PATTERN =
  /CJK|JP|Gothic|Mincho|Hiragino|Yu |YuGothic|Meiryo|Noto Sans JP|IPA|Takao|Source Han/i;
/** ファミリー名自体が日本語・中国語（かな・漢字）で書かれていれば CJK とみなす */
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

export function isCjkFamily(family: string): boolean {
  return CJK_FAMILY_PATTERN.test(family) || CJK_CHAR_PATTERN.test(family);
}

/** カンマ区切りの多言語名から表示に使う 1 つを選ぶ（ffmpeg/libass に渡せる ASCII 名を優先） */
export function preferredName(value: string): { name: string; aliases: string[] } {
  const aliases: string[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name !== "" && !aliases.includes(name)) aliases.push(name);
  }
  const ascii = aliases.find((a) => /^[\x20-\x7e]+$/.test(a));
  return { name: ascii ?? aliases[0] ?? "", aliases };
}

/** ファイル名からファミリーとスタイルを推測する（fc-list が無い場合のフォールバック） */
export function familyFromFilename(path: string): { family: string; style: string } {
  const base = basename(path);
  const stem = extname(base) ? base.slice(0, -extname(base).length) : base;
  const m =
    /^(.*?)[-_ ]((?:Extra|Semi|Ultra|Demi)?(?:Bold|Light|Black|Condensed)?(?:Italic|Oblique|Regular|Thin|Medium|Book|Heavy)?)$/.exec(
      stem,
    );
  if (m?.[1] && m[2]) return { family: m[1].replace(/[-_]/g, " ").trim(), style: m[2] };
  return { family: stem.replace(/[-_]/g, " ").trim(), style: "Regular" };
}

/**
 * `fc-list : family style file` の 1 行を解釈する。
 * fontconfig の版によって `<path>: <family>:style=<styles>` と
 * `<family>:style=<styles>:file=<path>` のどちらもあり得るため両方受ける。
 */
export interface FcListEntry {
  family: string;
  style: string;
  path: string;
  /** 同じフォントの別名（多言語名。CJK 判定に使う） */
  aliases: string[];
}

export function parseFcListLine(line: string): FcListEntry | null {
  const text = line.trim();
  if (text === "") return null;
  let rest = text;
  let path = "";
  const fileAt = rest.lastIndexOf(":file=");
  if (fileAt >= 0) {
    path = rest.slice(fileAt + ":file=".length).trim();
    rest = rest.slice(0, fileAt);
  }
  let style = "";
  const styleAt = rest.lastIndexOf(":style=");
  if (styleAt >= 0) {
    style = preferredName(rest.slice(styleAt + ":style=".length)).name;
    rest = rest.slice(0, styleAt);
  }
  let families = { name: "", aliases: [] as string[] };
  if (path === "") {
    // "<path>: <family>" 形式。パスに ": " が含まれることはまず無い
    const sep = rest.lastIndexOf(": ");
    if (sep < 0) return null;
    path = rest.slice(0, sep).trim();
    families = preferredName(rest.slice(sep + 2));
  } else {
    families = preferredName(rest);
  }
  if (path === "") return null;
  const family = families.name === "" ? familyFromFilename(path).family : families.name;
  return {
    family,
    style: style === "" ? familyFromFilename(path).style : style,
    path,
    aliases: families.aliases.length > 0 ? families.aliases : [family],
  };
}

/** OS 別のフォントディレクトリ（docs/04 §4） */
export function fontDirectories(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")];
  }
  if (platform === "win32") return ["C:\\Windows\\Fonts"];
  const dirs = [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    join(home, ".fonts"),
    join(home, ".local", "share", "fonts"),
  ];
  // WSL では Windows 側のフォントも使える
  if (existsSync("/mnt/c/Windows/Fonts")) dirs.push("/mnt/c/Windows/Fonts");
  return dirs;
}

async function scanDir(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    // シンボリックリンクのディレクトリは辿らない（循環と重複を避ける）
    if (entry.isDirectory()) await scanDir(child, out, depth + 1);
    else if (entry.isFile() && FONT_EXTENSIONS.has(extname(entry.name).slice(1).toLowerCase())) out.push(child);
  }
}

async function runFcList(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const proc = Bun.spawn(["fc-list", ":", "family", "style", "file"], {
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    const timer = setTimeout(() => proc.kill(), FC_LIST_TIMEOUT_MS);
    try {
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 && text.trim() !== "" ? text : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** family の部分一致（大文字小文字を無視） */
export function filterFonts(fonts: readonly FontEntry[], filter?: string): FontEntry[] {
  if (filter === undefined || filter === "") return [...fonts];
  const needle = filter.toLowerCase();
  return fonts.filter((f) => f.family.toLowerCase().includes(needle));
}

function finalize(entries: FcListEntry[]): FontEntry[] {
  const seen = new Set<string>();
  const fonts: FontEntry[] = [];
  for (const e of entries) {
    // fontconfig の内部フォント（先頭がドット）は表示しない
    if (e.family.startsWith(".")) continue;
    const key = `${e.family}\u0000${e.style}\u0000${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push({ family: e.family, style: e.style, path: e.path, cjk: e.aliases.some(isCjkFamily) });
  }
  fonts.sort(
    (a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style) || a.path.localeCompare(b.path),
  );
  return fonts;
}

export interface ListFontsOptions {
  /** family の部分一致フィルタ */
  filter?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** fc-list を使わずディレクトリ走査だけを行う（テスト用） */
  scanOnly?: boolean;
}

/** システムのフォントを列挙する */
export async function listFonts(opts: ListFontsOptions = {}): Promise<ListFontsResult> {
  const text = opts.scanOnly ? null : await runFcList(opts.env ?? process.env);
  if (text !== null) {
    const entries = text
      .split("\n")
      .map(parseFcListLine)
      .filter((e): e is FcListEntry => e !== null);
    if (entries.length > 0) return { source: "fc-list", fonts: filterFonts(finalize(entries), opts.filter) };
  }
  const files: string[] = [];
  for (const dir of fontDirectories(opts.platform, opts.home)) await scanDir(dir, files);
  const entries: FcListEntry[] = files.map((path) => {
    const { family, style } = familyFromFilename(path);
    return { family, style, path, aliases: [family] };
  });
  return { source: "scan", fonts: filterFonts(finalize(entries), opts.filter) };
}
