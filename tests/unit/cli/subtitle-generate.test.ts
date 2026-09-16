/**
 * `subtitle generate` のハンドラを直接呼ぶテスト（docs/04 §12、W-22）。
 * 外部プロセス（ffmpeg / 書き起こしエンジン）はフックで差し替える。
 * tests/unit/cli/subtitle.test.ts と同じ書き方（yargs を通さないので camelCase で渡す）。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setTranscribeHooks,
  subtitleGenerate,
  type TranscribeHooks,
} from "../../../src/cli/commands/subtitle-generate.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { ExitCode, type MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, ClipSchema, isSubtitleClip } from "../../../src/core/schema.ts";
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
  subtitleGenerate.handler(
    ctx(["test"], over) as never,
    { enginePath: engine, model, ...args } as never,
  ) as Promise<CommandResult>;

/** 3 文ぶんのトークン（whisper 相当）。固有名詞とカタカナ語を含む */
const TOKENS: TranscriptToken[] = (
  [
    ["今日", 0, 300],
    ["は", 300, 420],
    ["事前", 420, 800],
    ["ガ", 800, 900],
    ["イダンス", 900, 1400],
    ["の", 1400, 1500],
    ["話", 1500, 1800],
    ["です", 1800, 2000],
    ["。", 2000, 2100],
    ["多面", 2400, 2800],
    ["観察", 2800, 3200],
    ["は", 3200, 3300],
    ["総括", 3300, 3700],
    ["次長", 3700, 4100],
    ["が", 4100, 4200],
    ["まとめ", 4200, 4600],
    ["ます", 4600, 4800],
    ["。", 4800, 4900],
  ] as const
).map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

/** フックが受け取った引数を覗く */
let seen: { audio: string | null; vocabulary: string[]; lang: string | undefined; source: string | null };

function hooks(tokens: TranscriptToken[] = TOKENS): TranscribeHooks {
  return {
    extractAudio: async ({ output, source }) => {
      seen.source = source;
      writeFileSync(output, "RIFF");
      return { args: ["-i", source ?? "(timeline)", output], durationMs: 1 };
    },
    transcribe: async (input) => {
      seen.audio = input.audio;
      seen.vocabulary = input.vocabulary;
      seen.lang = input.lang;
      return { tokens, args: ["--model", input.model], durationMs: 1, stderrTail: [], jsonPath: "x.json" };
    },
  };
}

/** 30fps / 映像 1 本。フォント列挙に依存しないよう default_font を決めておく */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-subgen-"));
  engine = join(dir, "fake-whisper");
  model = join(dir, "ggml-fake.bin");
  writeFileSync(engine, "#!/bin/sh\n");
  writeFileSync(model, "");
  const project = createProject({ name: "talk", fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } });
  project.settings.default_font = "Hiragino Sans";
  project.assets.a = AssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_s: 10, duration_f: 300 });
  project.assets.ja_srt = AssetSchema.parse({ id: "ja_srt", type: "subtitle", path: "ja.srt", format: "srt" });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 300 }),
  );
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, ctx(["init"]));
}

beforeEach(async () => {
  seen = { audio: null, vocabulary: [], lang: undefined, source: null };
  await setup();
  __setTranscribeHooks(hooks());
});

afterEach(() => {
  __setTranscribeHooks(null);
});

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

test("SRT を書き、素材として取り込み、字幕クリップとして置く", async () => {
  const out = (await call()) as CommandResult;
  const result = out.result as Record<string, any>;

  const srt = join(dir, "subtitles", "talk.ja.srt");
  expect(result.srt).toBe(srt);
  expect(existsSync(srt)).toBe(true);
  expect(await readFile(srt, "utf8")).toBe(
    [
      "1",
      "00:00:00,000 --> 00:00:02,100",
      "今日は事前ガイダンスの話です。",
      "",
      "2",
      "00:00:02,400 --> 00:00:04,900",
      "多面観察は総括次長がまとめます。",
      "",
    ].join("\n"),
  );
  expect(result.cues).toBe(2);
  expect(result.language).toBe("ja");
  expect(result.engine.path).toBe(engine);

  const project = await loadProject(dir);
  const asset = project.assets[result.asset.id];
  expect(asset?.type).toBe("subtitle");
  expect((asset as { format?: string }).format).toBe("srt");
  expect((asset as { language?: string }).language).toBe("ja");
  expect(asset?.path).toBe(srt);

  const text = project.tracks.find((t) => t.kind === "text");
  expect(text?.id).toBe("T1");
  const clip = text?.clips.find(isSubtitleClip);
  expect(clip?.asset).toBe(result.asset.id);
  expect(clip?.mode).toBe("burn");
  expect(clip?.lang).toBe("ja");
  expect(clip?.style.font).toBe("Hiragino Sans");
  expect(result.track_created).toBe("T1");
});

