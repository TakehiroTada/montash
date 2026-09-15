/**
 * `montash explain (<id> | timeline | render) [--json]`（docs/04 §16、docs/02 F-AI-4、docs/10）。
 *
 * 読み手は **AI と人間の両方**。同じ内容を 2 つの形で返す:
 *   - `explanation`: 1 読で分かる自然言語（英語）の文。`--json` でも同じ文が入る。
 *   - `facts`: 機械可読な事実（`_f` と秒を併記。docs/04 §1.3a）。
 *
 * ここは **説明だけ** を組み立てる層で、派生値は一切計算し直さない:
 *   - クリップの尺・終端      → `core/schema.ts` の `clipDurationF` / `clipEndF` / `clipKind`
 *   - クリップ 1 件の表示形   → `cli/commands/clip.ts` の `describeClip()`
 *   - 字幕の占める区間        → `server/computed.ts` の `subtitleSpanF()`
 *   - アセットの使用箇所      → `core/assets.ts` の `assetUsage()`
 *   - タイムライン要約        → `cli/commands/project.ts` の `timelineSummary()`
 *   - トランジションのハンドル → `core/validate.ts` の `handleExtension()`
 *   - 掛かっている効果        → `cli/commands/effect.ts` の `effect list` ハンドラをそのまま呼ぶ
 *   - レンダーのコマンド      → `ffmpeg/render.ts` の `buildRenderPlan()`（`render --dry-run` と同じ経路）
 *
 * プラグインが無くて解釈できないもの（`kind: "opaque"` のクリップ、未登録の効果・ジェネレータ）は
 * 「保存はできるがレンダーできない」ことを文章に含める（F-EXT-4、docs/05 §6.1a）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assetUsage, clipCount } from "../../core/assets.ts";
import { findClipOrNull } from "../../core/clip-editing.ts";
import { loadProject } from "../../core/project.ts";
import {
  type Asset,
  type Clip,
  clipDurationF,
  clipEndF,
  clipKind,
  type Ducking,
  type Fps,
  type GeneratorClip,
  type OpaqueClip,
  type Project,
  type SubtitleClip,
  type TextClip,
  type Track,
  type TrackClip,
  type Transition,
} from "../../core/schema.ts";
import { framesToSeconds, framesToTimecode } from "../../core/time.ts";
import { trackEnd } from "../../core/timeline.ts";
import { findVideoGaps, handleExtension, resolveAssetPath } from "../../core/validate.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { prepareAudio } from "../../ffmpeg/loudnorm.ts";
import { resolvePresets } from "../../ffmpeg/presets.ts";
import { buildRenderPlan, type RenderPlan } from "../../ffmpeg/render.ts";
import { shellQuote } from "../../ffmpeg/run.ts";
import { generators } from "../../registry/generators.ts";
import { subtitleSpanF } from "../../server/computed.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { MontashError } from "../errors.ts";
import { describeClip } from "./clip.ts";
import { effectList } from "./effect.ts";
import { timelineSummary } from "./project.ts";

// ---------------------------------------------------------------------------
// 説明の共通形
// ---------------------------------------------------------------------------

/** 説明 1 件。`explanation` が自然言語、`facts` が機械可読（F-AI-4 の「自然言語＋JSON」） */
interface Explanation {
  target: string;
  /** 要素の分類（clip / transition / track / asset / ducking / timeline / render） */
  kind: string;
  /** より細かい種別（media / text / subtitle / generator / opaque / video / audio ...） */
  subtype?: string;
  headline: string;
  explanation: string[];
  facts: Record<string, unknown>;
  /** 解釈できないもの・注意すべき状態（プラグイン不足、ロック、ファイル欠落） */
  notes: string[];
  see_also: string[];
}

