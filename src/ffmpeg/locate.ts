/**
 * ffmpeg / ffprobe のバイナリ探索と機能検出（docs/04 doctor, docs/12 ADR-15）。
 *
 * 探索順: 明示パス（--ffmpeg-path / MONTASH_FFMPEG）
 *       → ~/.local/share/montash/ffmpeg/bin（install-deps.sh が static ビルド／brew ffmpeg-full をここに置く。montash 管理）
 *       → PATH
 *       → Homebrew の keg-only ffmpeg-full（/opt/homebrew/opt/ffmpeg-full/bin, /usr/local/opt/ffmpeg-full/bin）
 * 判定はバージョンではなく「必須機能の有無」。4.4 未満は outdated、6.0 未満は best effort。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errors, MontashError } from "../cli/errors.ts";

export const STATIC_FFMPEG_HOME = join(homedir(), ".local", "share", "montash", "ffmpeg");
export const MIN_FFMPEG = "4.4";
export const RECOMMENDED_FFMPEG = "6.0";

/** 必須（無いと render 不可） */
export const REQUIRED_ENCODERS = ["libx264", "aac"] as const;
export const REQUIRED_FILTERS = ["xfade", "concat", "overlay", "loudnorm", "sidechaincompress", "fps", "trim", "adelay", "amix"] as const;
/** 推奨（無いと機能制限） */
export const RECOMMENDED_FILTERS = ["subtitles", "drawtext"] as const;
/** 任意（あれば使う） */
export const OPTIONAL_ENCODERS = ["libx265", "h264_videotoolbox", "hevc_videotoolbox", "h264_nvenc", "h264_vaapi", "h264_qsv", "prores_ks", "libmp3lame", "libopus"] as const;

export interface Binaries {
  ffmpeg: string;
  ffprobe: string;
  source: "explicit" | "montash-home" | "path" | "brew-keg";
}

const BREW_KEG_DIRS = ["/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin"];

function pairIn(dir: string): { ffmpeg: string; ffprobe: string } | null {
  const f = join(dir, "ffmpeg");
  const p = join(dir, "ffprobe");
  return existsSync(f) && existsSync(p) ? { ffmpeg: f, ffprobe: p } : null;
}

export function locateBinaries(opts: { ffmpegPath?: string; ffprobePath?: string; env?: NodeJS.ProcessEnv } = {}): Binaries {
  const env = opts.env ?? process.env;
  const explicitFfmpeg = opts.ffmpegPath ?? env.MONTASH_FFMPEG;
  const explicitFfprobe = opts.ffprobePath ?? env.MONTASH_FFPROBE;
  if (explicitFfmpeg) {
    const ffprobe = explicitFfprobe ?? siblingFfprobe(explicitFfmpeg);
    if (!existsSync(explicitFfmpeg)) throw new MontashError("E_FFMPEG_NOT_FOUND", `ffmpeg not found at ${explicitFfmpeg}`, { hint: "Check --ffmpeg-path / MONTASH_FFMPEG." });
    if (!ffprobe || !existsSync(ffprobe)) throw new MontashError("E_FFMPEG_NOT_FOUND", `ffprobe not found next to ${explicitFfmpeg}`, { hint: "Pass --ffprobe-path / MONTASH_FFPROBE." });
    return { ffmpeg: explicitFfmpeg, ffprobe, source: "explicit" };
  }
  const home = pairIn(join(STATIC_FFMPEG_HOME, "bin"));
  if (home) return { ...home, source: "montash-home" };
  const onPath = Bun.which("ffmpeg");
  const probeOnPath = Bun.which("ffprobe");
  if (onPath && probeOnPath) return { ffmpeg: onPath, ffprobe: probeOnPath, source: "path" };
  for (const dir of BREW_KEG_DIRS) {
    const keg = pairIn(dir);
    if (keg) return { ...keg, source: "brew-keg" };
  }
  throw errors.ffmpegNotFound(onPath ? "ffprobe" : "ffmpeg");
}

function siblingFfprobe(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
}

export interface FfmpegInfo {
  binaries: Binaries;
  version: string;
  versionOk: boolean;
  bestEffort: boolean;
  encoders: Set<string>;
  filters: Set<string>;
  required: { present: string[]; missing: string[] };
  recommended: { present: string[]; missing: string[] };
  optional: string[];
  textEngine: "libass" | "drawtext" | "none";
}

async function run(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

export function parseVersion(firstLine: string): string {
  const m = /ffmpeg version [nN]?([0-9]+(?:\.[0-9]+)*)/.exec(firstLine);
  return m?.[1] ?? "0";
}

export function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** `ffmpeg -encoders` / `-filters` の出力から名前列を取り出す */
export function parseNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    // encoders: " V....D libx264  ..." / filters (ffmpeg ≤6: " T.C xfade  VV->V", ffmpeg 7+: " .S xfade  VV->V")
    const m = /^\s*[A-Z.]{2,7}\s+([A-Za-z0-9_]+)\s+\S/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

export async function inspectFfmpeg(binaries: Binaries): Promise<FfmpegInfo> {
  const [ver, enc, flt] = await Promise.all([
    run(binaries.ffmpeg, ["-version"]),
    run(binaries.ffmpeg, ["-hide_banner", "-encoders"]),
    run(binaries.ffmpeg, ["-hide_banner", "-filters"]),
  ]);
  const version = parseVersion(ver.split("\n")[0] ?? "");
  const encoders = parseNames(enc);
  const filters = parseNames(flt);
  const has = (set: Set<string>, names: readonly string[]) => ({
    present: names.filter((n) => set.has(n)),
    missing: names.filter((n) => !set.has(n)),
  });
  const reqEnc = has(encoders, REQUIRED_ENCODERS);
  const reqFlt = has(filters, REQUIRED_FILTERS);
  const rec = has(filters, RECOMMENDED_FILTERS);
  const textEngine: FfmpegInfo["textEngine"] = filters.has("subtitles") ? "libass" : filters.has("drawtext") ? "drawtext" : "none";
  return {
    binaries,
    version,
    versionOk: versionGte(version, MIN_FFMPEG),
    bestEffort: !versionGte(version, RECOMMENDED_FFMPEG),
    encoders,
    filters,
    required: { present: [...reqEnc.present, ...reqFlt.present], missing: [...reqEnc.missing, ...reqFlt.missing] },
    recommended: rec,
    optional: OPTIONAL_ENCODERS.filter((n) => encoders.has(n)),
    textEngine,
  };
}