test("--no-add は SRT を書くだけ（プロジェクトは変えない）", async () => {
  const before = JSON.stringify(await loadProject(dir));
  const out = await call({ add: false });
  const result = out.result as Record<string, unknown>;
  expect(result.asset).toBeNull();
  expect(result.clip).toBeNull();
  expect(existsSync(join(dir, "subtitles", "talk.ja.srt"))).toBe(true);
  expect(JSON.stringify(await loadProject(dir))).toBe(before);
});

test("--asset は素材 1 つを書き起こす（タイムラインのミックスではなく）", async () => {
  await call({ asset: "a" });
  expect(seen.source).toBe(join(dir, "a.mp4"));
});

test("--asset が無ければタイムラインのミックスを書き起こす", async () => {
  await call();
  expect(seen.source).toBeNull();
});

test("--lang と --vocabulary がエンジンに届く", async () => {
  await call({ lang: "en", vocabulary: ["多面観察,総括次長"] });
  expect(seen.lang).toBe("en");
  expect(seen.vocabulary).toEqual(["多面観察", "総括次長"]);
});

test("--lang auto は言語指定なしでエンジンに渡す", async () => {
  await call({ lang: "auto" });
  expect(seen.lang).toBeUndefined();
});

test("整形の制約はオプションで変えられる", async () => {
  await call({ maxChars: 8, maxLines: 1, output: join(dir, "short.srt") });
  const srt = await readFile(join(dir, "short.srt"), "utf8");
  for (const line of srt.split("\n")) {
    if (line === "" || /^\d+$/.test(line) || line.includes("-->")) continue;
    expect(line.length).toBeLessThanOrEqual(9);
  }
});

test("--pause は句点が無い区間の切れ目になる（D-22）", async () => {
  // 句点が無く、2 文が地続きのトークン列（実素材と同じ形）。0.38 秒の間がある
  const noStop: TranscriptToken[] = [
    { text: "テックライブのお知らせと", startMs: 0, endMs: 1200 },
    { text: "ありがとうございます", startMs: 1450, endMs: 2450 },
    { text: "テックライブの33回目のお知らせです", startMs: 2830, endMs: 4530 },
  ];
  __setTranscribeHooks(hooks(noStop));
  const splitPath = join(dir, "split.srt");
  const split = (await call({ pause: 0.3, output: splitPath })).result as Record<string, unknown>;
  expect(split.cues).toBe(2);
  // 間を見れば、字幕の切れ目が文の切れ目と一致する
  expect(await Bun.file(splitPath).text()).toContain("テックライブの33回目のお知らせです");

  // 間を見ないと文の切れ目では切れない（字数で割れるので cue 数が同じになることはある）
  const mergedPath = join(dir, "merged.srt");
  await call({ pause: 0, output: mergedPath });
  expect(await Bun.file(mergedPath).text()).not.toContain("テックライブの33回目のお知らせです");
});

test("--pause に負の数は弾く", async () => {
  const err = (await call({ pause: -1 }).catch((e) => e)) as MontashError;
  expect(err.code).toBe("E_USAGE");
});

test("--mode soft / --at / --id / --asset-id を反映する", async () => {
  const out = await call({ mode: "soft", at: "f:30", id: "s9", assetId: "talk_subs" });
  const result = out.result as Record<string, any>;
  expect(result.asset.id).toBe("talk_subs");
  expect(result.clip.id).toBe("s9");
  expect(result.clip.mode).toBe("soft");
  expect(result.clip.start_f).toBe(30);
});

test("--dry-run は何も書かずに計画だけ返す", async () => {
  const out = await call({}, { dryRun: true });
  const result = out.result as Record<string, any>;
  expect(result.dry_run).toBe(true);
  expect(result.command[0]).toBe(engine);
  expect(existsSync(join(dir, "subtitles", "talk.ja.srt"))).toBe(false);
});

// ---------------------------------------------------------------------------
// 失敗系
// ---------------------------------------------------------------------------

async function failure(args: Args, over?: Partial<GlobalOptions>): Promise<MontashError> {
  try {
    await call(args, over);
  } catch (e) {
    return e as MontashError;
  }
  throw new Error("expected a failure");
}

test("エンジンが無ければ E_TRANSCRIBER_NOT_FOUND（終了コード 3）", async () => {
  const err = await failure({ enginePath: join(dir, "nope") });
  expect(err.code).toBe("E_TRANSCRIBER_NOT_FOUND");
  expect(err.exitCode).toBe(ExitCode.EXTERNAL);
  expect(err.hint).toContain("whisper.cpp");
});