const sec = (f: number, fps: Fps): string => `${framesToSeconds(f, fps).toFixed(3)}s`;
/** 1 点の時刻: `12.500s (f:375)` */
const point = (f: number, fps: Fps): string => `${sec(f, fps)} (f:${f})`;
/** 区間: `12.500s..32.500s (f:375..f:975)` */
const span = (a: number, b: number, fps: Fps): string => `${sec(a, fps)}..${sec(b, fps)} (f:${a}..f:${b})`;
const frames = (f: number): string => `${f} frame${f === 1 ? "" : "s"}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** 時刻の 3 表記（`_f` / 秒 / タイムコード。docs/04 §1.3a） */
const timeFacts = (f: number, fps: Fps) => ({ f, seconds: framesToSeconds(f, fps), tc: framesToTimecode(f, fps) });

const quote = (s: string, max = 60): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return JSON.stringify([...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat);
};

/** `saturation=1.2 brightness=0.05` のようなパラメータ列 */
function paramList(params: Record<string, unknown> | undefined): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

function fpsText(fps: Fps): string {
  return fps.den === 1 ? `${fps.num} fps` : `${(fps.num / fps.den).toFixed(3)} fps (${fps.num}/${fps.den})`;
}

// ---------------------------------------------------------------------------
// 効果（`montash effect list` の結果をそのまま使う）
// ---------------------------------------------------------------------------

interface EffectView {
  index: number;
  type: string;
  params: Record<string, unknown>;
  summary?: string;
  missing?: true;
}

/** `effect list` ハンドラを呼んで、掛かっている効果を文章と facts にする */
async function effectSection(
  ctx: CommandContext,
  clipId: string,
  out: Explanation,
): Promise<ReadonlyArray<EffectView>> {
  const res = await effectList.handler(ctx, { clip: clipId });
  const { effects } = res.result as { effects: EffectView[] };
  out.facts.effects = effects;
  if (effects.length === 0) {
    out.explanation.push("No effect is applied to it.");
    return effects;
  }
  const described = effects.map((e) => {
    const params = paramList(e.params);
    return `${e.type}${params ? ` (${params})` : ""}`;
  });
  out.explanation.push(
    `${plural(effects.length, "effect")} ${effects.length === 1 ? "is" : "are"} applied, in order: ${described.join(", ")}.`,
  );
  for (const e of effects) {
    if (e.missing)
      out.notes.push(
        `The effect "${e.type}" is not registered here, so no plugin provides it: the project keeps it, but rendering fails with E_PLUGIN_MISSING until the plugin is installed (F-EXT-4).`,
      );
  }
  out.see_also.push(`montash effect list ${clipId} --json`);
  return effects;
}

// ---------------------------------------------------------------------------
// クリップ
// ---------------------------------------------------------------------------

/** そのクリップに入る／出るトランジション */
function transitionsAround(project: Project, clipId: string): { incoming: Transition[]; outgoing: Transition[] } {
  return {
    incoming: project.transitions.filter((t) => t.to === clipId),
    outgoing: project.transitions.filter((t) => t.from === clipId),
  };
}

function transitionPhrase(t: Transition, fps: Fps): string {
  return `${t.id} (${t.type}, ${sec(t.duration_f, fps)}, ${t.mode} mode, audio ${t.audio})`;
}

function describeMediaClip(dir: string, project: Project, clip: Clip, track: Track, out: Explanation): void {
  const fps = project.settings.fps;
  const asset = project.assets[clip.asset];
  const durationF = clipDurationF(clip);
  const endF = clipEndF(clip);
  const sourceF = clip.out_f - clip.in_f;

  const assetText = asset
    ? `${asset.id} (${asset.type}${asset.duration_f != null ? `, ${sec(asset.duration_f, fps)} long` : ""})`
    : `${clip.asset} (missing from the project)`;
  out.explanation.push(
    `${clip.id} takes ${span(clip.in_f, clip.out_f, fps)} of asset ${assetText} and places it on track ${track.id} at ${span(clip.start_f, endF, fps)}, ${frames(durationF)} long.`,
  );
  if (clip.speed !== 1)
    out.explanation.push(
      `Playback speed is ${clip.speed}x${clip.pitch_keep ? " with the pitch kept" : ""}, so ${frames(sourceF)} of source become ${frames(durationF)} on the timeline.`,
    );
  if (clip.loop) out.explanation.push("The clip loops to fill its length (`loop: true`).");
  if (clip.link !== null)
    out.explanation.push(
      `Its counterpart clip ${clip.link} is linked to it, so moves, trims and splits apply to both.`,
    );

  const video = clip.video;
  if (video?.transform) {
    const tf = video.transform;
    const where = tf.position ?? `x=${String(tf.x)}, y=${String(tf.y)}`;
    out.explanation.push(
      `It is composited as an overlay: position ${where}, margin ${String(tf.margin)}, scale ${tf.scale}${tf.rotate ? `, rotated ${tf.rotate}°` : ""}, opacity ${video.opacity}.`,
    );
  } else if (video && video.opacity !== 1) {
    out.explanation.push(`It is drawn at opacity ${video.opacity}.`);
  }
  if (video?.crop) out.explanation.push(`The picture is cropped to ${paramList(video.crop)}.`);
  if (video?.color) out.explanation.push(`Colour is adjusted with ${paramList(video.color)}.`);
  if (video?.lut) out.explanation.push(`A 3D LUT is applied: ${video.lut}.`);
  if (video && (video.fade.in_f > 0 || video.fade.out_f > 0))
    out.explanation.push(
      `The picture fades ${fadePhrase(video.fade.in_f, video.fade.out_f, fps)} (colour ${video.fade.color}).`,
    );

  const audio = clip.audio;
  if (audio) {
    const parts: string[] = [];
    if (audio.muted) parts.push("muted");
    if (audio.gain_db !== 0) parts.push(`gain ${audio.gain_db > 0 ? "+" : ""}${audio.gain_db} dB`);
    if (audio.fade.in_f > 0 || audio.fade.out_f > 0)
      parts.push(`fades ${fadePhrase(audio.fade.in_f, audio.fade.out_f, fps)} (curve ${audio.fade.curve})`);
    if (audio.offset_smp !== 0) parts.push(`shifted by ${audio.offset_smp} samples for sync`);
    if (parts.length > 0) out.explanation.push(`Its audio is ${parts.join(", ")}.`);
  }

  if (asset) {
    const file = resolveAssetPath(dir, asset.path);
    if (!existsSync(file))
      out.notes.push(
        `The source file for ${asset.id} is missing at ${asset.path}: run \`montash assets relink ${asset.id} <path>\` before rendering.`,
      );
  } else {
    out.notes.push(`Asset "${clip.asset}" is not in the project any more, so this clip cannot be rendered.`);
  }

  out.facts = {
    ...out.facts,
    asset: clip.asset,
    source: { in: timeFacts(clip.in_f, fps), out: timeFacts(clip.out_f, fps), length_f: sourceF },
    speed: clip.speed,
    pitch_keep: clip.pitch_keep,
    loop: clip.loop,
    link: clip.link,
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
  };
  out.see_also.push(`montash clip list --track ${track.id} --json`);
  if (asset) out.see_also.push(`montash assets show ${asset.id} --json`);
}

function fadePhrase(inF: number, outF: number, fps: Fps): string {
  const parts: string[] = [];
  if (inF > 0) parts.push(`in over ${sec(inF, fps)}`);
  if (outF > 0) parts.push(`out over ${sec(outF, fps)}`);
  return parts.join(" and ");
}

