/**
 * コマンドレジストリ。新しいコマンドはここに 1 行追加する（docs/04 の順に並べる）。
 * 各コマンドは defineCommand() で定義し、1 ファイル 1〜数コマンド。
 */
import type { CommandSpec } from "../define-command.ts";
import {
  assetsList,
  assetsNewText,
  assetsRelink,
  assetsRemove,
  assetsSet,
  assetsSetText,
  assetsShow,
} from "./assets.ts";
import {
  audioAnalyze,
  audioDuck,
  audioDuckRemove,
  audioFade,
  audioGain,
  audioNormalize,
  audioOffset,
  audioShow,
} from "./audio.ts";
import { blame } from "./blame.ts";
import { checkout } from "./checkout.ts";
import { clipAdd, clipList } from "./clip.ts";
import { clipDelete, clipMove, clipSet, clipSplit, clipTrim } from "./clip-edit.ts";
import { commit } from "./commit.ts";
import { diff } from "./diff.ts";
import { doctor } from "./doctor.ts";
import { fade } from "./fade.ts";
import { fontsList } from "./fonts.ts";
import { help } from "./help.ts";
import { historyExport, historyImport, historyPrune, historyVerify } from "./history.ts";
import { idsRebuild } from "./ids.ts";
import { importAssets } from "./import.ts";
import { init } from "./init.ts";
import { log } from "./log.ts";
import { overlayAdd, overlayList, overlayRemove, overlaySet } from "./overlay.ts";
import { previewBuild, previewStatus } from "./preview.ts";
import { projectSet, projectShow } from "./project.ts";
import { proxyBuild, proxyStatus } from "./proxy.ts";
import { redo } from "./redo.ts";
import { render, renderAudio, renderBatch, renderGif, renderPresets, renderStill, renderVerify } from "./render.ts";
import { reset } from "./reset.ts";
import { revert } from "./revert.ts";
import { schema } from "./schema.ts";
import { serve } from "./serve.ts";
import { show } from "./show.ts";
import { status } from "./status.ts";
import { subtitleAdd, subtitleList, subtitleRemove, subtitleSet } from "./subtitle.ts";
import { tag, tagDelete, tagList } from "./tag.ts";
import { textAdd, textList, textPresets, textRemove, textSet } from "./text.ts";
import { timelineGaps, timelineShow } from "./timeline.ts";
import { trackAdd, trackList, trackLock, trackMove, trackMute, trackRemove } from "./track.ts";
import { transitionAdd, transitionList, transitionRemove, transitionSet } from "./transition.ts";
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
  spec(help),
  // プロジェクト
  spec(init),
  spec(projectShow),
  spec(projectSet),
  spec(validate),
  spec(importAssets),
  spec(assetsList),
  spec(assetsShow),
  spec(assetsSet),
  spec(assetsNewText),
  spec(assetsSetText),
  spec(assetsRemove),
  spec(assetsRelink),
  spec(proxyBuild),
  spec(proxyStatus),
  spec(fontsList),
  // トラック（docs/04 §5）
  spec(trackAdd),
  spec(trackList),
  spec(trackRemove),
  spec(trackMute),
  spec(trackLock),
  spec(trackMove),
  // クリップ（docs/04 §6）
  spec(clipAdd),
  spec(clipList),
  spec(clipMove),
  spec(clipTrim),
  spec(clipSplit),
  spec(clipDelete),
  spec(clipSet),
  // タイムライン（docs/04 §7）
  spec(timelineShow),
  spec(timelineGaps),
  // トランジション・フェード（docs/04 §8）
  spec(transitionAdd),
  spec(transitionSet),
  spec(transitionRemove),
  spec(transitionList),
  spec(fade),
  // テキスト（docs/04 §9）
  spec(textAdd),
  spec(textSet),
  spec(textRemove),
  spec(textList),
  spec(textPresets),
  // オーバーレイ（docs/04 §10）
  spec(overlayAdd),
  spec(overlaySet),
  spec(overlayRemove),
  spec(overlayList),
  // 字幕（docs/04 §12）
  spec(subtitleAdd),
  spec(subtitleSet),
  spec(subtitleRemove),
  spec(subtitleList),
  // 音声（docs/04 §11）
  spec(audioGain),
  spec(audioFade),
  spec(audioDuck),
  spec(audioDuckRemove),
  spec(audioNormalize),
  spec(audioOffset),
  spec(audioAnalyze),
  spec(audioShow),
  // プレビュー: serve, preview *                                      → M2
  spec(serve),
  spec(previewBuild),
  spec(previewStatus),
  spec(render),
  spec(renderVerify),
  spec(renderPresets),
  spec(renderBatch),
  spec(renderStill),
  spec(renderGif),
  spec(renderAudio),
  // 履歴（docs/04 §15）
  spec(status),
  spec(log),
  spec(show),
  spec(diff),
  spec(blame),
  spec(commit),
  spec(checkout),
  spec(undo),
  spec(redo),
  spec(revert),
  spec(reset),
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
