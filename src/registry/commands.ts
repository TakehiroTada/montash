/**
 * コマンド宣言の合成（docs/08 §2 §5, docs/13 D-18 / 計画 P0-6）。
 *
 * 組み込みコマンド（`cli/commands/registry.ts` の静的配列）と、実行時に `registerCommand()` で
 * 登録されたコマンドを合成して 1 本のリストにする。`cli/index.ts`（yargs 登録）・`montash schema`・
 * `montash help` の 3 者がすべてこの `getCommands()` を通るので、追加したコマンドが
 * 「実行はできるが schema / help に出ない」という取りこぼしが起きない。
 *
 * **組み込み配列は静的 import しない。** `cli/commands/registry.ts` は `schema.ts` / `help.ts` を
 * import しており、その 2 つがこのモジュールを import するため、静的に結ぶと循環する。
 * 組み込みの読み込みだけを `await import()` に閉じ込め、`getCommands()` を async にしている
 * （`buildCli()` が async なのはこのため）。
 */
import { buildCommandTree, type CommandSpec } from "../cli/define-command.ts";
import { type FeatureRequirements, registerRequirements, unregisterRequirements } from "./requirements.ts";

/** 各コマンドは固有の Args 型を持つため、レジストリでは共通型に寄せる（実行時は yargs が検証する） */
export type AnyCommandSpec = CommandSpec<Record<string, unknown>>;

/** 供給元（docs/plans/2026-09-15-plugin-architecture.md）。今は builtin と、口だけ開けた 2 種 */
export type CommandSource = "builtin" | "project" | "plugin";

export interface RegisterCommandOptions {
  /** 供給元ラベル（既定: "plugin"） */
  source?: CommandSource;
  /** このコマンドが必要とする ffmpeg 機能。`doctor` の検査対象に合成される */
  requires?: FeatureRequirements;
  /** 供給元がプラグインならその ID（衝突を報告するときに「誰が取ったか」を言うため） */
  plugin?: string;
}

export interface CommandRegistration {
  spec: AnyCommandSpec;
  source: CommandSource;
  /** 供給元がプラグインならその ID */
  plugin?: string;
}

const registered = new Map<string, CommandRegistration>();

const requirementsId = (path: string) => `command:${path}`;

/**
 * 実行時にコマンドを 1 つ足す。同じパスの再登録は上書きする（組み込みと衝突する場合は
 * `getCommands()` が `duplicate command path` で弾く）。
 */
export function registerCommand(spec: AnyCommandSpec, opts: RegisterCommandOptions = {}): void {
  registered.set(spec.path, {
    spec,
    source: opts.source ?? "plugin",
    ...(opts.plugin !== undefined ? { plugin: opts.plugin } : {}),
  });
  if (opts.requires) registerRequirements(requirementsId(spec.path), opts.requires);
}

export function unregisterCommand(path: string): void {
  registered.delete(path);
  unregisterRequirements(requirementsId(path));
}

/** テスト用。実行時登録をすべて捨てる（組み込みには触らない） */
export function clearRegisteredCommands(): void {
  for (const path of [...registered.keys()]) unregisterCommand(path);
}

export function registeredCommands(): readonly CommandRegistration[] {
  return [...registered.values()];
}

/** 組み込みコマンド（順序は docs/04 の並び）。循環 import を避けるため遅延 import する */
async function builtinCommands(): Promise<readonly AnyCommandSpec[]> {
  const { commands } = await import("../cli/commands/registry.ts");
  return commands;
}

/**
 * 組み込みコマンドのパス集合。プラグインが組み込みを乗っ取っていないかを**登録の時点で**
 * 確かめるために使う（`getCommands()` まで待つと、どのプラグインが原因か分かりにくい）。
 *
 * `plugins/loader.ts` からはここを経由して読む。`cli/commands/registry.ts` を直接 import すると
 * `registry.ts → plugin.ts → plugins/loader.ts` の循環になるため。
 */
export async function builtinCommandPaths(): Promise<ReadonlySet<string>> {
  return new Set((await builtinCommands()).map((c) => c.path));
}

/**
 * 組み込み + 実行時登録の合成リスト。組み込みの並びは保ったまま、登録順に後ろへ足す。
 * 重複パスはここで検出する（yargs へ登録する前に落としたいので `buildCommandTree` を通す）。
 */
/**
 * 組み込みコマンドのうち、**オプションが実行時の登録内容で決まる**ものを作り直すためのフック。
 *
 * `effect add` / `effect set` の引数は「登録済みエフェクトのパラメータの和集合」なので、
 * モジュール読み込み時に固めてしまうと**プラグインが登録したエフェクトのパラメータが載らない**
 * （ドッグフーディングで実際に踏んだ: `effect add c2 denoise --amount 10` が
 * `Unknown arguments: amount` になった）。プラグインのロードは `getCommands()` より前に
 * 済んでいるので、ここで作り直せば schema / help / yargs の 3 者すべてに反映される。
 */
const rebuilders = new Map<string, () => AnyCommandSpec>();

export function registerSpecRebuilder(path: string, rebuild: () => AnyCommandSpec): void {
  rebuilders.set(path, rebuild);
}

export async function getCommands(): Promise<readonly AnyCommandSpec[]> {
  const specs: AnyCommandSpec[] = (await builtinCommands()).map((spec) => {
    const rebuild = rebuilders.get(spec.path);
    return rebuild ? rebuild() : spec;
  });
  for (const reg of registered.values()) specs.push(reg.spec);
  buildCommandTree(specs); // duplicate command path の検出
  return specs;
}
