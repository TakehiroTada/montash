/**
 * コマンドレジストリ。新しいコマンドはここに 1 行追加する（docs/04 の順に並べる）。
 * 各コマンドは defineCommand() で定義し、1 ファイル 1〜数コマンド。
 */
import type { CommandSpec } from "../define-command.ts";
import { doctor } from "./doctor.ts";
import { schema } from "./schema.ts";

// 各コマンドは固有の Args 型を持つため、レジストリでは共通型に寄せる（実行時は yargs が引数を検証する）
type AnySpec = CommandSpec<Record<string, unknown>>;
const spec = (s: CommandSpec<never> | CommandSpec<any>): AnySpec => s as unknown as AnySpec; // eslint-disable-line @typescript-eslint/no-explicit-any

export const commands: ReadonlyArray<AnySpec> = [
  // 環境・メタ
  spec(doctor),
  spec(schema),
  // プロジェクト: init, project show, project set, validate, diff  → M0/M1
  // アセット: import, assets *, proxy *, fonts list                 → M1/M3
  // トラック / クリップ / タイムライン                                 → M1/M2
  // トランジション / テキスト / オーバーレイ / 音声 / 字幕             → M3/M4
  // プレビュー: serve, preview *                                      → M2
  // 出力: render *                                                    → M1
  // 履歴: status, log, show, diff, blame, commit, checkout, undo, redo, revert, reset, tag, history *, ids rebuild → M1/M4
  // AI 支援: batch, explain                                           → M4
];
