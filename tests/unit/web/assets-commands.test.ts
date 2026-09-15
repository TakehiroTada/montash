/**
 * Assets タブが発行する CLI コマンドの組み立て（docs/06 §1.1, §2.6, §3.6）。
 * ここで作った配列がそのまま `POST /api/cli { args }` になる。
 */
import { describe, expect, test } from "bun:test";
import {
  type AssetView,
  assetsSetArgs,
  formatCommand,
  importArgs,
  isValidAssetId,
  newTextArgs,
  normalizeTags,
  proxyBuildArgs,
  relinkArgs,
  removeArgs,
  setTextArgs,
  timelineExamples,
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

describe("timeline examples are shown, never executed (docs/06 §1.2)", () => {
  test("video / audio offer `clip add --asset <id> --at f:<playhead>`", () => {
    const examples = timelineExamples(asset({ id: "clip_d" }), 547);
    expect(examples[0]).toBe("montash clip add --asset clip_d --at f:547");
    expect(examples.every((e) => e.startsWith("montash "))).toBe(true);
  });

  test("image offers overlay add, text offers text add, subtitle offers subtitle add", () => {
    expect(timelineExamples(asset({ id: "logo", type: "image" }), 0).join("\n")).toContain("overlay add --asset logo");
    expect(timelineExamples(asset({ id: "title_main", type: "text" }), 30)[0]).toBe(
      "montash text add --asset title_main --at f:30 --duration 3",
    );
    expect(timelineExamples(asset({ id: "ja_srt", type: "subtitle" }), 0)[0]).toBe(
      "montash subtitle add --asset ja_srt --at f:0",
    );
  });

  test("the playhead is floored and never negative", () => {
    expect(timelineExamples(asset({ id: "a" }), 12.9)[0]).toContain("--at f:12");
    expect(timelineExamples(asset({ id: "a" }), -5)[0]).toContain("--at f:0");
  });

  test("formatCommand quotes arguments that contain spaces", () => {
    expect(formatCommand(["assets", "set", "clip_a", "--label", "冒頭 ドローン"])).toBe(
      'montash assets set clip_a --label "冒頭 ドローン"',
    );
  });
});

describe("assets set", () => {
  const current = asset({ id: "clip_a", label: "旧ラベル", tags: ["空撮"], color: "#111111" });

  test("only changed fields become flags", () => {
    expect(assetsSetArgs("clip_a", { label: "冒頭ドローン" }, current)).toEqual([
      "assets",
      "set",
      "clip_a",
      "--label",
      "冒頭ドローン",
    ]);
    expect(assetsSetArgs("clip_a", { tags: "空撮,冒頭" }, current)).toEqual([
      "assets",
      "set",
      "clip_a",
      "--tags",
      "空撮,冒頭",
    ]);
  });

  test("no change means no command (never create an empty op)", () => {
    expect(assetsSetArgs("clip_a", { label: "旧ラベル", tags: "空撮", color: "#111111" }, current)).toBeNull();
    // 並び順・空白・重複だけの違いも変更ではない
    expect(assetsSetArgs("clip_a", { tags: " 空撮 , 空撮 " }, current)).toBeNull();
  });

  test("an empty label or color clears the field (CLI semantics)", () => {
    expect(assetsSetArgs("clip_a", { label: "" }, current)).toEqual(["assets", "set", "clip_a", "--label", ""]);
  });

  test("normalizeTags trims, drops empties and deduplicates", () => {
    expect(normalizeTags(" a , b ,, a ")).toBe("a,b");
    expect(normalizeTags("")).toBe("");
  });
});

describe("other asset commands", () => {
  test("import always asks for a proxy by default", () => {
    expect(importArgs(" /Volumes/SD/*.MP4 ")).toEqual(["import", "/Volumes/SD/*.MP4", "--proxy"]);
    expect(importArgs("/a.mp4", false)).toEqual(["import", "/a.mp4"]);
  });

  test("new-text / set-text", () => {
    expect(newTextArgs("title_main", "Summer Trip 2026", "  ")).toEqual([
      "assets",
      "new-text",
      "title_main",
      "--text",
      "Summer Trip 2026",
    ]);
    expect(newTextArgs("title_main", "x", "見出し")).toEqual([
      "assets",
      "new-text",
      "title_main",
      "--text",
      "x",
      "--label",
      "見出し",
    ]);
    expect(setTextArgs("title_main", "Summer Trip 2027")).toEqual([
      "assets",
      "set-text",
      "title_main",
      "--text",
      "Summer Trip 2027",
    ]);
  });

  test("remove adds --force only when the caller asked for it", () => {
    expect(removeArgs("clip_x", false)).toEqual(["assets", "remove", "clip_x"]);
    expect(removeArgs("clip_x", true)).toEqual(["assets", "remove", "clip_x", "--force"]);
  });

  test("relink by path or by directory search", () => {
    expect(relinkArgs("clip_c", { path: " /Volumes/ext/raw/clip_c.mp4 " })).toEqual([
      "assets",
      "relink",
      "clip_c",
      "--path",
      "/Volumes/ext/raw/clip_c.mp4",
    ]);
    expect(relinkArgs("clip_c", { search: "/Volumes/ext/raw" })).toEqual([
      "assets",
      "relink",
      "clip_c",
      "--search",
      "/Volumes/ext/raw",
    ]);
  });

  test("proxy rebuild uses --force (confirm required by the server)", () => {
    expect(proxyBuildArgs("clip_a")).toEqual(["proxy", "build", "clip_a", "--force"]);
  });

  test("asset IDs must stay filesystem-safe", () => {
    expect(isValidAssetId("title_main")).toBe(true);
    expect(isValidAssetId("a-1")).toBe(true);
    expect(isValidAssetId("")).toBe(false);
    expect(isValidAssetId("../x")).toBe(false);
    expect(isValidAssetId("タイトル")).toBe(false);
  });
});
