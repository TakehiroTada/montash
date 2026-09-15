/**
 * `montash explain <id|timeline>`（docs/04 §16、docs/02 F-AI-4、W-21）。
 *
 * ハンドラを直接呼び、「自然言語（`explanation`）と機械可読な事実（`facts`）の両方が返る」ことを
 * 種別ごとに固定する。レンダーの説明（`explain render`）は ffmpeg を必要とするので W-21 で見る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateFilterGraph, explain } from "../../../src/cli/commands/explain.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject, saveProject } from "../../../src/core/project.ts";
import type { Project } from "../../../src/core/schema.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: false,
  noColor: true,
  timeFormat: "seconds",
  ...over,
});

let dir = "";
const ctx = () => createContext(globals(), { cwd: dir, env: {}, isTTY: false, argv: ["explain"] });

interface Explanation {
  target: string;
  kind: string;
  subtype?: string;
  headline: string;
  explanation: string[];
  facts: Record<string, unknown>;
  notes: string[];
  see_also: string[];
}

const run = async (target: string): Promise<Explanation> => {
  const res = await explain.handler(ctx(), { target });
  return res.result as Explanation;
};

/** `explanation` を 1 本の文字列にして、言い回しを緩く照合する */
const prose = (e: Explanation): string => e.explanation.join(" ");

const human = async (target: string): Promise<string> => {
  const res = await explain.handler(ctx(), { target });
  return typeof res.human === "function" ? res.human() : (res.human ?? "");
};

/**
 * 一通りの要素が載ったプロジェクト。
 * 素材ファイルは実体も作る（`explain` はファイルの有無を「注意」として見るため）。
 */
