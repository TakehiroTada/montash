import { describe, expect, test } from "bun:test";
import { parseNames, parseVersion, versionGte } from "../../../src/ffmpeg/locate.ts";

describe("ffmpeg/locate", () => {
  test("parseVersion handles release and git builds", () => {
    expect(parseVersion("ffmpeg version 9.0.1 Copyright (c) 2000-2026")).toBe("9.0.1");
    expect(parseVersion("ffmpeg version n7.1-latest-linux64-gpl Copyright")).toBe("7.1");
    expect(parseVersion("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright")).toBe("4.4.2");
    expect(parseVersion("garbage")).toBe("0");
  });
  test("versionGte", () => {
    expect(versionGte("6.1", "6.0")).toBe(true);
    expect(versionGte("4.4.2", "4.4")).toBe(true);
    expect(versionGte("4.3", "4.4")).toBe(false);
    expect(versionGte("9.0.1", "6.0")).toBe(true);
  });
  test("parseNames extracts encoder/filter names", () => {
    const enc = ` V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC (Advanced Audio Coding)\n`;
    expect([...parseNames(enc)]).toEqual(["libx264", "aac"]);
    const flt = ` ... xfade             VV->V      Cross fade\n T.C subtitles         V->V       Render text subtitles\n TSC loudnorm          A->A       EBU R128 loudness normalization\n`;
    const names = parseNames(flt);
    expect(names.has("xfade")).toBe(true);
    expect(names.has("subtitles")).toBe(true);
    expect(names.has("loudnorm")).toBe(true);
    // ffmpeg 7+ はフラグが 2 文字
    const flt9 = `Filters:\n  T.. = Timeline support\n  ------\n .S xfade             VV->V      Cross fade one video with another video.\n .. concat            N->N       Concatenate audio and video streams.\n TS aap               AA->A      Apply Affine Projection algorithm.\n`;
    const n9 = parseNames(flt9);
    expect(n9.has("xfade")).toBe(true);
    expect(n9.has("concat")).toBe(true);
    expect(n9.has("aap")).toBe(true);
    expect(n9.has("Timeline")).toBe(false);
  });
});
