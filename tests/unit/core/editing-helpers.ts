/** クリップ編集・リップルのテストで使う小さなプロジェクト組み立てヘルパ */
import { createProject } from "../../../src/core/project.ts";
import { AssetSchema, type Clip, ClipSchema, clipEndF, type Project, type Track } from "../../../src/core/schema.ts";

/** V1 / A1 / A2 / T1 を持つ 30fps のプロジェクト。アセットは a（5 秒）と bgm（10 秒） */
export function makeProject(): Project {
  const project = createProject({
    name: "editing",
    fps: { num: 30, den: 1 },
    resolution: { width: 640, height: 360 },
  });
  project.assets.a = AssetSchema.parse({
    id: "a",
    path: "a.mp4",
    type: "video",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 640, height: 360, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  });
  project.assets.bgm = AssetSchema.parse({
    id: "bgm",
    path: "bgm.wav",
    type: "audio",
    duration_s: 10,
    duration_f: 300,
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
  });
  project.tracks.push(
    {
      id: "A2",
      kind: "audio",
      name: "A2",
      muted: false,
      locked: false,
      fade: { in_f: 0, out_f: 0, color: "black" },
      clips: [],
    },
    {
      id: "T1",
      kind: "text",
      name: "T1",
      muted: false,
      locked: false,
      fade: { in_f: 0, out_f: 0, color: "black" },
      clips: [],
    },
  );
  return project;
}

export function track(project: Project, id: string): Track {
  const found = project.tracks.find((t) => t.id === id);
  if (!found) throw new Error(`no track ${id}`);
  return found;
}

export function trackEndF(t: Track): number {
  return t.clips.reduce((end, c) => Math.max(end, clipEndF(c)), 0);
}

/**
 * V1/A1 にリンクした映像＋音声クリップを 1 組置く。ID は `c<2n-1>` / `c<2n>`。
 * `start` 省略時は V1/A1 の末尾に隙間なく追加する。
 */
export function addPair(
  project: Project,
  n: number,
  inF: number,
  outF: number,
  start?: number,
): { video: Clip; audio: Clip } {
  const v = track(project, "V1");
  const a = track(project, "A1");
  const at = start ?? Math.max(trackEndF(v), trackEndF(a));
  const videoId = `c${2 * n - 1}`;
  const audioId = `c${2 * n}`;
  const video = ClipSchema.parse({
    id: videoId,
    type: "media",
    asset: "a",
    start_f: at,
    in_f: inF,
    out_f: outF,
    link: audioId,
    video: {},
  });
  const audio = ClipSchema.parse({
    id: audioId,
    type: "media",
    asset: "a",
    start_f: at,
    in_f: inF,
    out_f: outF,
    link: videoId,
    audio: {},
  });
  v.clips.push(video);
  a.clips.push(audio);
  return { video, audio };
}

/** A2 に BGM を 1 本置く（リンクなし。リップルで尺が縮む側の検証用） */
export function addBgm(project: Project, id: string, start: number, durationF: number): Clip {
  const clip = ClipSchema.parse({
    id,
    type: "media",
    asset: "bgm",
    start_f: start,
    in_f: 0,
    out_f: durationF,
    audio: {},
  });
  track(project, "A2").clips.push(clip);
  return clip;
}

/** 再現可能な擬似乱数（mulberry32）。性質テストを決定的にする */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