async function seed(): Promise<Project> {
  const project = createProject({ name: "demo", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.clip_b = {
    id: "clip_b",
    type: "video",
    path: "media/b.mp4",
    owned: false,
    tags: ["b-roll"],
    duration_f: 900,
    duration_s: 30,
    video: { codec: "h264", width: 1920, height: 1080, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", channels: 2, sample_rate: 48000 },
  } as never;
  project.assets.subs = {
    id: "subs",
    type: "subtitle",
    path: "media/ja.srt",
    owned: false,
    tags: [],
    format: "srt",
  } as never;

  // 既定のプロジェクトは V1 / A1 だけなので、テキストトラックを足す
  project.tracks.push({
    id: "T1",
    kind: "text",
    name: "T1",
    muted: false,
    locked: false,
    fade: { in_f: 0, out_f: 0, color: "black" },
    clips: [],
  } as never);
  const video = project.tracks.find((t) => t.kind === "video");
  const audio = project.tracks.find((t) => t.kind === "audio");
  const text = project.tracks.find((t) => t.kind === "text");
  video?.clips.push(
    {
      id: "c2",
      type: "media",
      asset: "clip_b",
      start_f: 375,
      in_f: 0,
      out_f: 600,
      speed: 1,
      pitch_keep: false,
      loop: false,
      link: "c2a",
      effects: [
        { type: "color", params: { saturation: 1.2 } },
        { type: "glow", params: { radius: 4 } },
      ],
    } as never,
    // プラグインが無いと解釈できないクリップ（F-EXT-4）
    { id: "c9", type: "confetti", start_f: 1200, duration_f: 90, density: 7, effects: [] } as never,
    // ジェネレータ（未登録の種別も含む）
    {
      id: "c10",
      type: "generator",
      generator: "color",
      params: { color: "#101010" },
      start_f: 1400,
      duration_f: 30,
      effects: [],
    } as never,
  );
  audio?.clips.push({
    id: "c2a",
    type: "media",
    asset: "clip_b",
    start_f: 375,
    in_f: 0,
    out_f: 600,
    speed: 1,
    pitch_keep: false,
    loop: false,
    link: "c2",
    audio: { gain_db: -3, fade: { in_f: 0, out_f: 15, curve: "tri" }, offset_smp: 0, muted: false },
    effects: [],
  } as never);
  text?.clips.push(
    {
      id: "x1",
      type: "text",
      start_f: 0,
      duration_f: 90,
      text: "Opening title",
      asset: null,
      markup: "plain",
      style: { preset: "title-center", size: 64, color: "#ffffff" },
      fade: { in_f: 10, out_f: 10 },
      effects: [],
    } as never,
    {
      id: "s1",
      type: "subtitle",
      asset: "subs",
      mode: "burn",
      start_f: 0,
      offset_f: 0,
      style: {},
      effects: [],
    } as never,
  );
  project.transitions.push({
    id: "t1",
    track: video?.id ?? "V1",
    from: "c1",
    to: "c2",
    type: "fade",
    duration_f: 15,
    mode: "handle",
    audio: "crossfade",
    params: {},
  } as never);
  project.audio.ducking.push({
    id: "d1",
    target: audio?.id ?? "A1",
    sidechain: video?.id ?? "V1",
    threshold_db: -30,
    ratio: 8,
    attack_ms: 20,
    release_ms: 500,
    makeup_db: 0,
  } as never);
  return project;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-explain-"));
  const project = await seed();
  await initProjectDir(dir, project);
  await saveProject(dir, project);
  await recordInitialOp(dir, project, ctx());
});

describe("explain <clip>", () => {
  test("映像クリップは「何を・どこから・どれだけ・どう置いたか」を 1 文で言う", async () => {
    const e = await run("c2");
    expect(e.kind).toBe("clip");
    expect(e.subtype).toBe("media");
    expect(e.headline).toContain("media clip on track V1");
    // 素材・ソース区間・タイムライン位置・尺がすべて最初の文に入る
    const first = e.explanation[0] ?? "";
    expect(first).toContain("clip_b");
    expect(first).toContain("f:0..f:600");
    expect(first).toContain("f:375..f:975");
    expect(first).toContain("600 frames");
    // リンクされた音声とトランジションにも触れる（docs/04 §16 の例と同じ内容）
    expect(prose(e)).toContain("c2a");
    expect(prose(e)).toContain("t1");
  });

  test("派生値は clip list と同じ形で facts に入る（秒とフレームの併記）", async () => {
    const e = await run("c2");
    expect(e.facts.clip).toMatchObject({
      id: "c2",
      track: "V1",
      start_f: 375,
      end_f: 975,
      duration_f: 600,
      start: 12.5,
      end: 32.5,
      asset: "clip_b",
    });
    expect(e.facts.source).toMatchObject({ length_f: 600 });
  });

  test("掛かっている効果とパラメータを説明に含める（effect list 相当）", async () => {
    const e = await run("c2");
    expect(prose(e)).toContain("color (saturation=1.2)");
    expect(e.facts.effects).toMatchObject([
      { index: 0, type: "color", params: { saturation: 1.2 } },
      { index: 1, type: "glow", params: { radius: 4 } },
    ]);
  });

  test("未登録の効果はプラグイン不足として注意に出る（F-EXT-4）", async () => {
    const e = await run("c2");
    expect(e.notes.join(" ")).toContain("glow");
    expect(e.notes.join(" ")).toContain("E_PLUGIN_MISSING");
  });

  test("速度変更は「ソース何フレームがタイムライン何フレームになるか」を言う", async () => {
    const project = await loadProject(dir);
    const clip = project.tracks[0]?.clips.find((c) => c.id === "c2") as { speed: number };
    clip.speed = 2;
    await saveProject(dir, project);
    const e = await run("c2");
    expect(prose(e)).toContain("Playback speed is 2x");
    expect(e.facts.speed).toBe(2);
  });

  test("テキストクリップは本文・尺・スタイルを言う", async () => {
    const e = await run("x1");
    expect(e.subtype).toBe("text");
    expect(prose(e)).toContain('"Opening title"');
    expect(prose(e)).toContain("f:0");
    expect(prose(e)).toContain("90 frames");
    expect(prose(e)).toContain("preset title-center");
    expect(prose(e)).toContain("fades in over 0.333s and out over 0.333s");
  });

  test("字幕クリップは「尺を持たないのは素材側」を説明し、読めれば区間も出す", async () => {
    await mkdir(join(dir, "media"), { recursive: true });
    await writeFile(
      join(dir, "media", "ja.srt"),
      "1\n00:00:01,000 --> 00:00:03,000\nこんにちは\n\n2\n00:00:05,000 --> 00:00:08,000\nさようなら\n",
    );
    const e = await run("s1");
    expect(e.subtype).toBe("subtitle");
    expect(prose(e)).toContain("burn");
    expect(prose(e)).toContain("carries no length");
    expect(e.facts.cue_span).toMatchObject({ start: { f: 30 }, end: { f: 240 } });
  });

  test("ジェネレータクリップは素材を読まないことを言う", async () => {
    const e = await run("c10");
    expect(e.subtype).toBe("generator");
    expect(prose(e)).toContain("It reads no asset.");
    expect(e.facts.generator_registered).toBe(true);
  });

  test("プラグイン不足の opaque クリップは「置き場所しか読めない」と説明する（F-EXT-4）", async () => {
    const e = await run("c9");
    expect(e.subtype).toBe("opaque");
    expect(prose(e)).toContain('clip type "confetti"');
    expect(prose(e)).toContain("f:1200..f:1290");
    expect(e.notes.join(" ")).toContain("E_PLUGIN_MISSING");
    expect(e.facts.interpretable).toBe(false);
  });
});

describe("explain <transition|track|asset|ducking>", () => {
  test("トランジションはハンドルの伸ばし方まで説明する", async () => {
    const e = await run("t1");
    expect(e.kind).toBe("transition");
    expect(prose(e)).toContain("c1");
    expect(prose(e)).toContain("c2");
    expect(prose(e)).toContain("0.500s");
    // handleExtension(15) = { ext_from: 8, ext_to: 7 }
    expect(prose(e)).toContain("8 frames");
    expect(prose(e)).toContain("7 frames");
    expect(e.facts.handle).toMatchObject({ ext_from: 8, ext_to: 7 });
  });

  test("トラックは種別・クリップ数・終端と、載っているクリップを言う", async () => {
    const e = await run("V1");
    expect(e.kind).toBe("track");
    expect(prose(e)).toContain("video track holding 3 clips");
    expect(prose(e)).toContain("c2 at");
    expect(e.facts).toMatchObject({ id: "V1", kind: "video", clip_count: 3 });
  });

  test("アセットは素材の素性と使用箇所（usage）を言い、元素材を書き換えないことを明示する", async () => {
    const e = await run("clip_b");
    expect(e.kind).toBe("asset");
    expect(prose(e)).toContain("1920x1080");
    expect(prose(e)).toContain("never writes to it");
    expect(prose(e)).toContain("c2 on V1");
    expect(e.facts.usage).toMatchObject({
      clips: [
        { id: "c2a", track: "A1", start_f: 375, end_f: 975 },
        { id: "c2", track: "V1", start_f: 375, end_f: 975 },
      ],
    });
  });

  test("素材ファイルが無ければ relink を案内する", async () => {
    const e = await run("clip_b");
    expect(e.notes.join(" ")).toContain("assets relink clip_b");
  });

  test("ダッキングはどのトラックをいつ下げるかを言う", async () => {
    const e = await run("d1");
    expect(e.kind).toBe("ducking");
    expect(prose(e)).toContain("-30 dB");
    expect(prose(e)).toContain("8:1");
  });
});

describe("explain timeline", () => {
  test("尺・fps・解像度・トラック構成・トランジションをまとめる", async () => {
    const e = await run("timeline");
    expect(e.kind).toBe("timeline");
    expect(prose(e)).toContain("30 fps");
    expect(prose(e)).toContain("640x360");
    expect(prose(e)).toContain("V1 (video, 3 clips");
    expect(e.facts).toMatchObject({ duration_f: 1430, clip_count: 6 });
  });

  test("プラグイン不足のクリップがあることを注意に出す", async () => {
    const e = await run("timeline");
    expect(e.notes.join(" ")).toContain("c9");
  });
});

describe("explain の出力形", () => {
  test("自然言語と JSON の両方を返す（F-AI-4）", async () => {
    const e = await run("c2");
    expect(e.explanation.length).toBeGreaterThan(1);
    for (const sentence of e.explanation) expect(sentence.endsWith(".")).toBe(true);
    expect(Object.keys(e.facts).length).toBeGreaterThan(3);
  });

  test("人間向け出力には見出し・文・次の一手が並ぶ", async () => {
    const text = await human("c2");
    expect(text.split("\n")[0]).toContain("c2 — media clip on track V1");
    expect(text).toContain("Notes");
    expect(text).toContain("See also");
    expect(text).toContain("montash effect list c2 --json");
  });

  test("読み取り専用なので op を作らない", async () => {
    const res = await explain.handler(ctx(), { target: "timeline" });
    expect(res.op ?? null).toBeNull();
    expect(res.changes).toBeUndefined();
  });
});

describe("explain の失敗", () => {
  const codeOf = async (target: string): Promise<MontashError> => {
    try {
      await run(target);
    } catch (err) {
      return err as MontashError;
    }
    throw new Error(`expected ${target} to fail`);
  };

  test("無いクリップ ID は E_CLIP_NOT_FOUND と候補", async () => {
    const err = await codeOf("c3");
    expect(err).toBeInstanceOf(MontashError);
    expect(err.code).toBe("E_CLIP_NOT_FOUND");
    expect(err.hint).toContain("c2");
    expect(err.detail?.candidates as string[]).toContain("c2");
  });

  test("ID の形から種別を当てて既存のコードに揃える", async () => {
    expect((await codeOf("t9")).code).toBe("E_TRANSITION_NOT_FOUND");
    expect((await codeOf("V9")).code).toBe("E_TRACK_NOT_FOUND");
    expect((await codeOf("d9")).code).toBe("E_DUCKING_NOT_FOUND");
    expect((await codeOf("nope")).code).toBe("E_ASSET_NOT_FOUND");
  });

  test("hint は次に叩くコマンドを含む（docs/10 §5）", async () => {
    const err = await codeOf("nope");
    expect(err.hint).toContain("montash assets list --json");
  });
});

describe("annotateFilterGraph()", () => {
  test("連鎖ごとに入出力ラベルとフィルタの役割を付ける", async () => {
    const chains = annotateFilterGraph("[0:v]trim=start_frame=0,setpts=N[v0];[v0]scale=1920:1080[v1]");
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({ index: 1, inputs: ["0:v"], outputs: ["v0"] });
    expect(chains[0]?.filters.map((f) => f.name)).toEqual(["trim", "setpts"]);
    expect(chains[0]?.filters[0]?.note).toContain("in/out");
    expect(chains[1]?.filters[0]?.name).toBe("scale");
  });

  test("引用符の中の `,` や `;` では割らない（ASS のパスなど）", async () => {
    const chains = annotateFilterGraph("[v]subtitles=filename='/tmp/a,b;c.ass',format=yuv420p[V]");
    expect(chains).toHaveLength(1);
    expect(chains[0]?.filters.map((f) => f.name)).toEqual(["subtitles", "format"]);
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
