/**
 * 履歴テスト用のヘルパ。一時ディレクトリと小さなプロジェクト風 JSON を用意する。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, History, type Op } from "../../../../src/core/history/index.ts";

export interface Clip {
  id: string;
  type: "media";
  asset: string;
  start_f: number;
  duration_f: number;
  in_f: number;
  out_f: number;
}

export interface Project {
  schema_version: number;
  settings: { fps: { num: number; den: number } };
  tracks: { id: string; kind: string; clips: Clip[] }[];
  meta?: Record<string, unknown>;
}

export function sampleProject(): Project {
  return {
    schema_version: 2,
    settings: { fps: { num: 30, den: 1 } },
    tracks: [
      {
        id: "V1",
        kind: "video",
        clips: [{ id: "c1", type: "media", asset: "a", start_f: 0, duration_f: 300, in_f: 0, out_f: 300 }],
      },
      { id: "A1", kind: "audio", clips: [] },
    ],
  };
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "montash-history-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 単調増加する擬似時刻（同一 ms 衝突を避け、並び順を決定的にする） */
export function fakeClock(): () => string {
  let t = Date.parse("2026-09-14T00:00:00.000Z");
  return () => {
    t += 1000;
    return new Date(t).toISOString();
  };
}

export async function openHistory(dir: string): Promise<History> {
  return History.open(dir, { now: fakeClock() });
}

/** 現在の状態 `before` に `mutate` を適用した状態を op として記録し、新しい状態を返す */
export async function step(
  h: History,
  before: Project,
  mutate: (p: Project) => void,
  summary = "edit",
  actor: Actor = "ai",
): Promise<{ after: Project; op: Op }> {
  const after = structuredClone(before);
  mutate(after);
  const { op } = await h.recordOp({ before, after, command: ["test", summary], actor, summary });
  return { after, op };
}

/** 初期化 op（parent null。before = after = 初期状態） */
export async function init(h: History, project: Project = sampleProject()): Promise<{ project: Project; op: Op }> {
  const { op } = await h.recordOp({
    before: project,
    after: project,
    command: ["init"],
    actor: "system",
    summary: "init",
  });
  return { project, op };
}

let clipSeq = 1;
export function newClip(start_f: number, duration_f = 60): Clip {
  clipSeq++;
  return { id: `c${clipSeq}`, type: "media", asset: "a", start_f, duration_f, in_f: 0, out_f: duration_f };
}
