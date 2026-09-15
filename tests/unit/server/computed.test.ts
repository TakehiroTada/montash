/**
 * `GET /api/project` が返す `computed`（docs/06 §2.4、docs/13 D-1）。
 *
 * クリップ種別ごとに長さの持ち方が違う（映像・音声は in/out、テキストは duration_f、
 * 字幕は素材が尺を決める）。どの種別でも `start_f` / `end_f` / `duration_f` が
 * 揃って返ることを、実際にサーバを起動して確認する。
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipLabelText, computeProject, subtitleSpanF } from "../../../src/server/computed.ts";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

const FPS = { num: 30, den: 1 };

const SRT = [
  "1",
  "00:00:00,500 --> 00:00:01,500",
  "最初の字幕です",
  "",
  "2",
  "00:00:03,500 --> 00:00:04,500",
  "Last cue",
  "",
].join("\n");

/** 映像 1 本・テキスト 1 本・字幕 1 本を持つプロジェクト */
function projectWithText(dir: string): Record<string, unknown> {
  const srt = join(dir, "ja.srt");
  writeFileSync(srt, SRT);
  return {
    schema_version: 3,
    name: "computed-test",
    settings: { fps: FPS, resolution: { width: 1280, height: 720 } },
    assets: { ja: { id: "ja", path: srt, type: "subtitle", format: "srt" } },
    tracks: [
      {
        id: "V1",
        kind: "video",
        clips: [{ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 90, speed: 1 }],
      },
      {
        id: "T1",
        kind: "text",
        clips: [
          { id: "x1", type: "text", start_f: 0, duration_f: 75, text: "夏の旅 2026" },
          { id: "s1", type: "subtitle", asset: "ja", mode: "burn", start_f: 0, offset_f: 0 },
        ],
      },
    ],
  };
}

interface ComputedBody {
  computed: {
    duration_f: number;
    span_f: number;
    tracks: Array<{
      id: string;
      clips: Array<{
        id: string;
        kind: string;
        start_f: number;
        end_f: number;
        duration_f: number;
        label: string | null;
      }>;
    }>;
  };
}