test("モデルが無ければ E_TRANSCRIBER_MODEL_NOT_FOUND", async () => {
  const err = await failure({ model: join(dir, "nope.bin") });
  expect(err.code).toBe("E_TRANSCRIBER_MODEL_NOT_FOUND");
  expect(err.hint).toContain("MONTASH_TRANSCRIBER_MODEL");
});

test("エンジンが見つからないときは SRT を書かない（先に確かめる）", async () => {
  await failure({ enginePath: join(dir, "nope") });
  expect(existsSync(join(dir, "subtitles"))).toBe(false);
});

test("何も認識できなければ E_TRANSCRIPT_EMPTY", async () => {
  __setTranscribeHooks(hooks([]));
  const err = await failure({});
  expect(err.code).toBe("E_TRANSCRIPT_EMPTY");
  expect(err.hint).toContain("--lang");
});

test("既に SRT があれば E_OUTPUT_EXISTS、--overwrite で上書きできる", async () => {
  await call();
  const err = await failure({});
  expect(err.code).toBe("E_OUTPUT_EXISTS");
  const out = await call({ overwrite: true, assetId: "second" });
  expect((out.result as Record<string, unknown>).cues).toBe(2);
});

test("字幕素材を --asset に渡したら E_ASSET_TYPE_MISMATCH", async () => {
  const err = await failure({ asset: "ja_srt" });
  expect(err.code).toBe("E_ASSET_TYPE_MISMATCH");
});

