/**
 * Assets タブの一覧ロジック（web/src/lib/assets.ts）。フィルタ・検索・並び替え・表示整形。
 */
import { describe, expect, test } from "bun:test";
import {
  type AssetView,
  displayName,
  fileName,
  filterAssets,
  formatDuration,
  formatFps,
  formatProxy,
  formatSize,
  formatSpec,
  formatUsage,
  matchesQuery,
  previewSource,
  sortAssets,
  typeIcon,
} from "../../../web/src/lib/assets.ts";

function asset(over: Partial<AssetView> & { id: string }): AssetView {
  return {
    type: "video",
    path: `/raw/${over.id}.mp4`,
    tags: [],
    missing: false,
    usage: { clips: [] },
    proxy: null,
    ...over,
  } as AssetView;
}

const clipA = asset({
  id: "clip_a",
  label: "冒頭ドローン",
  tags: ["空撮", "冒頭"],
  duration_s: 14.2,
  duration_f: 426,
  imported_at: "2026-09-01T10:00:00Z",
  proxy: "ready",
  has_proxy: true,
  video: { codec: "h264", width: 3840, height: 2160, fps: { num: 30000, den: 1001 } },
  usage: { clips: [{ clip_id: "c1", track: "V1", start_f: 0, end_f: 90 }] },
});
const bgm = asset({
  id: "bgm",
  type: "audio",
  path: "/music/theme song.mp3",
  duration_s: 192,
  duration_f: 5760,
  imported_at: "2026-09-03T10:00:00Z",
  proxy: "missing",
  audio: { codec: "aac", channels: 2, sample_rate: 48000 },
});
const logo = asset({
  id: "logo",
  type: "image",
  path: "assets/logo.png",
  duration_s: null,
  duration_f: null,
  imported_at: "2026-09-02T10:00:00Z",
  video: { width: 512, height: 512 },
});
const title = asset({
  id: "title_main",
  type: "text",
  path: "assets/text/title_main.txt",
  label: "オープニング",
  duration_s: null,
  duration_f: null,
  line_count: 2,
});
const gone = asset({ id: "clip_c", missing: true, duration_s: 3, duration_f: 90, proxy: "missing" });
const ALL = [clipA, bgm, logo, title, gone];

describe("filter and search", () => {
  test("type filter", () => {
    expect(filterAssets(ALL, { type: "all" })).toHaveLength(5);
    expect(filterAssets(ALL, { type: "audio" }).map((a) => a.id)).toEqual(["bgm"]);
    expect(filterAssets(ALL, { type: "text" }).map((a) => a.id)).toEqual(["title_main"]);
  });

  test("search covers ID, label, tags and file name", () => {
    expect(matchesQuery(clipA, "clip_a")).toBe(true);
    expect(matchesQuery(clipA, "ドローン")).toBe(true);
    expect(matchesQuery(clipA, "空撮")).toBe(true);
    expect(matchesQuery(clipA, "clip_a.mp4")).toBe(true);
    // ファイル名だけが一致する（パスの他の部分は対象外）
    expect(matchesQuery(bgm, "theme")).toBe(true);
    expect(matchesQuery(bgm, "music")).toBe(false);
    expect(matchesQuery(clipA, "存在しない")).toBe(false);
  });

  test("an empty query matches everything and terms are ANDed", () => {
    expect(matchesQuery(clipA, "   ")).toBe(true);
    expect(matchesQuery(clipA, "空撮 冒頭")).toBe(true);
    expect(matchesQuery(clipA, "空撮 bgm")).toBe(false);
  });

  test("filters combine, and unused / missing narrow further", () => {
    expect(filterAssets(ALL, { type: "video", query: "clip" }).map((a) => a.id)).toEqual(["clip_a", "clip_c"]);
    expect(filterAssets(ALL, { unusedOnly: true }).map((a) => a.id)).toEqual(["bgm", "logo", "title_main", "clip_c"]);
    expect(filterAssets(ALL, { missingOnly: true }).map((a) => a.id)).toEqual(["clip_c"]);
  });
});

describe("sort", () => {
  test("by name uses the label when present, then the ID", () => {
    expect(sortAssets(ALL, "name").map((a) => a.id)).toEqual(["bgm", "clip_c", "logo", "title_main", "clip_a"]);
  });

  test("by duration puts the longest first and length-less assets last", () => {
    const ids = sortAssets(ALL, "duration").map((a) => a.id);
    expect(ids.slice(0, 3)).toEqual(["bgm", "clip_a", "clip_c"]);
    expect(ids.slice(3).sort()).toEqual(["logo", "title_main"]);
  });

  test("by imported date is newest first", () => {
    expect(sortAssets(ALL, "imported").map((a) => a.id)).toEqual(["bgm", "logo", "clip_a", "clip_c", "title_main"]);
  });

  test("sorting does not mutate the input", () => {
    const input = [...ALL];
    sortAssets(input, "name");
    expect(input.map((a) => a.id)).toEqual(ALL.map((a) => a.id));
  });
});

describe("formatting", () => {
  test("usage reads as `c1 (V1)` and collapses long lists", () => {
    expect(formatUsage(clipA.usage.clips)).toBe("c1 (V1)");
    expect(formatUsage([])).toBe("");
    const many = Array.from({ length: 6 }, (_, i) => ({
      clip_id: `c${i}`,
      track: "V1",
      start_f: i,
      end_f: i + 1,
    }));
    expect(formatUsage(many, 2)).toBe("c0 (V1), c1 (V1) 他 4 件");
  });

  test("duration, fps, spec and size", () => {
    expect(formatDuration(14.2)).toBe("14.2s");
    expect(formatDuration(192)).toBe("3:12");
    expect(formatDuration(119.6)).toBe("2:00");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatFps({ num: 30, den: 1 })).toBe("30");
    expect(formatFps({ num: 30000, den: 1001 })).toBe("29.97");
    expect(formatSpec(clipA)).toBe("3840x2160 29.97");
    expect(formatSpec(bgm)).toBe("2ch 48k");
    expect(formatSpec(logo)).toBe("512x512");
    expect(formatSpec(title)).toBe("2 行");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(undefined)).toBe("—");
  });

  test("proxy state, icons and display name", () => {
    expect(formatProxy(clipA)).toContain("ready");
    expect(formatProxy(bgm)).toContain("なし");
    expect(formatProxy(title)).toBe("");
    expect(typeIcon("text")).toBe("T");
    expect(typeIcon("subtitle")).toBe("≡");
    expect(displayName(clipA)).toBe("冒頭ドローン");
    expect(displayName(bgm)).toBe("bgm");
    expect(fileName("C:\\raw\\a.mp4")).toBe("a.mp4");
  });
});

describe("single-asset preview source", () => {
  test("video prefers the proxy and falls back to the original", () => {
    expect(previewSource(clipA)).toEqual({ kind: "video", src: "/api/assets/clip_a/proxy.mp4", original: false });
    expect(previewSource(asset({ id: "raw_v", has_proxy: false }))).toEqual({
      kind: "video",
      src: "/api/assets/raw_v/file",
      original: true,
    });
  });

  test("audio, image and text", () => {
    expect(previewSource(bgm)).toEqual({ kind: "audio", src: "/api/assets/bgm/file", original: true });
    expect(previewSource(logo)).toEqual({ kind: "image", src: "/api/assets/logo/file", original: true });
    expect(previewSource(title)).toMatchObject({ kind: "text", src: null });
  });

  test("a missing asset has no preview", () => {
    expect(previewSource(gone)).toEqual({ kind: "none", src: null, original: false });
  });
});
