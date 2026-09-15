import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindPlayback } from "../../../web/src/playback.ts";
import { useStore } from "../../../web/src/store.ts";

class Media extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 10;
  seeking = false;
  paused = true;
  ended = false;
  error: { message: string } | null = null;
  rejection: Error | null = null;
  playCount = 0;
  load() {
    this.paused = true;
    this.currentTime = 0;
    this.dispatchEvent(new Event("pause"));
  }
  async play() {
    this.playCount++;
    if (this.rejection) throw this.rejection;
    if (this.paused) {
      this.paused = false;
      this.dispatchEvent(new Event("play"));
    }
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  emit(name: string) {
    this.dispatchEvent(new Event(name));
  }
}

let dispose = () => {};
const originalRequest = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
const frames = new Map<number, FrameRequestCallback>();
let seq = 0;
function bind(media: Media, url = "/preview/one.mp4", duration = 300) {
  dispose = bindPlayback(media as unknown as HTMLVideoElement, url, { num: 30, den: 1 }, duration);
}

beforeEach(() => {
  useStore.setState({ playhead_f: 0, isPlaying: false, logs: [] });
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++seq, callback);
    return seq;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
});
afterEach(() => {
  dispose();
  frames.clear();
  globalThis.requestAnimationFrame = originalRequest;
  globalThis.cancelAnimationFrame = originalCancel;
});

describe("preview transport", () => {
  test("seeks from transport, follows native seeking, and clamps to final frame", () => {
    const media = new Media();
    bind(media);
    media.emit("loadedmetadata");
    useStore.getState().setPlayhead(30);
    expect(media.currentTime).toBe(1);
    media.currentTime = 2.5;
    media.emit("timeupdate");
    expect(useStore.getState().playhead_f).toBe(75);
    useStore.getState().setPlayhead(900);
    expect(useStore.getState().playhead_f).toBe(299);
    expect(media.currentTime).toBeCloseTo(299 / 30);
  });

  test("transport and native playback controls stay synchronized", () => {
    const media = new Media();
    bind(media);
    media.emit("loadedmetadata");
    useStore.getState().setPlaying(true);
    expect(media.paused).toBe(false);
    media.currentTime = 0.5;
    for (const [id, frame] of [...frames]) {
      frames.delete(id);
      frame(0);
    }
    expect(useStore.getState().playhead_f).toBe(15);
    media.pause();
    expect(useStore.getState().isPlaying).toBe(false);
    void media.play();
    expect(useStore.getState().isPlaying).toBe(true);
    useStore.getState().setPlaying(false);
    expect(media.paused).toBe(true);
  });

  test("replacing the preview retains frame and playback intent until metadata loads", () => {
    const media = new Media();
    bind(media);
    media.emit("loadedmetadata");
    useStore.getState().setPlayhead(90);
    useStore.getState().setPlaying(true);
    dispose();
    bind(media, "/preview/two.mp4");
    expect(useStore.getState().isPlaying).toBe(true);
    expect(useStore.getState().playhead_f).toBe(90);
    media.emit("timeupdate");
    expect(useStore.getState().playhead_f).toBe(90);
    media.emit("loadedmetadata");
    expect(media.currentTime).toBe(3);
    expect(media.paused).toBe(false);
  });

  test("a shorter replacement clamps the retained playhead", () => {
    const media = new Media();
    useStore.getState().setPlayhead(200);
    bind(media, "/preview/short.mp4", 60);
    media.duration = 2;
    media.emit("loadedmetadata");
    expect(useStore.getState().playhead_f).toBe(59);
    expect(media.currentTime).toBeCloseTo(59 / 30);
  });

  test("play failure is reported and controls return to paused", async () => {
    const media = new Media();
    media.rejection = new Error("autoplay blocked");
    bind(media);
    media.emit("loadedmetadata");
    useStore.getState().setPlaying(true);
    await Promise.resolve();
    expect(useStore.getState().isPlaying).toBe(false);
    expect(useStore.getState().logs.at(-1)?.message).toContain("autoplay blocked");
  });

  test("disposed media cannot change transport or seek after replacement", () => {
    const media = new Media();
    bind(media);
    media.emit("loadedmetadata");
    dispose();
    useStore.getState().setPlayhead(60);
    expect(media.currentTime).toBe(0);
    media.currentTime = 4;
    media.emit("timeupdate");
    expect(useStore.getState().playhead_f).toBe(60);
  });
});