describe("GET /api/project computed", () => {
  test("text and subtitle clips get start_f / end_f / duration_f like media clips", async () => {
    const dir = makeTempProject(false);
    writeFileSync(join(dir, "project.json"), JSON.stringify(projectWithText(dir)));
    const srv = await boot(dir);
    try {
      const res = await fetch(`${srv.url}/api/project`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ComputedBody & Record<string, unknown>;
      // project.json は透過したまま（computed を足すだけ）
      expect(body.name).toBe("computed-test");

      const byId = new Map(body.computed.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));

      // 映像クリップ: これまで通り in/out から
      expect(byId.get("c1")).toMatchObject({ kind: "media", start_f: 0, end_f: 90, duration_f: 90 });
      // テキストクリップ: duration_f を尊重する（0 や NaN にならない ＝ D-1 の再発検知）
      expect(byId.get("x1")).toMatchObject({ kind: "text", start_f: 0, end_f: 75, duration_f: 75 });
      expect(byId.get("x1")?.label).toBe("夏の旅 2026");
      // 字幕クリップ: 素材の最初と最後の表示（0.5s〜4.5s ＝ 15f〜135f）
      expect(byId.get("s1")).toMatchObject({ kind: "subtitle", start_f: 15, end_f: 135, duration_f: 120 });

      // 尺は字幕を数えない（CLI の `timeline show` と一致）。描画範囲は字幕込み
      expect(body.computed.duration_f).toBe(90);
      expect(body.computed.span_f).toBe(135);
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });

  test("subtitle clips honour start_f + offset_f", async () => {
    const dir = makeTempProject(false);
    const project = projectWithText(dir) as { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
    const sub = project.tracks[1]?.clips[1] as Record<string, unknown>;
    sub.start_f = 30;
    sub.offset_f = 15;
    writeFileSync(join(dir, "project.json"), JSON.stringify(project));
    const srv = await boot(dir);
    try {
      const body = (await (await fetch(`${srv.url}/api/project`)).json()) as ComputedBody;
      const s1 = body.computed.tracks[1]?.clips[1];
      expect(s1).toMatchObject({ start_f: 60, end_f: 180, duration_f: 120 });
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });

  test("a missing subtitle asset leaves a zero-length clip instead of throwing", async () => {
    const dir = makeTempProject(false);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        settings: { fps: FPS },
        assets: {},
        tracks: [{ id: "T1", kind: "text", clips: [{ id: "s1", type: "subtitle", asset: "gone", start_f: 10 }] }],
      }),
    );
    const srv = await boot(dir);
    try {
      const res = await fetch(`${srv.url}/api/project`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ComputedBody;
      expect(body.computed.tracks[0]?.clips[0]).toMatchObject({ start_f: 10, end_f: 10, duration_f: 0 });
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });
});

describe("computeProject (pure)", () => {
  test("generator clips use duration_f, media clips divide by speed", () => {
    const c = computeProject({
      settings: { fps: FPS },
      tracks: [
        {
          id: "V1",
          kind: "video",
          clips: [
            { id: "g1", type: "generator", generator: "color", start_f: 10, duration_f: 60, label: "black" },
            { id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 90, speed: 2 },
          ],
        },
      ],
    });
    expect(c.tracks[0]?.clips[0]).toMatchObject({ kind: "generator", end_f: 70, duration_f: 60, label: "black" });
    expect(c.tracks[0]?.clips[1]).toMatchObject({ kind: "media", end_f: 45, duration_f: 45 });
  });

  test("text clips without a usable duration_f still get at least one frame", () => {
    const c = computeProject({
      settings: { fps: FPS },
      tracks: [{ id: "T1", kind: "text", clips: [{ id: "x1", type: "text", start_f: 5, text: "hi" }] }],
    });
    expect(c.tracks[0]?.clips[0]).toMatchObject({ start_f: 5, end_f: 6, duration_f: 1 });
  });

  test("a malformed project yields an empty result instead of throwing", () => {
    expect(computeProject(null)).toEqual({ duration_f: 0, span_f: 0, tracks: [] });
    expect(computeProject({ tracks: "nope" })).toEqual({ duration_f: 0, span_f: 0, tracks: [] });
    expect(computeProject({ tracks: [{ id: "V1", clips: [null, 3] }] }).tracks[0]?.clips).toEqual([]);
  });
});

describe("subtitleSpanF", () => {
  test("covers the first and last cue of an SRT file", () => {
    expect(subtitleSpanF(SRT, FPS)).toEqual({ start_f: 15, end_f: 135 });
  });

  test("reads WebVTT too", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n";
    expect(subtitleSpanF(vtt, FPS)).toEqual({ start_f: 30, end_f: 60 });
  });

  test("falls back to ASS Dialogue lines", () => {
    const ass = [
      "[Events]",
      "Format: Layer, Start, End, Style, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,hi",
    ].join("\n");
    expect(subtitleSpanF(ass, FPS)).toEqual({ start_f: 30, end_f: 75 });
  });

  test("returns null when there is nothing to show", () => {
    expect(subtitleSpanF("", FPS)).toBeNull();
    expect(subtitleSpanF("just some prose", FPS)).toBeNull();
  });
});

describe("clipLabelText", () => {
  test("keeps short text as-is and truncates long text to 20 characters", () => {
    expect(clipLabelText("夏の旅 2026")).toBe("夏の旅 2026");
    expect(clipLabelText("あ".repeat(30))).toBe(`${"あ".repeat(20)}…`);
  });

  test("folds newlines into a single line", () => {
    expect(clipLabelText("二行に\nわたる字幕")).toBe("二行に わたる字幕");
  });
});