function describeTextClip(clip: TextClip, track: Track, fps: Fps, out: Explanation): void {
  const body = clip.asset !== null ? `the text asset ${clip.asset}` : `the literal text ${quote(clip.text)}`;
  out.explanation.push(
    `${clip.id} draws ${body} on text track ${track.id} from ${point(clip.start_f, fps)} to ${point(clip.start_f + clip.duration_f, fps)}, ${frames(clip.duration_f)} long.`,
  );
  const style = clip.style;
  const styleParts: string[] = [];
  if (style.preset) styleParts.push(`preset ${style.preset}`);
  if (style.font) styleParts.push(`font ${style.font}`);
  if (style.size !== undefined) styleParts.push(`size ${style.size}`);
  if (style.color) styleParts.push(`colour ${style.color}`);
  if (style.position !== undefined)
    styleParts.push(`position ${typeof style.position === "string" ? style.position : paramList(style.position)}`);
  if (style.align) styleParts.push(`aligned ${style.align}`);
  if (style.bg) styleParts.push(`on a ${style.bg} box`);
  if (style.outline) styleParts.push(`outlined ${style.outline.width}px ${style.outline.color}`);
  out.explanation.push(
    styleParts.length > 0 ? `Its style is ${styleParts.join(", ")}.` : "It uses the project's default text style.",
  );
  if (clip.fade.in_f > 0 || clip.fade.out_f > 0)
    out.explanation.push(`It fades ${fadePhrase(clip.fade.in_f, clip.fade.out_f, fps)}.`);
  if (clip.markup === "ass") out.explanation.push("The body is ASS markup, so it is passed to libass as written.");

  out.facts = { ...out.facts, text: clip.text, asset: clip.asset, markup: clip.markup, style, fade: clip.fade };
  out.see_also.push("montash text list --json", "montash text presets");
}

function describeSubtitleClip(project: Project, dir: string, clip: SubtitleClip, track: Track, out: Explanation): void {
  const fps = project.settings.fps;
  const asset = project.assets[clip.asset];
  const format = asset && asset.type === "subtitle" ? (asset.format ?? "unknown") : "unknown";
  out.explanation.push(
    `${clip.id} attaches the subtitle asset ${clip.asset} (${format}) to text track ${track.id} in "${clip.mode}" mode, anchored at ${point(clip.start_f, fps)}${clip.offset_f === 0 ? "" : ` with a ${clip.offset_f >= 0 ? "+" : ""}${sec(clip.offset_f, fps)} offset`}.`,
  );
  out.explanation.push(
    clip.mode === "burn"
      ? "The cues are burned into the picture, so they are part of the video and cannot be turned off by the viewer."
      : "The cues are muxed as a soft subtitle stream, so the player can turn them on and off (containers that cannot carry subtitles drop them with W_SUBTITLE_SKIPPED).",
  );
  // 字幕クリップは尺を持たない（素材が尺を決める）。区間の算出は server/computed.ts を使う
  const source = readSubtitleSource(dir, asset);
  const cueSpan = source === null ? null : subtitleSpanF(source, fps);
  if (cueSpan) {
    const start = Math.max(0, clip.start_f + clip.offset_f + cueSpan.start_f);
    const end = Math.max(start + 1, clip.start_f + clip.offset_f + cueSpan.end_f);
    out.explanation.push(
      `The clip itself carries no length; the file does. Its cues cover ${span(start, end, fps)} on the timeline.`,
    );
    out.facts.cue_span = { start: timeFacts(start, fps), end: timeFacts(end, fps) };
  } else {
    out.explanation.push(
      "The clip itself carries no length; the subtitle file decides how long the cues run, and this one could not be read here.",
    );
  }
  out.facts = { ...out.facts, asset: clip.asset, mode: clip.mode, format, offset_f: clip.offset_f, style: clip.style };
  out.see_also.push("montash subtitle list --json");
}

function readSubtitleSource(dir: string, asset: Asset | undefined): string | null {
  if (!asset) return null;
  try {
    return readFileSync(resolveAssetPath(dir, asset.path), "utf8");
  } catch {
    return null;
  }
}

function describeGeneratorClip(clip: GeneratorClip, track: Track, fps: Fps, out: Explanation): void {
  const spec = generators.get(clip.generator);
  const params = paramList(clip.params);
  out.explanation.push(
    `${clip.id} is a generated clip: it synthesises "${clip.generator}"${params ? ` (${params})` : ""} on track ${track.id} from ${point(clip.start_f, fps)} to ${point(clip.start_f + clip.duration_f, fps)}, ${frames(clip.duration_f)} long. It reads no asset.`,
  );
  if (spec) out.explanation.push(`The "${clip.generator}" generator is registered here: ${spec.summary}.`);
  else
    out.notes.push(
      `No registered generator is named "${clip.generator}", so no plugin provides it: the project loads and saves fine, but rendering fails with E_PLUGIN_MISSING (F-EXT-4).`,
    );
  out.facts = { ...out.facts, generator: clip.generator, params: clip.params, generator_registered: Boolean(spec) };
}

function describeOpaqueClip(clip: OpaqueClip, track: Track, fps: Fps, out: Explanation): void {
  out.explanation.push(
    `${clip.id} has the clip type "${clip.type}", which this build does not know, so montash cannot say what it shows.`,
  );
  out.explanation.push(
    `All that is readable is its place on the timeline: track ${track.id}, ${span(clip.start_f, clip.start_f + clip.duration_f, fps)}, ${frames(clip.duration_f)} long. Every other field is kept exactly as written.`,
  );
  out.notes.push(
    `The plugin that supplies clip type "${clip.type}" is missing. Loading, editing around it and saving all work; only rendering fails, with E_PLUGIN_MISSING (F-EXT-4, docs/05 §6.1a). Run \`montash plugin doctor\` to see what the project asks for.`,
  );
  out.facts = { ...out.facts, clip_type: clip.type, interpretable: false };
  out.see_also.push("montash plugin doctor --json", "montash plugin list --json");
}

