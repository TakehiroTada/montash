/**
 * `FilterGraph` + `OutputSpec` → ffmpeg 引数配列（docs/07 §9）。
 *
 * `-filter_complex` は必ず 1 引数で渡す。尺はフレーム数（`-frames:v`）で固定し、`-shortest` は使わない。
 */
import { MontashError } from "../../cli/errors.ts";
import { framesToSecString } from "../../core/time.ts";
import type { FilterGraph, OutputSpec } from "./types.ts";

export function serializeGraph(graph: FilterGraph, out: OutputSpec): string[] {
  if (out.video && !graph.mapVideo)
    throw new MontashError("E_USAGE", "the filter graph has no video output but the output spec wants video");
  if (out.audio && !graph.mapAudio)
    throw new MontashError("E_USAGE", "the filter graph has no audio output but the output spec wants audio");
  const rate = `${graph.fps.num}/${graph.fps.den}`;
  const args: string[] = [];
  for (const input of graph.inputs) args.push(...input);
  // ソフト字幕はフィルタを通さず素通しで多重化するので、入力の末尾に足す（docs/07 §7）
  const subs = out.subtitles ?? [];
  const subtitleInput = graph.inputs.length;
  for (const sub of subs) {
    if (sub.offsetS !== undefined) args.push("-itsoffset", sub.offsetS);
    args.push("-i", sub.path);
  }
  args.push("-filter_complex_threads", "1", "-filter_complex", graph.filterComplex);
  if (out.video) args.push("-map", graph.mapVideo);
  if (out.audio) args.push("-map", graph.mapAudio);
  for (let i = 0; i < subs.length; i++) args.push("-map", `${subtitleInput + i}:s:0`);
  if (!out.video) args.push("-vn");
  if (!out.audio) args.push("-an");

  if (out.video) {
    args.push("-c:v", out.video.codec);
    if (out.video.preset) args.push("-preset", out.video.preset);
    if (out.video.crf !== undefined) args.push("-crf", String(out.video.crf));
    if (out.video.pixFmt) args.push("-pix_fmt", out.video.pixFmt);
    if (out.video.gop !== undefined) args.push("-g", String(out.video.gop));
    args.push("-r", rate, "-frames:v", String(graph.totalFrames));
    if (out.video.trackTimescale !== undefined) args.push("-video_track_timescale", String(out.video.trackTimescale));
  }
  if (out.audio) {
    args.push("-c:a", out.audio.codec);
    if (out.audio.bitrate) args.push("-b:a", out.audio.bitrate);
    args.push("-ar", String(out.audio.sampleRate), "-ac", String(out.audio.channels));
  }
  for (const [i, sub] of subs.entries()) {
    args.push(`-c:s:${i}`, sub.codec);
    if (sub.language !== undefined) args.push(`-metadata:s:s:${i}`, `language=${sub.language}`);
    if (sub.default) args.push(`-disposition:s:${i}`, "default");
  }
  if (out.threads !== undefined) args.push("-threads", String(out.threads));
  // 映像と音声の両方を持つ出力だけ、尺を秒でも固定する（音声側の 1 サンプルの余りを落とす）
  if (out.video && out.audio) args.push("-t", framesToSecString(graph.totalFrames, graph.fps));
  if (out.faststart) args.push("-movflags", "+faststart");
  if (out.extraArgs) args.push(...out.extraArgs);
  args.push("-f", out.format, out.path);
  return args;
}
