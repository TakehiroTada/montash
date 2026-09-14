/**
 * テスト素材の生成（docs/08 §6）。`scripts/make-fixtures.sh` と同じ内容を TypeScript から呼べるようにしたもの。
 *
 * 素材は `testsrc2`（フレームカウンタ表示があり、ゴールデンテストで `select=eq(n,K)` の PSNR 比較に使える）と
 * `sine` で作る。出力先は既定で `tests/fixtures/`（.gitignore 済み）。既に存在するファイルは再生成しない。
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

export interface FixtureSpec {
  /** 出力ファイル名 */
  file: string;
  /** `ffmpeg -hide_banner -nostats -progress pipe:1` の後に続く引数（出力パスは末尾に付与される） */
  args: string[];
  /** 人間向け説明 */
  describe: string;
}

/** x264 の共通設定（速く、GOP 1 秒） */
const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"];

/**
 * 素材定義。キーが `ensureFixtures()` の戻り値のキーになる。
 * `scripts/make-fixtures.sh` と内容を揃えること。
 */
export const FIXTURES: Record<string, FixtureSpec> = {
  a: {
    file: "a.mp4",
    describe: "testsrc2 5s 30fps 640x360 + sine 440Hz 48kHz stereo",
    args: [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000:d=5",
      ...X264,
      "-g",
      "30",
      ...AAC,
      "-frames:v",
      "150",
      "-t",
      "5",
      "-movflags",
      "+faststart",
    ],
  },
  a2997: {
    file: "a2997.mp4",
    describe: "testsrc2 5s 29.97fps (30000/1001) 640x360 + sine 440Hz",
    args: [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30000/1001:d=5",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000:d=5",
      ...X264,
      "-g",
      "30",
      ...AAC,
      "-frames:v",
      "150",
      "-t",
      "5",
      "-movflags",
      "+faststart",
    ],
  },
  tone: {
    file: "tone.wav",
    describe: "sine 440Hz 10s 48kHz stereo pcm_s16le (audio only)",
    args: ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=10", "-ac", "2", "-c:a", "pcm_s16le", "-t", "10"],
  },
  logo: {
    file: "logo.png",
    describe: "testsrc2 single frame 256x128 with alpha (rgba PNG)",
    // 一時ファイル名に拡張子が無いので image2 の既定 (mjpeg) にならないよう -c:v png を明示
    args: ["-f", "lavfi", "-i", "testsrc2=s=256x128:alpha=128:d=1,format=rgba", "-frames:v", "1", "-c:v", "png"],
  },
  b60: {
    file: "b60.mp4",
    describe: "testsrc2 3s 60fps 1280x720 + sine 880Hz",
    args: [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=60:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=f=880:r=48000:d=3",
      ...X264,
      "-g",
      "60",
      ...AAC,
      "-frames:v",
      "180",
      "-t",
      "3",
      "-movflags",
      "+faststart",
    ],
  },
};

export const DEFAULT_FIXTURE_DIR = "tests/fixtures";

/** 同一プロセス内で並行に呼ばれても生成が重複しないよう、進行中の Promise を共有する */
const inflight = new Map<string, Promise<void>>();

async function buildOne(bins: Binaries, dir: string, spec: FixtureSpec): Promise<void> {
  const out = join(dir, spec.file);
  if (existsSync(out)) return;
  const key = resolve(out);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    // 途中で落ちても壊れたファイルが残らないよう、一時名に書いて rename する
    const tmp = join(dir, `.${spec.file}.tmp.${process.pid}`);
    try {
      await runFfmpeg(bins, ["-y", ...spec.args, "-f", formatFor(spec.file), tmp], { timeoutMs: 60_000 });
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 一時ファイル名から拡張子が判別できないので、出力フォーマットを明示する */
function formatFor(file: string): string {
  if (file.endsWith(".mp4")) return "mp4";
  if (file.endsWith(".wav")) return "wav";
  if (file.endsWith(".png")) return "image2";
  if (file.endsWith(".mov")) return "mov";
  throw new Error(`unknown fixture extension: ${file}`);
}

/**
 * 全素材を（無ければ）生成し、キー → 絶対パスの表を返す。
 * @param dir 出力先（既定 `tests/fixtures`。相対パスは cwd 基準）
 * @param only 一部だけ生成したいときのキー一覧
 */
export async function ensureFixtures(
  bins: Binaries,
  dir: string = DEFAULT_FIXTURE_DIR,
  only?: readonly string[],
): Promise<Record<string, string>> {
  const absDir = resolve(dir);
  mkdirSync(absDir, { recursive: true });
  const keys = only ?? Object.keys(FIXTURES);
  const result: Record<string, string> = {};
  await Promise.all(
    keys.map(async (k) => {
      const spec = FIXTURES[k];
      if (!spec) throw new Error(`unknown fixture key: ${k}`);
      await buildOne(bins, absDir, spec);
      result[k] = join(absDir, spec.file);
    }),
  );
  return result;
}