/** クリップの説明（種別ごとに分岐）。`describeClip()` の派生値をそのまま facts に載せる */
async function explainClip(
  ctx: CommandContext,
  dir: string,
  project: Project,
  track: Track,
  clip: TrackClip,
  index: number,
): Promise<Explanation> {
  const fps = project.settings.fps;
  const kind = clipKind(clip);
  const out: Explanation = {
    target: clip.id,
    kind: "clip",
    subtype: kind,
    headline: `${clip.id} — ${kind} clip on track ${track.id} (${track.kind})`,
    explanation: [],
    facts: { clip: describeClip(clip, track.id, index, fps), track: track.id, track_kind: track.kind, kind },
    notes: [],
    see_also: [],
  };

  switch (kind) {
    case "media":
      describeMediaClip(dir, project, clip as Clip, track, out);
      break;
    case "text":
      describeTextClip(clip as TextClip, track, fps, out);
      break;
    case "subtitle":
      describeSubtitleClip(project, dir, clip as SubtitleClip, track, out);
      break;
    case "generator":
      describeGeneratorClip(clip as GeneratorClip, track, fps, out);
      break;
    case "opaque":
      describeOpaqueClip(clip as OpaqueClip, track, fps, out);
      break;
  }

  const { incoming, outgoing } = transitionsAround(project, clip.id);
  const around: string[] = [];
  for (const t of incoming) around.push(`${transitionPhrase(t, fps)} runs into it from ${t.from}`);
  for (const t of outgoing) around.push(`${transitionPhrase(t, fps)} runs out of it into ${t.to}`);
  if (around.length > 0) out.explanation.push(`${around.join("; ")}.`);
  out.facts.transitions = { incoming, outgoing };

  // opaque クリップの `effects[]` も読めるので、種別を問わず効果を説明する
  await effectSection(ctx, clip.id, out);

  if (track.muted)
    out.notes.push(`Track ${track.id} is muted, so this clip is ${track.kind === "audio" ? "silent" : "hidden"}.`);
  if (track.locked) out.notes.push(`Track ${track.id} is locked: edits are refused with E_TRACK_LOCKED.`);
  out.see_also.push(`montash blame ${clip.id} --json`);
  return out;
}

// ---------------------------------------------------------------------------
// トランジション / トラック / アセット / ダッキング
// ---------------------------------------------------------------------------

function explainTransition(project: Project, tr: Transition): Explanation {
  const fps = project.settings.fps;
  const out: Explanation = {
    target: tr.id,
    kind: "transition",
    subtype: tr.type,
    headline: `${tr.id} — ${tr.type} transition on track ${tr.track}`,
    explanation: [],
    facts: {
      ...tr,
      duration: timeFacts(tr.duration_f, fps),
      handle: handleExtension(tr.duration_f),
    },
    notes: [],
    see_also: ["montash transition list --json"],
  };
  out.explanation.push(
    `${tr.id} joins clip ${tr.from} into clip ${tr.to} on track ${tr.track} with an xfade of type "${tr.type}" lasting ${sec(tr.duration_f, fps)} (${frames(tr.duration_f)}).`,
  );
  const ext = handleExtension(tr.duration_f);
  out.explanation.push(
    tr.mode === "handle"
      ? `In "handle" mode both clips keep their timeline positions: the render extends ${tr.from} by ${frames(ext.ext_from)} and pulls ${tr.to} in by ${frames(ext.ext_to)} so the two pictures overlap. Both clips need that much unused source, otherwise E_INSUFFICIENT_HANDLE.`
      : `In "overlap" mode ${tr.to} and everything after it were pulled ${frames(tr.duration_f)} earlier, so the timeline is that much shorter.`,
  );
  out.explanation.push(
    tr.audio === "crossfade"
      ? "The linked audio is crossfaded over the same length."
      : "The audio is cut rather than crossfaded.",
  );
  if (Object.keys(tr.params).length > 0) out.explanation.push(`Extra xfade parameters: ${paramList(tr.params)}.`);

  const from = findClipOrNull(project, tr.from);
  const to = findClipOrNull(project, tr.to);
  if (from && to)
    out.explanation.push(
      `The cut sits at ${point(clipEndF(from.clip), fps)}, between ${tr.from} (${span(from.clip.start_f, clipEndF(from.clip), fps)}) and ${tr.to} (${span(to.clip.start_f, clipEndF(to.clip), fps)}).`,
    );
  else out.notes.push("One of the clips this transition refers to is no longer on the timeline.");
  return out;
}

