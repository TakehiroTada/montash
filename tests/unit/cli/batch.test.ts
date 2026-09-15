/**
 * `montash batch` のハンドラを直接呼ぶテスト（tests/unit/cli/clip-edit.test.ts と同じ書き方）。
 * docs/04 §16, docs/11 §3.2, F-AI-5, W-20。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBatchInput, splitShellLine } from "../../../src/cli/batch-input.ts";
import { batch } from "../../../src/cli/commands/batch.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { History } from "../../../src/core/history/index.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema } from "../../../src/core/schema.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: true,
  verbose: false,
  dryRun: false,
  yes: true,
  noColor: true,
  timeFormat: "frames",
  ...over,
});

let dir: string;

function ctx(argv: string[], over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });
}

interface BatchArgs {
  file: string;
  atomic?: boolean;
  continueOnError?: boolean;
}

/** バッチを 1 回走らせる。argv には `montash batch ...` 相当を渡す（`--atomic` の明示検出に使う） */
const run = (args: BatchArgs, over?: Partial<GlobalOptions>, argv: string[] = ["batch", args.file]) =>
  batch.handler(
    ctx(argv, over) as never,
    { atomic: true, continueOnError: false, ...args } as never,
  ) as Promise<CommandResult>;

/** 行の配列を .jsonl として書き出し、そのパスを返す */
function writeLines(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const ADD = (inF: number, durF: number) =>
  `{"args": ["clip", "add", "--asset", "a", "--in", "f:${inF}", "--duration", "f:${durF}", "--at", "end"]}`;

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-batch-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = AssetSchema.parse({
    id: "a",
    path: "a.mp4",
    type: "video",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 640, height: 360, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  });
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, ctx(["init"]));
}

const clipIds = async () => (await loadProject(dir)).tracks.flatMap((t) => t.clips.map((c) => c.id));
const opIds = async () => (await (await History.open(dir)).ops()).map((o) => o.id);

interface BatchResultView {
  source: string;
  mode: string;
  dry_run: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  rolled_back: boolean;
  lines: Array<{
    line: number;
    index: number;
    command?: string;
    status: string;
    op?: string | null;
    summary?: string;
    result?: unknown;
    error?: { code: string; message: string; hint?: string };
  }>;
}

const view = (res: CommandResult) => res.result as BatchResultView;

// ---------------------------------------------------------------------------

describe("batch 入力の解釈（JSON Lines / 素の bash 行）", () => {
  test("3 つの書き方を受け付け、空行と # は読み飛ばす", () => {
    const lines = parseBatchInput(
      [
        "# コメント",
        "",
        '{"args": ["clip", "add", "--asset", "a"]}',
        '["clip", "list"]',
        "montash timeline show --from 0",
        "   ",
      ].join("\n"),
    );
    expect(lines.map((l) => l.line)).toEqual([3, 4, 5]);
    expect(lines.map((l) => l.index)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.form)).toEqual(["json", "json", "shell"]);
    expect(lines[0]?.args).toEqual(["clip", "add", "--asset", "a"]);
    expect(lines[1]?.args).toEqual(["clip", "list"]);
    // 先頭の `montash` は付けても付けなくてもよい
    expect(lines[2]?.args).toEqual(["timeline", "show", "--from", "0"]);
  });

  test("引用符とエスケープを解釈する（変数展開はしない）", () => {
    expect(splitShellLine(`text add --text "hello  world" --font 'A B'`, 1)).toEqual([
      "text",
      "add",
      "--text",
      "hello  world",
      "--font",
      "A B",
    ]);
    expect(splitShellLine(String.raw`text add --text a\ b --at=-1`, 1)).toEqual([
      "text",
      "add",
      "--text",
      "a b",
      "--at=-1",
    ]);
  });

  test("壊れた JSON / 閉じていない引用符 / 空の args は行番号付きで E_BATCH_PARSE", () => {
    for (const [raw, needle] of [
      ['{"args": ["clip"', "not valid JSON"],
      ['text add --text "x', "unterminated double quote"],
      ['{"args": []}', '"args" is empty'],
      ['{"args": [1, {}]}', "only strings"],
      ['{"note": "no args"}', '"args" must be an array'],
    ] as const) {
      const err = (() => {
        try {
          parseBatchInput(`clip list\n${raw}\n`);
          return null;
        } catch (e) {
          return e as MontashError;
        }
      })();
      expect(err).toBeInstanceOf(MontashError);
      expect(err?.code).toBe("E_BATCH_PARSE");
      expect(err?.message).toContain("line 2");
      expect(err?.message).toContain(needle);
      expect(err?.detail?.line).toBe(2);
    }
  });
});

