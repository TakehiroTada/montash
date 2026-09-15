/**
 * コマンド／機能宣言の合成（docs/13 D-18、計画 P0-6）。
 *
 * 「実行はできるが `montash schema` / `montash help` に出ない」を構造的に無くしたのが本体なので、
 * 実行時に足した spec が getCommands / schema / help の 3 者すべてに現れることを固定する。
 * 併せて、登録が空なら従来と完全に同じ（コマンド数・必須フィルタ集合）であることも固定する。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { help } from "../../../src/cli/commands/help.ts";
import { commands as builtinCommands } from "../../../src/cli/commands/registry.ts";
import { schema } from "../../../src/cli/commands/schema.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { type CommandSpec, defineCommand } from "../../../src/cli/define-command.ts";
import { buildCli } from "../../../src/cli/index.ts";
import { RECOMMENDED_FILTERS, REQUIRED_ENCODERS, REQUIRED_FILTERS } from "../../../src/ffmpeg/locate.ts";
import { clearRegisteredCommands, getCommands, registerCommand } from "../../../src/registry/commands.ts";
import {
  clearRegisteredRequirements,
  recommendedFilters,
  registerRequirements,
  requiredEncoders,
  requiredFilters,
} from "../../../src/registry/requirements.ts";

/** 組み込みコマンド数。外から見た挙動を変えないための固定値（docs/04） */
const BUILTIN_COMMAND_COUNT = 100;

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: false,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: false,
  noColor: true,
  timeFormat: "seconds",
  ...over,
});

const ctx = () => createContext(globals(), { cwd: process.cwd(), env: {}, isTTY: false });

const sample = (path: string): CommandSpec<Record<string, unknown>> =>
  defineCommand<Record<string, unknown>>({
    path,
    summary: "test-only command registered at runtime",
    noProject: true,
    examples: [{ cmd: `montash ${path}` }],
    handler: () => ({ result: { ok: true } }),
  });

afterEach(() => {
  clearRegisteredCommands();
  clearRegisteredRequirements();
});

describe("getCommands()", () => {
  test("登録が空なら組み込み配列と同一（コマンド数が変わらない）", async () => {
    const specs = await getCommands();
    expect(specs).toHaveLength(BUILTIN_COMMAND_COUNT);
    expect(builtinCommands).toHaveLength(BUILTIN_COMMAND_COUNT);
    expect(specs.map((s) => s.path)).toEqual(builtinCommands.map((s) => s.path));
  });

  test("実行時に足した spec は組み込みの後ろに 1 度だけ現れる", async () => {
    registerCommand(sample("plugin-demo run"));
    const paths = (await getCommands()).map((s) => s.path);
    expect(paths).toHaveLength(BUILTIN_COMMAND_COUNT + 1);
    expect(paths.filter((p) => p === "plugin-demo run")).toHaveLength(1);
    // 組み込みの並びは保たれる
    expect(paths.slice(0, BUILTIN_COMMAND_COUNT)).toEqual(builtinCommands.map((s) => s.path));
  });

  test("同じパスの再登録は上書きする（重複にはならない）", async () => {
    registerCommand(sample("plugin-demo run"));
    registerCommand(sample("plugin-demo run"));
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT + 1);
  });

  test("組み込みと同じパスを足すと重複として弾かれる", async () => {
    registerCommand(sample("clip add"));
    expect(getCommands()).rejects.toThrow('duplicate command path: "clip add"');
  });

  test("clearRegisteredCommands() で組み込みだけに戻る", async () => {
    registerCommand(sample("plugin-demo run"));
    clearRegisteredCommands();
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT);
  });
});

describe("追加した spec が schema / help に現れる", () => {
  test("schema --json に載る（AI のツール定義から漏れない）", async () => {
    registerCommand(sample("plugin-demo run"));
    const all = await schema.handler(ctx(), { format: "json" });
    const paths = (all.result as Array<{ path: string }>).map((s) => s.path);
    expect(paths).toContain("plugin-demo run");
    expect(paths).toHaveLength(BUILTIN_COMMAND_COUNT + 1);

    // 単体指定でも引ける
    const one = await schema.handler(ctx(), { command: "plugin-demo run", format: "json" });
    expect((one.result as Array<{ summary: string }>)[0]?.summary).toBe("test-only command registered at runtime");
  });

  test("help の一覧・詳細に載る", async () => {
    registerCommand(sample("plugin-demo run"));
    const overview = await help.handler(ctx(), { command: [] });
    const overviewText = typeof overview.human === "function" ? overview.human() : (overview.human ?? "");
    expect(overviewText).toContain(`montash — ${BUILTIN_COMMAND_COUNT + 1} commands`);
    expect(overviewText).toContain("plugin-demo");

    const detail = await help.handler(ctx(), { command: ["plugin-demo", "run"] });
    const detailText = typeof detail.human === "function" ? detail.human() : (detail.human ?? "");
    expect(detailText).toContain("montash plugin-demo run — test-only command registered at runtime");
  });

  test("登録が空なら schema の件数は組み込みと同じ", async () => {
    const all = await schema.handler(ctx(), { format: "json" });
    expect(all.result as unknown[]).toHaveLength(BUILTIN_COMMAND_COUNT);
  });
});

