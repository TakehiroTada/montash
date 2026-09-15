/**
 * 素材 API テスト用のプロジェクト生成（tests/unit/server/assets-api.test.ts, upload.test.ts が共有）。
 *
 * `montash init` 相当（initProjectDir）で `.montash/` を作り、実体のあるテキスト・画像素材と、
 * ファイルが存在しない映像素材、参照クリップを 1 本だけ置く。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, initProjectDir, parseProject, saveProject } from "../../../src/core/project.ts";

/** 最小の PNG（1x1、透明）。画像素材の原本として置く */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const TITLE_TEXT = "Summer Trip 2026\n福岡到着\n";

export interface AssetFixture {
  dir: string;
  /** プロジェクト外（tmp 直下）に置いた動画もどきの原本。絶対パス参照の検証に使う */
  externalVideo: string;
}

function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export async function makeAssetProject(): Promise<AssetFixture> {
  const root = mkdtempSync(join(tmpdir(), "montash-assets-"));
  const dir = join(root, "project");
  const externalVideo = join(root, "raw", "clip_a.bin");

  const base = createProject({
    name: "assets-test",
    fps: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 },
  });
  await initProjectDir(dir, base);

  write(join(dir, "assets", "text", "title_main.txt"), TITLE_TEXT);
  write(join(dir, "assets", "logo.png"), PNG_1X1);
  write(join(dir, "assets", "ja.srt"), "1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n\n");
  // 外部素材（絶対パス参照）。ffprobe は通さないのでバイト列は何でもよい
  write(externalVideo, Buffer.alloc(4096, 7));

  const project = parseProject({
    ...base,
    assets: {
      clip_a: {
        id: "clip_a",
        type: "video",
        path: externalVideo,
        owned: false,
        tags: ["空撮", "冒頭"],
        label: "冒頭ドローン",
        duration_s: 14.2,
        duration_f: 426,
        video: { codec: "h264", width: 3840, height: 2160, fps: { num: 30000, den: 1001 } },
        audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        derived: { proxy: { state: "missing" } },
      },
      clip_gone: {
        id: "clip_gone",
        type: "video",
        path: join(root, "raw", "does-not-exist.mp4"),
        owned: false,
        tags: [],
        duration_s: 3,
        duration_f: 90,
      },
      logo: { id: "logo", type: "image", path: "assets/logo.png", owned: true, tags: ["ロゴ"] },
      title_main: {
        id: "title_main",
        type: "text",
        path: "assets/text/title_main.txt",
        owned: true,
        tags: [],
        duration_s: null,
        duration_f: null,
        text_preview: TITLE_TEXT.slice(0, 80),
        line_count: 3,
      },
      ja_srt: { id: "ja_srt", type: "subtitle", path: "assets/ja.srt", owned: true, format: "srt", tags: [] },
      // パストラバーサル（プロジェクト外へ抜ける相対パス）。/file は 403 になる
      escaped: { id: "escaped", type: "text", path: "../raw/clip_a.bin", owned: false, tags: [] },
    },
    tracks: [
      {
        id: "V1",
        kind: "video",
        name: "V1",
        clips: [{ id: "c1", type: "media", asset: "clip_a", start_f: 0, in_f: 0, out_f: 90 }],
      },
      { id: "A1", kind: "audio", name: "A1", clips: [] },
    ],
  });
  await saveProject(dir, project);
  return { dir, externalVideo };
}

export function removeAssetProject(fixture: AssetFixture): void {
  rmSync(join(fixture.dir, ".."), { recursive: true, force: true });
}
