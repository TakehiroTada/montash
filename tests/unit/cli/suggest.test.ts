/**
 * `suggest highlights` のハンドラを直接呼ぶテスト（docs/04 §16、W-23、D-23）。
 * 外部プロセス（ffmpeg / 書き起こしエンジン）はフックで差し替える。
 * tests/unit/cli/subtitle-generate.test.ts と同じ書き方（yargs を通さないので camelCase で渡す）。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setSuggestHooks, type SuggestHooks, suggestHighlightsCommand } from "../../../src/cli/commands/suggest.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { ExitCode, type MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, ClipSchema } from "../../../src/core/schema.ts";
import type { TranscriptToken } from "../../../src/core/subtitle-format.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: true,
  noColor: true,
  timeFormat: "frames",
  ...over,
});

let dir: string;
let engine: string;
let model: string;

function ctx(argv: string[], over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });
}

type Args = Record<string, unknown>;
const call = (args: Args = {}, over?: Partial<GlobalOptions>) =>
  suggestHighlightsCommand.handler(
    ctx(["test"], over) as never,
    { enginePath: engine, model, ...args } as never,
  ) as Promise<CommandResult>;

/** 山笠の話 → 3 秒の間 →「では」で決算の話、という 96 秒 */
const UTTERANCES: [string, number, number][] = [
  ["今日は山笠の話をします。", 0, 8],
  ["山笠は毎日走ります。山笠の準備があります。", 9, 20],
  ["山笠の仲間と山笠の練習をしました。", 21, 34],
  ["山笠は有名な祭りです。", 35, 44],
  ["では決算の話に移ります。", 47, 56],
  ["決算の資料を確認しました。決算の締めは来月です。", 57, 70],
  ["決算の数字は経理が集計します。", 71, 84],
  ["決算について質問はありますか。", 85, 96],
];
const TOKENS: TranscriptToken[] = UTTERANCES.map(([text, s, e]) => ({ text, startMs: s * 1000, endMs: e * 1000 }));
const SILENCE = (() => {
  const out: { from: number; to: number; duration: number }[] = [];
  let cursor = 0;
  for (const [, s, e] of UTTERANCES) {
    if (s > cursor) out.push({ from: cursor, to: s, duration: s - cursor });
    cursor = e;
  }
  out.push({ from: cursor, to: 100, duration: 100 - cursor });
  return out;
})();

let seen: { source: string | null; audio: string | null; vocabulary: string[]; transcribed: boolean };

function hooks(tokens: TranscriptToken[] = TOKENS): SuggestHooks {
  return {
    extractAudio: async ({ output, source }) => {
      seen.source = source;
      writeFileSync(output, "RIFF");
      return { args: ["-i", source ?? "(timeline)", output], durationMs: 1 };
    },
    analyze: async ({ duration }) => ({
      duration,
      integrated_lufs: -20,
      lra: 5,
      true_peak_dbfs: -3,
      mean_volume_db: -24,
      max_volume_db: -6,
      silence: SILENCE,
      active: [],
    }),
    transcribe: async (input) => {
      seen.audio = input.audio;
      seen.vocabulary = input.vocabulary;
      seen.transcribed = true;
      return { tokens, args: ["--model", input.model], durationMs: 1, stderrTail: [], jsonPath: "x.json" };
    },
  };
}

/** 30fps / 100 秒の映像 1 本をタイムラインに置く */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-suggest-"));
  engine = join(dir, "fake-whisper");
  model = join(dir, "ggml-fake.bin");
  writeFileSync(engine, "#!/bin/sh\n");
  writeFileSync(model, "");
  const project = createProject({
    name: "meeting",
    fps: { num: 30, den: 1 },
    resolution: { width: 1280, height: 720 },
  });
  project.assets.rec = AssetSchema.parse({
    id: "rec",
    type: "video",
    path: "rec.mp4",
    duration_s: 100,
    duration_f: 3000,
  });
  project.assets.logo = AssetSchema.parse({ id: "logo", type: "image", path: "logo.png" });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "rec", start_f: 0, in_f: 0, out_f: 3000 }),
  );
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, ctx(["init"]));
}

beforeEach(async () => {
  seen = { source: null, audio: null, vocabulary: [], transcribed: false };
  await setup();
  __setSuggestHooks(hooks());
});

afterEach(() => {
  __setSuggestHooks(null);
});

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