describe("batch --atomic（既定）", () => {
  beforeEach(async () => {
    await setup();
  });

  test("正常系: 全行を実行し、履歴には 1 op だけ積む（docs/11 §3.2）", async () => {
    const file = writeLines("ok.jsonl", [
      "# 3 cuts",
      ADD(0, 30),
      "clip add --asset a --in f:30 --duration f:30 --at end",
      '["clip", "list"]',
    ]);
    const res = await run({ file });

    const v = view(res);
    expect(v.mode).toBe("atomic");
    expect([v.total, v.succeeded, v.failed, v.skipped]).toEqual([3, 3, 0, 0]);
    expect(v.rolled_back).toBe(false);
    expect(v.lines.map((l) => [l.line, l.command, l.status])).toEqual([
      [2, "clip add", "ok"],
      [3, "clip add", "ok"],
      [4, "clip list", "ok"],
    ]);
    // 読み取り系の行も結果を返す
    expect(v.lines[2]?.result).toBeDefined();

    // 1 op にまとまる（行ごとの op は積まれない）
    expect(await opIds()).toEqual(["o_0001", "o_0002"]);
    expect(res.op).toBe("o_0002");
    expect(v.lines.every((l) => (l.op ?? null) === null)).toBe(true);

    const ops = await (await History.open(dir)).ops();
    const op = ops.at(-1);
    expect(op?.command[0]).toBe("batch");
    expect(op?.summary).toContain("3 command(s)");
    expect(op?.changes.length).toBeGreaterThan(0);
    // 実際に 2 本（+ リンクされた音声）が並んでいる
    expect((await clipIds()).length).toBeGreaterThanOrEqual(2);
    expect(res.head).toEqual({ op: "o_0002", pending: 2, detached: false });
  });

  test("途中で失敗したら開始前の状態へ巻き戻し、op を 1 つも残さない", async () => {
    const before = await loadProject(dir);
    const file = writeLines("bad.jsonl", [ADD(0, 30), "clip delete nope", ADD(60, 30)]);

    const err = (await run({ file }).catch((e) => e)) as MontashError;
    expect(err).toBeInstanceOf(MontashError);
    expect(err.code).toBe("E_BATCH_FAILED");
    expect(err.message).toContain("line 2");
    expect(err.message).toContain("rolled back");

    const d = err.detail as unknown as BatchResultView & { rollback: { via: string; head: string } };
    expect([d.total, d.succeeded, d.failed, d.skipped]).toEqual([3, 1, 1, 1]);
    expect(d.rolled_back).toBe(true);
    expect(d.rollback.via).toBe("checkout"); // 既存の履歴機構で戻す
    expect(d.lines.map((l) => l.status)).toEqual(["ok", "failed", "skipped"]);
    expect(d.lines[1]?.error?.code).toBe("E_CLIP_NOT_FOUND");
    expect(err.hint).toContain("Nothing was applied");

    // 状態も履歴も開始前のまま
    expect(await clipIds()).toEqual([]);
    expect(await opIds()).toEqual(["o_0001"]);
    const after = await loadProject(dir);
    expect(after.tracks).toEqual(before.tracks);
    // checkout で戻したので moves.jsonl に痕跡が残る
    expect((await (await History.open(dir)).moves()).length).toBe(1);
  });

  test("1 行目で失敗したら何も書いていないので巻き戻し自体が要らない", async () => {
    const file = writeLines("first.jsonl", ["clip delete nope", ADD(0, 30)]);
    const err = (await run({ file }).catch((e) => e)) as MontashError;
    const d = err.detail as unknown as BatchResultView & { rollback: { via: string } };
    expect(d.rolled_back).toBe(false);
    expect(d.rollback.via).toBe("nothing-applied");
    expect(err.message).toContain("nothing had been applied yet");
    expect(await opIds()).toEqual(["o_0001"]);
  });

  test("不正な JSON Lines は 1 行も実行せずに落とす", async () => {
    const file = writeLines("broken.jsonl", [ADD(0, 30), '{"args": ["clip"']);
    const err = (await run({ file }).catch((e) => e)) as MontashError;
    expect(err.code).toBe("E_BATCH_PARSE");
    expect(err.detail?.line).toBe(2);
    expect(await clipIds()).toEqual([]);
    expect(await opIds()).toEqual(["o_0001"]);
  });

  test("空ファイル・コメントだけのファイルは E_BATCH_EMPTY", async () => {
    for (const lines of [[], ["", "   "], ["# nothing to do"]]) {
      const file = writeLines("empty.jsonl", lines);
      const err = (await run({ file }).catch((e) => e)) as MontashError;
      expect(err.code).toBe("E_BATCH_EMPTY");
      expect(err.hint).toContain("one command per line");
    }
    expect(await opIds()).toEqual(["o_0001"]);
  });

  test("HEAD を動かすコマンドは atomic バッチに入れられない", async () => {
    const file = writeLines("undo.jsonl", [ADD(0, 30), "undo"]);
    const err = (await run({ file }).catch((e) => e)) as MontashError;
    const d = err.detail as unknown as BatchResultView;
    expect(d.lines[1]?.error?.code).toBe("E_BATCH_UNSUPPORTED");
    expect(d.lines[1]?.error?.hint).toContain("--continue-on-error");
    expect(await clipIds()).toEqual([]);
  });

  test("batch の入れ子は拒否する", async () => {
    const file = writeLines("nested.jsonl", ["batch other.jsonl"]);
    const err = (await run({ file }).catch((e) => e)) as MontashError;
    const d = err.detail as unknown as BatchResultView;
    expect(d.lines[0]?.error?.code).toBe("E_BATCH_UNSUPPORTED");
  });

  test("-m でバッチ全体を 1 コミットにする（行の -m は無視して警告）", async () => {
    const file = writeLines("commit.jsonl", [
      ADD(0, 30),
      'clip add --asset a --in f:30 --duration f:30 --at end -m "行のコミット"',
    ]);
    const res = await run({ file }, { message: "冒頭 2 カットを並べる", body: "指示: 並べて" });
    expect(res.op).toBe("o_0002");
    expect(res.commit).toBe("k_0001");
    expect(res.head?.pending).toBe(0);
    expect(res.warnings?.map((w) => w.code)).toContain("W_BATCH_MESSAGE_IGNORED");
    const commits = await (await History.open(dir)).commits();
    expect(commits[0]?.message).toBe("冒頭 2 カットを並べる");
    expect(commits[0]?.ops).toEqual(["o_0001", "o_0002"]);
  });

  test("--dry-run は解決したコマンドを返すだけで何も書かない", async () => {
    const file = writeLines("plan.jsonl", [ADD(0, 30), "clip add --asset a --at end"]);
    const res = await run({ file }, { dryRun: true });
    const v = view(res);
    expect(v.dry_run).toBe(true);
    expect(v.lines.map((l) => l.command)).toEqual(["clip add", "clip add"]);
    expect(res.op).toBeNull();
    expect(await clipIds()).toEqual([]);
    expect(await opIds()).toEqual(["o_0001"]);
  });

  test("--dry-run でも打ち間違いは E_BATCH_FAILED で報告する", async () => {
    const file = writeLines("typo.jsonl", ["clip add --asset a --at end", "clip nope"]);
    const err = (await run({ file }, { dryRun: true }).catch((e) => e)) as MontashError;
    expect(err.code).toBe("E_BATCH_FAILED");
    const d = err.detail as unknown as BatchResultView;
    expect(d.lines[1]?.error?.code).toBe("E_USAGE");
    expect(await opIds()).toEqual(["o_0001"]);
  });
});

