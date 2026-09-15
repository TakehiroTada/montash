/**
 * クリップの生成と配置（docs/04 §6 `clip add`、§10 `overlay add`、docs/05 §6.1）。
 *
 * 「アセットを 1 本トラックに置く」手続きは `clip add` と `overlay add`（と将来の
 * `text add` / `subtitle add` の一部）で共通なので、ここに 1 つだけ置く。
 * 引数の解釈（時間表記・スタイル・アセット種別の妥当性）は cli/commands/ 側、
 * 「どこに何を足すか」だけがここの責務。
 *
 * 不変条件（docs/05 §14）:
 * - 映像クリップと音声クリップの `link` は常に相互参照で、`start_f` と尺が一致する。
 * - `clips` は `start_f` 昇順（docs/05 §6）。
 *
 * ID 採番（`.montash/ids.json`）は I/O なので、ここでは採番関数 `IdAllocator` を引数で受け取り、
 * core を純粋なまま保つ（ADR-13）。
 */
import type { z } from "zod";
import { errors, MontashError } from "../cli/errors.ts";
import { assertIdAvailable } from "./ids.ts";
import {
  type Clip,
  type ClipAudioSchema,
  ClipSchema,
  type ClipVideoSchema,
  type Project,
  type Track,
} from "./schema.ts";
import { assertPlacement, counterpartTrackId, requireTrack } from "./timeline.ts";

/** `video` / `audio` ブロックの初期値（zod のデフォルト適用前の形） */
export type ClipVideoInput = z.input<typeof ClipVideoSchema>;
export type ClipAudioInput = z.input<typeof ClipAudioSchema>;

/** 次の要素 ID を 1 つ発行する。`.montash/ids.json` を触るので呼び出し側が用意する */
export type IdAllocator = () => string | Promise<string>;

export interface AddClipInput {
  /** 参照するアセット ID */
  asset: string;
  /** 配置先トラック（存在しない場合は呼び出し側が用意する） */
  track: Track;
  /** タイムライン上の開始フレーム */
  start_f: number;
  /** ソースの in / out（フレーム）。尺は `out_f - in_f`（speed は既定の 1） */
  in_f: number;
  out_f: number;
  /** 明示 ID。省略時は `allocate()` で採番する */
  id?: string | undefined;
  label?: string | undefined;
  /** 音声のみのクリップとして置く（`video` ではなく `audio` ブロックを持つ） */
  audioOnly?: boolean;
  /** 対応する音声トラック（V1 → A1）にリンク音声クリップを作る */
  linkAudio?: boolean;
  /** 映像ブロックの初期値（overlay の transform / opacity / keep_alpha など） */
  video?: ClipVideoInput;
  /** 音声ブロックの初期値 */
  audio?: ClipAudioInput;
}

export interface AddClipResult {
  /** 追加した主クリップ */
  clip: Clip;
  /** 同時に作ったリンク音声クリップ（作らなかった場合は null） */
  linked: Clip | null;
  /** `linked` を置いたトラック */
  linkedTrack: Track | null;
}

/**
 * `in_f` / `out_f` がソースの範囲に収まっているか（docs/04 §1.7 `E_RANGE_OUT_OF_ASSET`）。
 * `limitF` が undefined のアセット（画像・尺不明）は上限なし。
 */
export function assertSourceRange(inF: number, outF: number, limitF: number | undefined): void {
  if (outF <= inF || (limitF !== undefined && outF > limitF))
    throw new MontashError("E_RANGE_OUT_OF_ASSET", `invalid source range f:${inF}..f:${outF}`, {
      hint: `Choose 0 <= in < out${limitF === undefined ? "" : ` <= f:${limitF}`}.`,
    });
}

/** `start_f` 昇順に並べ直す（docs/05 §6: clips は start_f 昇順） */
function sortTrackClips(track: Track): void {
  track.clips.sort((a, b) => a.start_f - b.start_f);
}

/**
 * クリップを 1 本（必要ならリンク音声と 2 本）作ってトラックに置く。
 *
 * 順序は `clip add` の既存実装をそのまま保つ:
 * リンク先トラックの解決 → 重なり検査（主 → リンク） → `--id` の重複検査 → 採番 → 生成 → 追加。
 * 重なりがあれば `E_CLIP_OVERLAP`、ロックされたトラックなら `E_TRACK_LOCKED`（`assertPlacement`）。
 */
export async function addClip(project: Project, input: AddClipInput, allocate: IdAllocator): Promise<AddClipResult> {
  const track = input.track;
  const startF = input.start_f;
  const endF = startF + (input.out_f - input.in_f);

  const linkedTrack = input.linkAudio ? requireTrack(project, counterpartTrackId(track.id, "video")) : null;
  if (linkedTrack && linkedTrack.kind !== "audio") throw errors.usage("linked track must be audio");

  assertPlacement(track, startF, endF);
  if (linkedTrack) assertPlacement(linkedTrack, startF, endF);
  if (input.id !== undefined) assertIdAvailable(project, input.id);

  const clip = ClipSchema.parse({
    id: input.id ?? (await allocate()),
    asset: input.asset,
    start_f: startF,
    in_f: input.in_f,
    out_f: input.out_f,
    label: input.label,
    ...(input.audioOnly ? { audio: input.audio ?? {} } : { video: input.video ?? {} }),
  });

  const linked = linkedTrack
    ? ClipSchema.parse({
        id: await allocate(),
        asset: input.asset,
        start_f: startF,
        in_f: input.in_f,
        out_f: input.out_f,
        link: clip.id,
        audio: {},
      })
    : null;
  if (linked && linkedTrack) {
    // link は常に相互参照（docs/05 §14.6）
    clip.link = linked.id;
    linkedTrack.clips.push(linked);
    sortTrackClips(linkedTrack);
  }
  track.clips.push(clip);
  sortTrackClips(track);
  return { clip, linked, linkedTrack };
}