function explainTrack(project: Project, track: Track): Explanation {
  const fps = project.settings.fps;
  const end = trackEnd(track);
  const gain = project.audio.track_gain_db[track.id];
  const out: Explanation = {
    target: track.id,
    kind: "track",
    subtype: track.kind,
    headline: `${track.id} — ${track.kind} track${track.name && track.name !== track.id ? ` "${track.name}"` : ""}`,
    explanation: [],
    facts: {
      id: track.id,
      kind: track.kind,
      name: track.name ?? track.id,
      muted: track.muted,
      locked: track.locked,
      clip_count: track.clips.length,
      end: timeFacts(end, fps),
      fade: track.fade,
      ...(gain === undefined ? {} : { gain_db: gain }),
      clips: [...track.clips]
        .sort((a, b) => a.start_f - b.start_f)
        .map((c, i) => describeClip(c, track.id, i + 1, fps)),
    },
    notes: [],
    see_also: [`montash clip list --track ${track.id} --json`, "montash timeline show --ascii"],
  };
  const layer =
    track.kind === "video"
      ? `It is layer ${project.tracks.filter((t) => t.kind === "video").findIndex((t) => t.id === track.id) + 1} of the video stack; later video tracks are composited on top of it.`
      : track.kind === "audio"
        ? "Its clips are mixed together with the other audio tracks."
        : "It carries text and subtitle clips, which are drawn over the composited picture.";
  out.explanation.push(
    `${track.id} is a ${track.kind} track holding ${plural(track.clips.length, "clip")} and ending at ${point(end, fps)}.`,
  );
  out.explanation.push(layer);
  const byKind = new Map<string, number>();
  for (const c of track.clips) byKind.set(clipKind(c), (byKind.get(clipKind(c)) ?? 0) + 1);
  if (byKind.size > 0)
    out.explanation.push(
      `Its clips are ${[...byKind].map(([k, n]) => `${n} ${k}`).join(", ")}: ${[...track.clips]
        .sort((a, b) => a.start_f - b.start_f)
        .map((c) => `${c.id} at ${span(c.start_f, clipEndF(c), fps)}`)
        .join(", ")}.`,
    );
  if (gain !== undefined && gain !== 0)
    out.explanation.push(`The whole track is mixed at ${gain > 0 ? "+" : ""}${gain} dB.`);
  if (track.fade.in_f > 0 || track.fade.out_f > 0)
    out.explanation.push(`The track fades ${fadePhrase(track.fade.in_f, track.fade.out_f, fps)}.`);
  if (track.muted) out.notes.push(`The track is muted: it is ${track.kind === "audio" ? "silent" : "hidden"}.`);
  if (track.locked) out.notes.push("The track is locked, so edits and ripples skip it (E_TRACK_LOCKED).");
  return out;
}

function explainAsset(dir: string, project: Project, asset: Asset): Explanation {
  const fps = project.settings.fps;
  const file = resolveAssetPath(dir, asset.path);
  const missing = !existsSync(file);
  // 使用箇所は保存しない派生値（docs/05 §5）。core/assets.ts の算出をそのまま使う
  const usage = assetUsage(project, asset.id);
  const out: Explanation = {
    target: asset.id,
    kind: "asset",
    subtype: asset.type,
    headline: `${asset.id} — ${asset.type} asset`,
    explanation: [],
    facts: { ...asset, missing, usage },
    notes: [],
    see_also: [`montash assets show ${asset.id} --json`, `montash clip list --asset ${asset.id} --json`],
  };

  const specs: string[] = [];
  const video = (asset as { video?: { codec?: string; width?: number; height?: number; fps?: Fps } }).video;
  const audio = (asset as { audio?: { codec?: string; sample_rate?: number; channels?: number } | null }).audio;
  if (video?.width && video.height) specs.push(`${video.width}x${video.height}`);
  if (video?.codec) specs.push(`video ${video.codec}`);
  if (video?.fps) specs.push(fpsText(video.fps));
  if (audio?.codec) specs.push(`audio ${audio.codec}${audio.channels ? ` ${audio.channels}ch` : ""}`);
  if (asset.duration_f != null) specs.push(`${sec(asset.duration_f, fps)} / ${frames(asset.duration_f)}`);

  out.explanation.push(
    `${asset.id} is a ${asset.type} asset read from ${asset.path}${specs.length > 0 ? ` (${specs.join(", ")})` : ""}. montash never writes to it — every edit only changes project.json.`,
  );
  if (asset.type === "image")
    out.explanation.push(
      `Images carry no duration, so a clip cut from it gets the project default of ${frames(project.settings.default_image_duration_f)} unless --duration says otherwise.`,
    );
  if (asset.type === "text")
    out.explanation.push(
      `Its body is used by text clips through \`text add --asset ${asset.id}\`${asset.text_preview ? `; it starts with ${quote(asset.text_preview, 40)}` : ""}.`,
    );

  if (usage.clips.length === 0) {
    out.explanation.push("No clip uses it yet, so it does not appear in the render.");
  } else {
    out.explanation.push(
      `${plural(usage.clips.length, "clip")} use${usage.clips.length === 1 ? "s" : ""} it: ${usage.clips
        .map((u) => `${u.id} on ${u.track} at ${span(u.start_f, u.end_f, fps)}`)
        .join(", ")}.`,
    );
  }
  if (asset.label) out.explanation.push(`It is labelled ${quote(asset.label)}.`);
  if (asset.tags.length > 0) out.explanation.push(`Tags: ${asset.tags.join(", ")}.`);
  if (missing)
    out.notes.push(
      `The file is not at ${asset.path} right now: rendering and probing fail with E_ASSET_MISSING until \`montash assets relink ${asset.id} <path>\` points it somewhere real.`,
    );
  return out;
}