describe("buildCli()", () => {
  test("async になっても yargs を組み立てられ、追加コマンドも解釈できる", async () => {
    registerCommand(sample("plugin-demo run"));
    // exitProcess(false): yargs のヘルプ出力でテストプロセスが落ちないようにする
    const y = (await buildCli(["plugin-demo", "run"])).exitProcess(false);
    // yargs のヘルプ文字列に追加コマンドが出る（= registerCommands まで届いている）
    const helpText = await y.getHelp();
    expect(helpText).toContain("plugin-demo");
  });
});

describe("ffmpeg 機能要求の合成", () => {
  // 組み込みエフェクト（`registry/effects.ts`）が宣言したフィルタは、拡張の登録が空でも常に足される
  // （docs/13 D-15、計画 P1-3）。組み込み由来なので `clearRegisteredRequirements()` では消えない。
  // 並びは BUILTIN_VIDEO_EFFECTS の宣言順（color / blur / mosaic / lut3d / flip / rotate）に
  // BUILTIN_AUDIO_EFFECTS の宣言順（denoise / eq / compress）を継いだものの重複除去。
  const BUILTIN_EFFECT_FILTERS = [
    "eq",
    "gblur",
    "pixelize",
    "lut3d",
    "hflip",
    "vflip",
    "transpose",
    "afftdn",
    "highpass",
    "lowpass",
    "equalizer",
    "acompressor",
  ];
  const baseFilters = [...REQUIRED_FILTERS, ...BUILTIN_EFFECT_FILTERS];

  test("拡張の登録が空なら、組み込み由来のぶんだけが足された集合", () => {
    expect(requiredFilters(REQUIRED_FILTERS)).toEqual(baseFilters);
    expect(requiredEncoders(REQUIRED_ENCODERS)).toEqual([...REQUIRED_ENCODERS]);
    expect(recommendedFilters(RECOMMENDED_FILTERS, requiredFilters(REQUIRED_FILTERS))).toEqual([
      ...RECOMMENDED_FILTERS,
    ]);
  });

  test("拡張が宣言したフィルタが必須集合の後ろに足される", () => {
    registerRequirements("plugin:glow", { filters: ["unsharp"], encoders: ["libvpx"] });
    expect(requiredFilters(REQUIRED_FILTERS)).toEqual([...baseFilters, "unsharp"]);
    expect(requiredEncoders(REQUIRED_ENCODERS)).toEqual([...REQUIRED_ENCODERS, "libvpx"]);
  });

  test("組み込みと重複する宣言は二重に足さない", () => {
    registerRequirements("plugin:dup", { filters: ["xfade", "unsharp", "gblur", "eq"] });
    registerRequirements("plugin:dup2", { filters: ["unsharp"] });
    expect(requiredFilters(REQUIRED_FILTERS)).toEqual([...baseFilters, "unsharp"]);
  });

  test("必須に上がったフィルタは推奨から落とす（doctor が二重に報告しない）", () => {
    registerRequirements("plugin:subs", { filters: ["subtitles"] });
    const required = requiredFilters(REQUIRED_FILTERS);
    expect(recommendedFilters(RECOMMENDED_FILTERS, required)).toEqual(["drawtext"]);
  });

  test("registerCommand の requires も doctor の検査対象になる", () => {
    registerCommand(sample("plugin-demo run"), { requires: { filters: ["deshake"] } });
    expect(requiredFilters(REQUIRED_FILTERS)).toContain("deshake");
    // コマンドを外すと要求も消える
    clearRegisteredCommands();
    expect(requiredFilters(REQUIRED_FILTERS)).toEqual(baseFilters);
  });
});