test("候補を返し、根拠とそのまま打てる clip add を添える", async () => {
  const out = await call({ asset: "rec", threshold: 0.6 });
  const result = out.result as Record<string, any>;

  expect(result.candidates.length).toBe(2);
  expect(result.signals).toMatchObject({ transcript: true, silence: true });
  const first = result.candidates[0];
  expect(first.rank).toBeGreaterThan(0);
  expect(first.start_tc).toMatch(/^00:00:/);
  expect(first.start_f).toBe(0);
  expect(first.keywords).toContain("山笠");
  expect(first.lead).toBe("今日は山笠の話をします。");
  expect(first.evidence.lexical_shift).toBeDefined();
  expect(first.command).toMatch(/^montash clip add --asset rec --in 00:00:/);
  expect(seen.source).toMatch(/rec\.mp4$/);
});

test("タイムラインには触れない（読み取り専用）", async () => {
  const before = JSON.stringify(await loadProject(dir));
  const out = await call({ asset: "rec" });
  expect((out.result as Record<string, unknown>).applied).toBe(false);
  expect(out.changes).toBeUndefined();
  expect(out.op).toBeUndefined();
  expect(JSON.stringify(await loadProject(dir))).toBe(before);
});

test("--max は枠を決めるだけで、枠外の候補も結果に残る（決めるのは人）", async () => {
  const out = await call({ asset: "rec", threshold: 0.6, max: "45" });
  const result = out.result as Record<string, any>;
  expect(result.candidates.length).toBe(2);
  expect(result.selected_count).toBe(1);
  expect(result.selected_duration_s).toBeLessThanOrEqual(45);
  expect(result.candidates.filter((c: { selected: boolean }) => !c.selected).length).toBe(1);
});

test("--count は選ぶ本数を絞る", async () => {
  const result = (await call({ asset: "rec", threshold: 0.6, count: 1 })).result as Record<string, any>;
  expect(result.selected_count).toBe(1);
});

test("--no-transcribe はエンジンを呼ばず、無音区間だけで候補を出す", async () => {
  const result = (await call({ asset: "rec", transcribe: false, pause: 2 })).result as Record<string, any>;
  expect(seen.transcribed).toBe(false);
  expect(result.transcript).toBeNull();
  expect(result.signals.transcript).toBe(false);
  expect(result.candidates.length).toBeGreaterThan(0);
  for (const c of result.candidates) expect(c.keywords).toEqual([]);
});

test("--asset を省くとタイムラインのミックスを見る（clip add は添えない）", async () => {
  const result = (await call({ threshold: 0.6 })).result as Record<string, any>;
  expect(seen.source).toBeNull();
  expect(result.source).toBe("timeline");
  expect(result.asset).toBeNull();
  for (const c of result.candidates) expect(c.command).toBeNull();
});

test("--dry-run は何も走らせずに計画だけ返す", async () => {
  const result = (await call({ asset: "rec" }, { dryRun: true })).result as Record<string, any>;
  expect(result.dry_run).toBe(true);
  expect(seen.source).toBeNull();
  expect(seen.transcribed).toBe(false);
});

test("用語リストはエンジンに渡り、結果にも残る", async () => {
  const result = (await call({ asset: "rec", vocabulary: ["山笠,決算"] })).result as Record<string, any>;
  expect(seen.vocabulary).toEqual(["山笠", "決算"]);
  expect(result.transcript.vocabulary).toEqual(["山笠", "決算"]);
});

// ---------------------------------------------------------------------------
// 失敗系
// ---------------------------------------------------------------------------

test("エンジンが無ければ E_TRANSCRIBER_NOT_FOUND（ffmpeg も走らせない）", async () => {
  const err = (await call({ asset: "rec", enginePath: join(dir, "missing") }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_TRANSCRIBER_NOT_FOUND");
  expect(err.exitCode).toBe(ExitCode.EXTERNAL);
  expect(seen.source).toBeNull();
});

test("モデルが無ければ E_TRANSCRIBER_MODEL_NOT_FOUND", async () => {
  const err = (await call({ asset: "rec", model: join(dir, "missing.bin") }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_TRANSCRIBER_MODEL_NOT_FOUND");
});

test("知らない素材は E_ASSET_NOT_FOUND", async () => {
  const err = (await call({ asset: "nope" }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_ASSET_NOT_FOUND");
});

test("画像素材は E_ASSET_TYPE_MISMATCH", async () => {
  const err = (await call({ asset: "logo" }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_ASSET_TYPE_MISMATCH");
});

test("発話が見つからなければ E_NO_HIGHLIGHTS（勝手に何かを提案しない）", async () => {
  __setSuggestHooks({
    ...hooks([]),
    analyze: async ({ duration }) => ({
      duration,
      integrated_lufs: null,
      lra: null,
      true_peak_dbfs: null,
      mean_volume_db: null,
      max_volume_db: null,
      silence: [{ from: 0, to: 100, duration: 100 }],
      active: [],
    }),
  });
  const err = (await call({ asset: "rec", transcribe: false }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_NO_HIGHLIGHTS");
  expect(err.hint).toContain("--min-length");
});