function explainDucking(project: Project, duck: Ducking): Explanation {
  const missing = [duck.target, duck.sidechain].filter((id) => !project.tracks.some((t) => t.id === id));
  return {
    target: duck.id,
    kind: "ducking",
    subtype: "audio",
    headline: `${duck.id} — ducking of ${duck.target} by ${duck.sidechain}`,
    explanation: [
      `${duck.id} turns track ${duck.target} down whenever ${duck.sidechain} is louder than ${duck.threshold_db} dB.`,
      `The compression ratio is ${duck.ratio}:1, it reacts in ${duck.attack_ms} ms and recovers over ${duck.release_ms} ms, with ${duck.makeup_db > 0 ? "+" : ""}${duck.makeup_db} dB of make-up gain.`,
      "Nothing is written to the clips: the ducking is applied in the filter graph at render time.",
    ],
    facts: { ...duck, tracks_present: missing.length === 0 },
    notes:
      missing.length === 0
        ? []
        : [`Track ${missing.join(" and ")} is not on the timeline any more, so this rule has nothing to act on.`],
    see_also: ["montash audio show --json"],
  };
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

function explainTimeline(project: Project): Explanation {
  const fps = project.settings.fps;
  const summary = timelineSummary(project);
  const gaps = findVideoGaps(project);
  const out: Explanation = {
    target: "timeline",
    kind: "timeline",
    headline: `timeline — ${project.name}`,
    explanation: [],
    facts: {
      ...summary,
      resolution: project.settings.resolution,
      tracks: project.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        clip_count: t.clips.length,
        muted: t.muted,
        locked: t.locked,
        end: timeFacts(trackEnd(t), fps),
      })),
      transition_count: project.transitions.length,
      asset_count: Object.keys(project.assets).length,
      gaps: gaps.map((g) => ({ from: timeFacts(g.from_f, fps), to: timeFacts(g.to_f, fps) })),
    },
    notes: [],
    see_also: ["montash timeline show --ascii", "montash validate --json", "montash project show --json"],
  };
  out.explanation.push(
    `The timeline of project "${project.name}" runs ${sec(summary.duration_f, fps)} (${summary.duration_tc}, ${frames(summary.duration_f)}) at ${fpsText(fps)}, ${project.settings.resolution.width}x${project.settings.resolution.height}.`,
  );
  out.explanation.push(
    `It holds ${plural(project.tracks.length, "track")} and ${plural(clipCount(project), "clip")}: ${
      project.tracks
        .map((t) => `${t.id} (${t.kind}, ${plural(t.clips.length, "clip")}, ends ${sec(trackEnd(t), fps)})`)
        .join(", ") || "none"
    }.`,
  );
  out.explanation.push(
    project.transitions.length === 0
      ? "No transition joins the cuts, so every cut is hard."
      : `${plural(project.transitions.length, "transition")} sit${project.transitions.length === 1 ? "s" : ""} on the cuts: ${project.transitions
          .map((t) => `${t.id} ${t.from}→${t.to} (${t.type}, ${sec(t.duration_f, fps)})`)
          .join(", ")}.`,
  );
  out.explanation.push(
    `Audio is mixed at ${project.audio.master_gain_db} dB master gain${
      project.audio.normalize.enabled
        ? ` and normalised to ${project.audio.normalize.i} LUFS`
        : " with no loudness normalisation"
    }${project.audio.ducking.length > 0 ? `, with ${plural(project.audio.ducking.length, "ducking rule")}` : ""}.`,
  );
  if (gaps.length > 0)
    out.notes.push(
      `${plural(gaps.length, "stretch")} of the timeline has no video: ${gaps
        .map((g) => span(g.from_f, g.to_f, fps))
        .join(", ")}. Use \`montash timeline gaps --fill close\` or \`--fill black\`.`,
    );
  const opaque = project.tracks.flatMap((t) => t.clips.filter((c) => clipKind(c) === "opaque").map((c) => c.id));
  if (opaque.length > 0)
    out.notes.push(
      `${plural(opaque.length, "clip")} (${opaque.join(", ")}) need a plugin this build does not have; rendering fails with E_PLUGIN_MISSING until it is installed (F-EXT-4).`,
    );
  return out;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/** フィルタ名 → 何のために置かれているか（docs/07 のマッピング表の要約） */
const FILTER_NOTES: Readonly<Record<string, string>> = {
  trim: "cut the source down to the clip's in/out range",
  atrim: "cut the audio down to the clip's in/out range",
  setpts: "rebase the video timestamps so the segment starts at 0",
  asetpts: "rebase the audio timestamps so the segment starts at 0",
  settb: "pin the time base to the timeline fps",
  fps: "resample to the timeline frame rate",
  scale: "resize the picture to the working resolution",
  pad: "letterbox/pillarbox the picture into the output frame",
  crop: "cut the picture down (reframe or crop)",
  setsar: "force square pixels",
  format: "convert the pixel format",
  aformat: "convert the sample format / rate / layout",
  concat: "join the clips of one track end to end",
  overlay: "composite a clip on top of the layer below",
  xfade: "cross-dissolve two clips over the transition length",
  acrossfade: "cross-fade the audio of two clips",
  fade: "fade the picture in or out",
  afade: "fade the audio in or out",
  tpad: "pad a track with the background colour where it has no clip",
  apad: "pad the audio with silence to the timeline length",
  color: "generate a solid colour source (background or generator clip)",
  anullsrc: "generate silence for a track with no audio",
  volume: "apply clip, track or master gain",
  adelay: "place the audio at its start time on the timeline",
  amix: "mix the audio tracks together",
  asplit: "duplicate the audio for a side-chain",
  split: "duplicate the picture for a second branch",
  aresample: "resample and keep audio in sync with the video",
  atempo: "change the audio speed to match the clip speed",
  loudnorm: "normalise loudness to the project target (EBU R128)",
  sidechaincompress: "duck one track while another is loud",
  subtitles: "burn subtitle/text cues into the picture (libass)",
  ass: "burn ASS cues into the picture (libass)",
  drawtext: "draw text without libass (fallback engine)",
  eq: "adjust brightness / contrast / saturation / gamma",
  gblur: "gaussian blur",
  boxblur: "box blur",
  colorchannelmixer: "change opacity or mix colour channels",
  lut3d: "apply a 3D LUT",
  hflip: "mirror the picture horizontally",
  vflip: "mirror the picture vertically",
  rotate: "rotate the picture",
  palettegen: "collect the colours for the GIF palette",
  paletteuse: "map the picture onto the GIF palette",
  null: "pass the video through unchanged",
  anull: "pass the audio through unchanged",
};