test("知らない素材は E_ASSET_NOT_FOUND", async () => {
  const err = await failure({ asset: "nope" });
  expect(err.code).toBe("E_ASSET_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 誤認識を直して焼き直す（W-24）
// ---------------------------------------------------------------------------

/** 「フロント演動」のように語が 2 トークンに割れて誤認識された形 */
const MISHEARD: TranscriptToken[] = (
  [
    ["テーマ", 0, 500],
    ["は", 500, 700],
    ["大規模", 700, 1200],
    ["プロジェクト", 1200, 1900],
    ["を", 1900, 2000],
    ["支える", 2000, 2500],
    ["フロント", 2500, 3000],
    ["演動", 3000, 3300],
    ["の", 3300, 3400],
    ["リアル", 3400, 3900],
    ["です", 3900, 4300],
    ["。", 4300, 4400],
  ] as const
).map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

test("--save-transcript が整形前のトークンを残す", async () => {
  const path = join(dir, "t.json");
  const out = await call({ saveTranscript: path, add: false, output: join(dir, "a.srt") });
  expect((out.result as Record<string, unknown>).saved_transcript).toBe(path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.format).toBe("montash.transcript");
  expect(saved.tokens).toEqual(TOKENS);
  expect(saved.text).toBe("今日は事前ガイダンスの話です。多面観察は総括次長がまとめます。");
  expect(saved.engine.path).toBe(engine);
  expect(saved.language).toBe("ja");
});

test("--from-transcript はエンジンを呼ばずに整形だけやり直す", async () => {
  const path = join(dir, "t.json");
  await call({ saveTranscript: path, add: false, output: join(dir, "a.srt") });
  seen = { audio: null, vocabulary: [], lang: undefined, source: null };

  const out = await call({
    fromTranscript: path,
    add: false,
    output: join(dir, "b.srt"),
    enginePath: join(dir, "does-not-exist"),
    model: join(dir, "no-model.bin"),
  });
  // エンジンもモデルも無くても通る（音声の書き出しもしない）
  expect(seen.audio).toBeNull();
  expect(seen.source).toBeNull();
  const result = out.result as Record<string, any>;
  expect(result.from_transcript).toBe(path);
  expect(result.command).toBeNull();
  expect(result.ffmpeg_command).toBeNull();
  expect(await readFile(join(dir, "b.srt"), "utf8")).toBe(await readFile(join(dir, "a.srt"), "utf8"));
});

test("--replace は整形の前に当たり、折り返しがやり直される（W-24）", async () => {
  __setTranscribeHooks(hooks(MISHEARD));
  const wrong = join(dir, "wrong.srt");
  await call({ add: false, output: wrong });
  expect(await readFile(wrong, "utf8")).toContain("フロント演動");

  const fixed = join(dir, "fixed.srt");
  const out = await call({
    add: false,
    output: fixed,
    replace: ["フロント演動=フロントエンド運用"],
  });
  const body = await readFile(fixed, "utf8");
  expect(body).toContain("フロントエンド運用");
  expect(body).not.toContain("フロント演動");
  // 語が 2 文字伸びても 1 行 20 字・2 行を超えない
  for (const line of body.split("\n")) {
    if (line === "" || /^\d+$/.test(line) || line.includes("-->")) continue;
    expect([...line].length).toBeLessThanOrEqual(21);
  }
  expect((out.result as Record<string, unknown>).replacements).toEqual([
    { from: "フロント演動", to: "フロントエンド運用", count: 1 },
  ]);
  // 置換で語が伸びても、字幕の出る時刻は動かない
  expect(await readFile(fixed, "utf8")).toContain("00:00:00,000 --> ");
});

test("--replace-file の規則も当たる（人が育てる用語ファイル）", async () => {
  __setTranscribeHooks(hooks(MISHEARD));
  const rules = join(dir, "rules.txt");
  writeFileSync(rules, "# 朝ミの用語\nフロント演動=フロントエンド運用\n\n");
  const output = join(dir, "from-file.srt");
  await call({ replaceFile: rules, add: false, output });
  expect(await readFile(output, "utf8")).toContain("フロントエンド運用");
});

test("当たらなかった置換規則は W_REPLACE_UNUSED で知らせる", async () => {
  const out = await call({ add: false, output: join(dir, "w.srt"), replace: ["存在しない語=なにか"] });
  expect(out.warnings?.[0]?.code).toBe("W_REPLACE_UNUSED");
  expect(out.warnings?.[0]?.message).toContain("存在しない語");
});

test("置換したトークンを保存し直せる（次はそこから続けられる）", async () => {
  __setTranscribeHooks(hooks(MISHEARD));
  const first = join(dir, "first.json");
  await call({ saveTranscript: first, add: false, output: join(dir, "c.srt") });
  const second = join(dir, "second.json");
  await call({
    fromTranscript: first,
    saveTranscript: second,
    replace: ["フロント演動=フロントエンド運用"],
    add: false,
    output: join(dir, "d.srt"),
  });
  const saved = JSON.parse(await readFile(second, "utf8"));
  expect(saved.text).toContain("フロントエンド運用");
  expect(saved.replacements).toEqual([{ from: "フロント演動", to: "フロントエンド運用", count: 1 }]);
});

test("--from-transcript で書き起こした字幕もタイムラインに置ける", async () => {
  const path = join(dir, "t.json");
  await call({ saveTranscript: path, add: false, output: join(dir, "a.srt") });
  const out = await call({ fromTranscript: path, output: join(dir, "placed.srt") });
  const result = out.result as Record<string, any>;
  expect(result.clip.mode).toBe("burn");
  const project = await loadProject(dir);
  expect(project.assets[result.asset.id]?.type).toBe("subtitle");
});

test("--dry-run は --from-transcript でもエンジンを要求しない", async () => {
  const path = join(dir, "t.json");
  await call({ saveTranscript: path, add: false, output: join(dir, "a.srt") });
  const out = await call(
    { fromTranscript: path, enginePath: join(dir, "nope"), model: join(dir, "nope.bin") },
    { dryRun: true },
  );
  const result = out.result as Record<string, any>;
  expect(result.dry_run).toBe(true);
  expect(result.command).toBeNull();
  expect(result.tokens).toBe(TOKENS.length);
});

test("--from-transcript と --asset は同時に使えない", async () => {
  const path = join(dir, "t.json");
  await call({ saveTranscript: path, add: false, output: join(dir, "a.srt") });
  const err = await failure({ fromTranscript: path, asset: "a" });
  expect(err.code).toBe("E_USAGE");
});

test("壊れた --replace は E_USAGE（エンジンを呼ぶ前に弾く）", async () => {
  const err = await failure({ replace: ["イコールが無い"] });
  expect(err.code).toBe("E_USAGE");
  expect(err.message).toContain("wrong=right");
  expect(existsSync(join(dir, "subtitles"))).toBe(false);
});

test("無い書き起こしは E_TRANSCRIPT_NOT_FOUND、montash の形でなければ E_TRANSCRIPT_INVALID", async () => {
  const missing = await failure({ fromTranscript: join(dir, "nope.json") });
  expect(missing.code).toBe("E_TRANSCRIPT_NOT_FOUND");

  const bogus = join(dir, "bogus.json");
  writeFileSync(bogus, '{"transcription":[]}');
  const invalid = await failure({ fromTranscript: bogus });
  expect(invalid.code).toBe("E_TRANSCRIPT_INVALID");

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  const unreadable = await failure({ fromTranscript: broken });
  expect(unreadable.code).toBe("E_TRANSCRIPT_INVALID");
});

test("無い --replace-file は E_REPLACE_FILE_NOT_FOUND", async () => {
  const err = await failure({ replaceFile: join(dir, "nope.txt") });
  expect(err.code).toBe("E_REPLACE_FILE_NOT_FOUND");
});