describe("batch --continue-on-error / --no-atomic", () => {
  beforeEach(async () => {
    await setup();
  });

  test("失敗を飛ばして先へ進み、各行が通常どおり op を積む", async () => {
    const file = writeLines("mixed.jsonl", [ADD(0, 30), "clip delete nope", ADD(60, 30)]);
    const res = await run({ file, atomic: false, continueOnError: true });

    const v = view(res);
    expect(v.mode).toBe("continue-on-error");
    expect([v.succeeded, v.failed, v.skipped]).toEqual([2, 1, 0]);
    expect(v.rolled_back).toBe(false);
    expect(v.lines.map((l) => l.status)).toEqual(["ok", "failed", "ok"]);
    // 行ごとに op が積まれる（バッチ全体の op は作らない）
    expect(v.lines.map((l) => l.op ?? null)).toEqual(["o_0002", null, "o_0003"]);
    expect(res.op).toBeNull();
    expect(res.exitCode).toBe(1);
    expect(await opIds()).toEqual(["o_0001", "o_0002", "o_0003"]);
  });

  test("--no-atomic（--continue-on-error 無し）は失敗した行で止まり、適用済みは残す", async () => {
    const file = writeLines("stop.jsonl", [ADD(0, 30), "clip delete nope", ADD(60, 30)]);
    const res = await run({ file, atomic: false });
    const v = view(res);
    expect(v.lines.map((l) => l.status)).toEqual(["ok", "failed", "skipped"]);
    expect(res.exitCode).toBe(1);
    expect(await opIds()).toEqual(["o_0001", "o_0002"]);
  });

  test("--atomic と --continue-on-error の同時指定は E_USAGE", async () => {
    const file = writeLines("conflict.jsonl", [ADD(0, 30)]);
    const err = (await run({ file, continueOnError: true }, {}, [
      "batch",
      file,
      "--atomic",
      "--continue-on-error",
    ]).catch((e) => e)) as MontashError;
    expect(err.code).toBe("E_USAGE");
    expect(err.message).toContain("mutually exclusive");
  });

  test("読めないファイルは E_IO", async () => {
    const err = (await run({ file: join(dir, "missing.jsonl") }).catch((e) => e)) as MontashError;
    expect(err.code).toBe("E_IO");
    expect(err.hint).toContain("stdin");
  });
});