interface GraphChain {
  index: number;
  inputs: string[];
  outputs: string[];
  filters: Array<{ name: string; note?: string }>;
  source: string;
}

/** `-filter_complex` の文字列を「連鎖ごと」に割り、置かれているフィルタに注釈を付ける */
export function annotateFilterGraph(filterComplex: string): GraphChain[] {
  const labels = (s: string): string[] => [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] as string);
  return splitTopLevel(filterComplex, ";")
    .map((chain) => chain.trim())
    .filter((chain) => chain.length > 0)
    .map((chain, i) => {
      const head = /^(\[[^\]]+\])+/.exec(chain)?.[0] ?? "";
      const tail = /(\[[^\]]+\])+$/.exec(chain)?.[0] ?? "";
      const body = chain.slice(head.length, chain.length - tail.length);
      // 同じフィルタが 2 度出てくる連鎖（`setpts` など）は 1 度だけ挙げる
      const names = [
        ...new Set(
          splitTopLevel(body, ",")
            .map((step) => /^\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(step)?.[1])
            .filter((name): name is string => name !== undefined),
        ),
      ];
      return {
        index: i + 1,
        inputs: labels(head),
        outputs: labels(tail),
        filters: names.map((name) => ({ name, ...(FILTER_NOTES[name] ? { note: FILTER_NOTES[name] } : {}) })),
        source: chain,
      };
    });
}

/**
 * `,` / `;` で割る。ただし ffmpeg の引数は `filename='a,b.ass'` のように引用符や `\` で
 * 逃がされることがあるので、その中の区切りでは割らない。
 */
