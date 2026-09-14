/**
 * コマンドレジストリ。新しいコマンドはここに 1 行追加する（docs/04 の順に並べる）。
 * 各コマンドは defineCommand() で定義し、1 ファイル 1〜数コマンド。
 */
import type { CommandSpec } from "../define-command.ts";
import { assetsList, assetsShow } from "./assets.ts";
import { checkout } from "./checkout.ts";
import { clipAdd, clipList } from "./clip.ts";
import { commit } from "./commit.ts";
import { diff } from "./diff.ts";
import { doctor } from "./doctor.ts";
import { historyExport, historyImport, historyPrune, historyVerify } from "./history.ts";
import { idsRebuild } from "./ids.ts";
import { importAssets } from "./import.ts";
import { init } from "./init.ts";
import { log } from "./log.ts";
import { projectSet, projectShow } from "./project.ts";
import { proxyBuild, proxyStatus } from "./proxy.ts";
import { redo } from "./redo.ts";
import { render, renderPresets, renderVerify } from "./render.ts";
import { schema } from "./schema.ts";
import { serve } from "./serve.ts";
import { show } from "./show.ts";
import { status } from "./status.ts";
import { tag, tagDelete, tagList } from "./tag.ts";
import { timelineShow } from "./timeline.ts";
import { undo } from "./undo.ts";
import { validate } from "./validate.ts";

// 各コマンドは固有の Args 型を持つため、レジストリでは共通型に寄せる（実行時は yargs が引数を検証する）
type AnySpec = CommandSpec<Record<string, unknown>>;
// biome-ignore lint/suspicious/noExplicitAny: 各コマンド固有の Args 型を共通型に寄せる（実行時は yargs が検証）
const spec = (s: CommandSpec<never> | CommandSpec<any>): AnySpec => s as unknown as AnySpec;

export const commands: ReadonlyArray<AnySpec> = [
  // 環境・メタ
  spec(doctor),
  spec(schema),
  // プロジェクト
  spec(init),
  spec(projectShow),
  spec(projectSet),
  spec(validate),
  spec(importAssets),
  spec(assetsList),
  spec(assetsShow),
  spec(proxyBuild),
  spec(proxyStatus),
  spec(clipAdd),
  spec(clipList),
  spec(timelineShow),
  // 素材管理・トラック操作・クリップ移動/トリム → M2/M3
  // トランジション / テキスト / オーバーレイ / 音声 / 字幕             → M3/M4
  // プレビュー: serve, preview *                                      → M2
  spec(serve),
  spec(render),
  spec(renderVerify),
  spec(renderPresets),
  // 履歴: blame, revert, reset → M4
  spec(status),
  spec(log),
  spec(show),
  spec(diff),
  spec(commit),
  spec(checkout),
  spec(undo),
  spec(redo),
  spec(tag),
  spec(tagList),
  spec(tagDelete),
  spec(historyVerify),
  spec(historyPrune),
  spec(historyExport),
  spec(historyImport),
  spec(idsRebuild),
  // AI 支援: batch, explain                                           → M4
];
