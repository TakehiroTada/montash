import { type Fps, framesToSeconds, useStore } from "./store.ts";

/** Bind one preview generation to the shared transport. Rebinding preserves the user's intent. */
export function bindPlayback(video: HTMLVideoElement, url: string, fps: Fps, durationFrames?: number): () => void {
  let loading = true;
  let disposed = false;
  let fromMedia = false;
  let animation: number | undefined;
  const listeners: Array<[string, EventListener]> = [];
  const on = (name: string, handler: () => void) => {
    video.addEventListener(name, handler);
    listeners.push([name, handler]);
  };
  const lastFrame = () => {
    const fromDuration = Number.isFinite(video.duration)
      ? Math.max(0, Math.ceil((video.duration * fps.num) / fps.den) - 1)
      : 0;
    return durationFrames === undefined ? fromDuration : Math.min(fromDuration, Math.max(0, durationFrames - 1));
  };
  const updateFrame = () => {
    if (loading || video.seeking) return;
    const frame = Math.min(lastFrame(), Math.max(0, Math.floor((video.currentTime * fps.num) / fps.den + 1e-6)));
    fromMedia = true;
    useStore.getState().setPlayhead(frame);
    fromMedia = false;
  };
  const seek = () => {
    if (loading) return;
    const frame = Math.min(lastFrame(), useStore.getState().playhead_f);
    video.currentTime = framesToSeconds(frame, fps);
    if (frame !== useStore.getState().playhead_f) {
      fromMedia = true;
      useStore.getState().setPlayhead(frame);
      fromMedia = false;
    }
  };
  const play = () => {
    if (loading) return;
    // Native play restarts an ended video; keep the shared playhead consistent too.
    if (video.ended) {
      video.currentTime = 0;
      updateFrame();
    }
    void video.play().catch((error: unknown) => {
      if (disposed || !useStore.getState().isPlaying) return;
      useStore.getState().setPlaying(false);
      useStore.getState().log("error", `Preview playback failed: ${String(error)}`);
    });
  };
  const tick = () => {
    updateFrame();
    if (!disposed && !video.paused) animation = requestAnimationFrame(tick);
  };
  on("loadedmetadata", () => {
    loading = false;
    seek();
    if (useStore.getState().isPlaying) play();
  });
  on("play", () => {
    if (loading) return;
    useStore.getState().setPlaying(true);
    if (animation !== undefined) cancelAnimationFrame(animation);
    animation = requestAnimationFrame(tick);
  });
  on("pause", () => {
    // A source swap pauses the media element while the replacement loads.
    if (!loading) useStore.getState().setPlaying(false);
  });
  on("ended", () => {
    updateFrame();
    useStore.getState().setPlaying(false);
  });
  on("timeupdate", updateFrame);
  on("seeked", updateFrame);
  on("error", () => {
    useStore.getState().setPlaying(false);
    useStore.getState().log("error", `Preview could not be loaded (${video.error?.message ?? "media error"})`);
  });
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (!fromMedia && state.playhead_f !== previous.playhead_f) seek();
    if (state.isPlaying !== previous.isPlaying) {
      if (state.isPlaying) play();
      else video.pause();
    }
  });
  video.src = url;
  video.load();
  return () => {
    disposed = true;
    unsubscribe();
    for (const [name, handler] of listeners) video.removeEventListener(name, handler);
    if (animation !== undefined) cancelAnimationFrame(animation);
  };
}