function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "\\" && i + 1 < source.length) {
      current += ch + source[i + 1];
      i++;
      continue;
    }
    if (ch === "'") {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (ch === separator && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

async function explainRender(ctx: CommandContext, dir: string, project: Project): Promise<Explanation> {
  const fps = project.settings.fps;
  const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
  // `render --dry-run` と同じ手順（音声パスは測定せず、プランだけ組む）
  const audio = await prepareAudio(bins, project, {
    source: (asset) => resolveAssetPath(dir, asset.path),
    measure: false,
  });
  const output = join(dir, "out", `${project.name}.mp4`);
  const plan: RenderPlan = await buildRenderPlan(project, dir, output, {
    presets: resolvePresets(project),
    bins,
    audio: audio.passes,
    preset: "youtube-1080p",
  });
  const command = [bins.ffmpeg, "-n", ...plan.args];
  const chains = annotateFilterGraph(plan.filter_complex);

  const out: Explanation = {
    target: "render",
    kind: "render",
    subtype: plan.preset,
    headline: `render — preset ${plan.preset} (${plan.resolution.width}x${plan.resolution.height} ${plan.format})`,
    explanation: [],
    facts: {
      preset: plan.preset,
      format: plan.format,
      resolution: plan.resolution,
      fps: plan.fps,
      vcodec: plan.vcodec,
      acodec: plan.acodec,
      two_pass: plan.two_pass,
      verifiable: plan.verifiable,
      duration: timeFacts(plan.duration_f, fps),
      output,
      command,
      filter_complex: plan.filter_complex,
      chains,
    },
    notes: plan.warnings.map((w) => `${w.code}: ${w.message}`),
    see_also: [
      "montash render --dry-run --json -o out/final.mp4",
      "montash validate --deep --json",
      "montash render presets",
    ],
  };

  out.explanation.push(
    `With the default preset "${plan.preset}", montash renders ${sec(plan.duration_f, fps)} (${frames(plan.duration_f)}) at ${plan.resolution.width}x${plan.resolution.height}, ${fpsText(plan.fps)}, as ${plan.format}${plan.vcodec ? ` with ${plan.vcodec} video` : " with no video"}${plan.acodec ? ` and ${plan.acodec} audio` : " and no audio"}.`,
  );
  out.explanation.push(
    `ffmpeg is called once${plan.two_pass ? " per pass (two-pass encoding)" : ""} with ${plural(plan.args.filter((a) => a === "-i").length, "input")} and one -filter_complex holding ${plural(chains.length, "chain")}; the graph is built fresh from project.json every time, so nothing about the sources is modified.`,
  );
  out.explanation.push(
    plan.verifiable
      ? "Because this is a full-length render at the timeline fps, montash counts the frames of the result afterwards and fails if they do not match exactly."
      : "This output is not a full-length A/V render at the timeline fps, so the exact-frame verification is skipped.",
  );
  out.explanation.push(
    "Pass -o and any encoding options to `montash render` to change this; `montash render --dry-run --json` prints the same command for a specific output.",
  );
  return out;
}

// ---------------------------------------------------------------------------
// ID の解決
// ---------------------------------------------------------------------------

/** 見つからなかった ID を、形から推測した既存エラーコードで返す（hint に候補） */
function notFound(project: Project, id: string): MontashError {
  const clips = project.tracks.flatMap((t) => t.clips.map((c) => c.id));
  const tracks = project.tracks.map((t) => t.id);
  const transitions = project.transitions.map((t) => t.id);
  const duckings = project.audio.ducking.map((d) => d.id);
  const assets = Object.keys(project.assets);

  // 種別ごとの ID 規約（docs/04 §1.4）から「本来どこにあるはずか」を当て、その中から候補を出す
  const guess: { code: string; what: string; known: string[]; next: string } = /^[VAT]\d+$/.test(id)
    ? { code: "E_TRACK_NOT_FOUND", what: "track", known: tracks, next: "montash track list --json" }
    : /^t\d/.test(id)
      ? {
          code: "E_TRANSITION_NOT_FOUND",
          what: "transition",
          known: transitions,
          next: "montash transition list --json",
        }
      : /^d\d+$/.test(id)
        ? { code: "E_DUCKING_NOT_FOUND", what: "ducking rule", known: duckings, next: "montash audio show --json" }
        : /^[cxs]\d/.test(id)
          ? { code: "E_CLIP_NOT_FOUND", what: "clip", known: clips, next: "montash clip list --json" }
          : { code: "E_ASSET_NOT_FOUND", what: "asset", known: assets, next: "montash assets list --json" };

  // まず同じ種別の中から探し、無ければ全種別に広げる（`c2` と打つべきところで `x2` と打つ類の救済）
  const all = [...clips, ...tracks, ...transitions, ...duckings, ...assets];
  const sameKind = suggestIds(id, guess.known);
  const near = sameKind.length > 0 ? sameKind : suggestIds(id, all);
  const hint = [
    near.length > 0 ? `Did you mean ${near.slice(0, 5).join(", ")}?` : "",
    guess.known.length > 0
      ? `Known ${guess.what} ids: ${guess.known.slice(0, 10).join(", ")}.`
      : `No ${guess.what} exists yet.`,
    `Run \`${guess.next}\`, or \`montash explain timeline\` for the whole picture.`,
  ]
    .filter(Boolean)
    .join(" ");

  return new MontashError(guess.code, `${guess.what} "${id}" not found`, {
    hint,
    detail: {
      target: id,
      candidates: near.slice(0, 5),
      [`known_${guess.what.replace(" ", "_")}s`]: guess.known.slice(0, 20),
    },
  });
}

/** 近い ID の候補（`core/history` の suggest と同じ規則の軽量版） */
function suggestIds(input: string, names: readonly string[], max = 5): string[] {
  const lower = input.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of new Set(names)) {
    const n = name.toLowerCase();
    if (n.startsWith(lower) || lower.startsWith(n)) scored.push({ name, score: 0 });
    else if (n.includes(lower) || lower.includes(n)) scored.push({ name, score: 1 });
    else if (n.length === lower.length && [...n].filter((c, i) => c !== lower[i]).length <= 1)
      scored.push({ name, score: 2 });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map((s) => s.name);
}

// ---------------------------------------------------------------------------
// 人間向け整形
// ---------------------------------------------------------------------------

function humanText(e: Explanation): string {
  const lines = [e.headline, ""];
  for (const sentence of e.explanation) lines.push(`  ${sentence}`);
  if (e.notes.length > 0) {
    lines.push("", "Notes");
    for (const note of e.notes) lines.push(`  - ${note}`);
  }
  if (e.kind === "render") {
    const chains = (e.facts.chains ?? []) as GraphChain[];
    lines.push("", `Filter graph (${chains.length} chains)`);
    for (const chain of chains) {
      lines.push(
        `  ${String(chain.index).padStart(3)}  ${chain.inputs.map((l) => `[${l}]`).join("") || "(source)"} -> ${chain.outputs.map((l) => `[${l}]`).join("") || "(output)"}`,
      );
      for (const f of chain.filters) lines.push(`       ${f.name.padEnd(18)} ${f.note ?? ""}`.trimEnd());
    }
    lines.push("", "Command", `  ${shellQuote(e.facts.command as string[])}`);
  }
  if (e.see_also.length > 0) {
    lines.push("", "See also");
    for (const cmd of e.see_also) lines.push(`  ${cmd}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

interface Args extends Record<string, unknown> {
  target: string;
}

export const explain = defineCommand<Args>({
  path: "explain",
  summary: "explain an element, the timeline or the render in plain English (and JSON)",
  description:
    "Answers 'what is this, where does it come from, how long is it and what is done to it' for anything with an id " +
    "(clip, text, subtitle, transition, track, asset, ducking rule), for `timeline`, and for `render` (the ffmpeg " +
    "command and its annotated filter graph). The same sentences are in the --json output, next to machine-readable facts.",
  workflows: ["W-21"],
  positionals: [
    {
      name: "target",
      describe: "element id (c3, x1, s1, t2, V1, d1, an asset id), or `timeline` / `render`",
      required: true,
    },
  ],
  examples: [
    { cmd: "montash explain c2", note: "what a clip shows, where it sits and what is applied to it" },
    { cmd: "montash explain x1 --json", note: "same explanation with machine-readable facts, for AI" },
    { cmd: "montash explain timeline", note: "the whole project in a few sentences" },
    { cmd: "montash explain render", note: "the ffmpeg command and filter graph, annotated" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const target = String(args.target);

    const built = await explainTarget(ctx, dir, project, target);
    return { result: built, op: null, commit: null, head: null, human: () => humanText(built) };
  },
});

async function explainTarget(ctx: CommandContext, dir: string, project: Project, target: string): Promise<Explanation> {
  if (target === "timeline") return explainTimeline(project);
  if (target === "render") return explainRender(ctx, dir, project);

  const track = project.tracks.find((t) => t.id === target);
  if (track) return explainTrack(project, track);

  const located = findClipOrNull(project, target);
  if (located) {
    const index = [...located.track.clips].sort((a, b) => a.start_f - b.start_f).findIndex((c) => c.id === target);
    return explainClip(ctx, dir, project, located.track, located.clip, index + 1);
  }

  const transition = project.transitions.find((t) => t.id === target);
  if (transition) return explainTransition(project, transition);

  const duck = project.audio.ducking.find((d) => d.id === target);
  if (duck) return explainDucking(project, duck);

  const asset = Object.hasOwn(project.assets, target) ? project.assets[target] : undefined;
  if (asset) return explainAsset(dir, project, asset);

  throw notFound(project, target);
}
