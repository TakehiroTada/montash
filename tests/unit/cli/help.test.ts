/**
 * `montash help`（docs/04 §2, docs/13 D-11）。
 * 人間向けの整形が壊れていないことと、`--json` の中身が `schema` と一致することを見る。
 * help は schema と同じ定義データを整形するだけなので、定義の二重管理が起きていないことも
 * ここで担保する（examples の有無も含めて全コマンドを走査する）。
 */
import { describe, expect, test } from "bun:test";
import { help } from "../../../src/cli/commands/help.ts";
import { commands } from "../../../src/cli/commands/registry.ts";
import { schema } from "../../../src/cli/commands/schema.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { guardHelpCommand } from "../../../src/cli/index.ts";

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

async function humanOf(command: string[]): Promise<string> {
  const res = await help.handler(ctx(), { command });
  const h = res.human;
  return typeof h === "function" ? h() : (h ?? "");
}

describe("montash help", () => {
  test("引数なしはグループごとの一覧を出す", async () => {
    const text = await humanOf([]);
    expect(text).toContain(`montash — ${commands.length} commands`);
    // グループは名前 + 配下のサブコマンド、単体コマンドは summary
    expect(text).toMatch(/\n {2}clip {2,}add, list/);
    expect(text).toContain("check ffmpeg / Bun / platform");
    // グループ名と同名のコマンドがある場合は summary と配下の両方を出す
    expect(text).toMatch(/\n {2}render {2,}render the timeline/);
    expect(text).toMatch(/\+ verify, presets/);
  });

  test("グループ名と同名のコマンドはサブコマンドも案内する", async () => {
    const text = await humanOf(["render"]);
    expect(text).toContain("montash render — render the timeline");
    expect(text).toContain("Subcommands");
    expect(text).toContain("verify, presets, batch, still, gif, audio");
  });

  test("グループ名を渡すと配下の一覧を出す", async () => {
    const text = await humanOf(["clip"]);
    expect(text).toContain("montash clip — 7 commands");
    expect(text).toContain("clip split");
    expect(text).not.toContain("track add");
  });

  test("コマンドを渡すと詳細を出す（--help に無い情報を含む）", async () => {
    const text = await humanOf(["clip", "add"]);
    expect(text).toContain("montash clip add — place a trimmed asset");
    // --help では分からない 3 点
    expect(text).toContain("changes the project (recorded as an op");
    expect(text).toContain("workflow: W-03");
    expect(text).toContain("--in <time>"); // 時間表記を受け取るオプション
    // 必須オプションは Usage 行に出る
    expect(text).toContain("montash clip add --asset <string> [options]");
    expect(text).toContain("[required]");
    // グローバルオプションは並べず、1 行の案内に留める
    expect(text).toContain("Global options (every command):");
    expect(text.match(/^ {2}--project/m)).toBeNull();
  });

  test("読み取り専用コマンドはその旨を出す", async () => {
    const text = await humanOf(["clip", "list"]);
    expect(text).toContain("read-only (nothing is recorded in the history)");
  });

  test("未知のコマンドは E_USAGE と候補を返す", async () => {
    expect(help.handler(ctx(), { command: ["clipp"] })).rejects.toThrow(MontashError);
    try {
      await help.handler(ctx(), { command: ["clipp"] });
    } catch (e) {
      const err = e as MontashError;
      expect(err.code).toBe("E_USAGE");
      expect(err.hint).toContain('"clip add"');
    }
  });

  test("--json の内容は schema と一致する（定義の二重管理が無い）", async () => {
    // schema はグループ前方一致で複数返すため、ここは葉のコマンドで比べる
    for (const path of ["clip add", "render verify", "doctor"]) {
      const viaHelp = await help.handler(ctx(), { command: path.split(" ") });
      const viaSchema = await schema.handler(ctx(), { command: path, format: "json" });
      expect(viaHelp.result).toEqual(viaSchema.result);
    }
  });

  test("すべてのコマンドが例を持ち、例は自分自身のパスで始まる", () => {
    for (const spec of commands) {
      const examples = spec.examples ?? [];
      expect(examples).not.toHaveLength(0);
      // 関連コマンドを併記する例もあるので、少なくとも 1 つは自分自身の使い方であること
      expect(examples.some((e) => e.cmd.startsWith(`montash ${spec.path}`))).toBe(true);
    }
  });

  test("すべてのコマンドの詳細が例外なく整形できる", async () => {
    for (const spec of commands) {
      const text = await humanOf(spec.path.split(" "));
      expect(text).toContain(`montash ${spec.path} —`);
      expect(text).toContain("Usage");
      expect(text).toContain("Examples");
    }
  });
});

describe("guardHelpCommand", () => {
  // yargs は位置引数の末尾が "help" だと内蔵ヘルプへ横取りするため、その場合だけ空の位置引数を足す
  test("位置引数が help だけのときに空の位置引数を足す", () => {
    expect(guardHelpCommand(["help"])).toEqual(["help", ""]);
    expect(guardHelpCommand(["help", "--json"])).toEqual(["help", "--json", ""]);
  });

  test("それ以外は何も変えない", () => {
    expect(guardHelpCommand(["help", "clip", "add"])).toEqual(["help", "clip", "add"]);
    expect(guardHelpCommand(["clip", "add", "--label", "help"])).toEqual(["clip", "add", "--label", "help"]);
    expect(guardHelpCommand(["status"])).toEqual(["status"]);
    expect(guardHelpCommand([])).toEqual([]);
  });
});
