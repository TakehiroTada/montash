import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadProject, saveProject } from "../../../src/core/project.ts";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const cli = resolve(import.meta.dir, "../../../src/cli/index.ts");
const bins = locateBinaries();
let fixtures: string;
let dir: string;

async function run(...args: string[]) {
  const proc = Bun.spawn([process.execPath, cli, "-C", dir, "--json", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`${args.join(" ")}: invalid JSON ${out}\n${stderr}`);
  }
  return { ...json, code, stderr };
}
async function ok(...args: string[]) {
  const result = await run(...args);
  if (result.code !== 0 || !result.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(result)}`);
  return result;
}
async function importMedia() {
  await ok("import", join(fixtures, "red.mp4"), join(fixtures, "blue.mp4"));
}

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "montash-edit-fixtures-"));
  for (const [name, rate, audio] of [
    ["red", "30", true],
    ["blue", "60000/1001", false],
  ] as const) {
    const args = ["-f", "lavfi", "-i", `color=c=${name}:s=64x64:r=${rate}:d=2`];
    if (audio) args.push("-f", "lavfi", "-i", "sine=f=440:r=48000:d=2", "-c:a", "aac");
    await runFfmpeg(bins, [
      "-n",
      ...args,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-t",
      "2",
      join(fixtures, `${name}.mp4`),
    ]);
  }
  await runFfmpeg(bins, [
    "-n",
    "-f",
    "lavfi",
    "-i",
    "sine=f=880:r=48000:d=2",
    "-c:a",
    "pcm_s16le",
    join(fixtures, "tone.wav"),
  ]);
  await runFfmpeg(bins, [
    "-n",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=64x64",
    "-frames:v",
    "1",
    join(fixtures, "still.png"),
  ]);
}, 30_000);
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-edit-"));
  await ok("init", dir, "--fps", "30", "--resolution", "64x64");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("M1 import and proxies", () => {
  test("imports media summaries, raw probe, usage; survives undo/redo", async () => {
    const result = await ok("import", join(fixtures, "red.mp4"), "-m", "import red");
    expect(result.result.imported[0].duration_f).toBe(60);
    expect(result.op).toBe("o_0002");
    expect(result.commit).toBeTruthy();
    const shown = await ok("assets", "show", "red", "--probe");
    expect(shown.result.probe.streams.length).toBe(2);
    expect(shown.result.asset.usage.clips).toEqual([]);
    await ok("undo");
    expect((await ok("assets", "list")).result.assets).toHaveLength(0);
    await ok("redo");
    expect((await ok("assets", "list")).result.assets[0].id).toBe("red");
  });
  test("dry run with copy/proxy does not change project, IDs or filesystem", async () => {
    const before = await Bun.file(join(dir, "project.json")).text();
    const state = await readdir(join(dir, ".montash/cache"));
    const result = await ok("import", join(fixtures, "red.mp4"), "--copy", "--proxy", "--dry-run");
    expect(result.result.dry_run).toBe(true);
    expect(await Bun.file(join(dir, "project.json")).text()).toBe(before);
    expect(await readdir(join(dir, ".montash/cache"))).toEqual(state);
    expect(await readdir(join(dir, "assets"))).toEqual([]);
  });
  test("partial failures return exit 4 and success details; strict preflight writes nothing", async () => {
    const args = ["import", join(fixtures, "red.mp4"), join(fixtures, "missing.mp4")];
    const strict = await run(...args, "--strict");
    expect(strict.code).toBe(4);
    expect((await ok("assets", "list")).result.assets).toHaveLength(0);
    const partial = await run(...args);
    expect(partial.code).toBe(4);
    expect(partial.result.failed).toHaveLength(1);
    expect(partial.result.imported[0].id).toBe("red");
  });
  test("strict import does not register successes after a later cache write failure", async () => {
    await Bun.write(join(dir, ".montash/cache/blue"), "blocks cache directory");
    const result = await run("import", join(fixtures, "red.mp4"), join(fixtures, "blue.mp4"), "--copy", "--strict");
    expect(result.code).toBe(4);
    expect(result.error.code).toBe("E_IMPORT_FAILED");
    expect((await ok("assets", "list")).result.assets).toHaveLength(0);
    expect(await readdir(join(dir, "assets"))).toEqual([]);
  });
  test("recursive imports handle text, duplicate slugs and copied filenames", async () => {
    const nested = join(dir, "raw files", "nested");
    await mkdir(nested, { recursive: true });
    await Bun.write(join(nested, "red.txt"), "日本語のタイトル\n字幕");
    await Bun.write(join(nested, "ignore.bin"), "not media");
    await importMedia();
    await ok("import", join(dir, "raw files"), "--copy");
    const asset = (await ok("assets", "show", "red_2")).result;
    expect(asset.text).toBe("日本語のタイトル\n字幕");
    expect(asset.asset.owned).toBe(true);
    expect(asset.asset.path.startsWith("assets/")).toBe(true);
    expect((await ok("assets", "list", "--type", "text", "--search", "red")).result.assets).toHaveLength(1);
  });
  test("invalid IDs cannot escape cache; custom IDs reserve global namespace", async () => {
    expect((await run("import", join(fixtures, "red.mp4"), "--id", "../escape")).code).toBe(4);
    expect((await run("import", join(fixtures, "red.mp4"), "--id", "V1")).code).toBe(4);
    expect((await ok("assets", "list")).result.assets).toHaveLength(0);
  });
  test("builds video/audio proxies, detects stale sources and rebuilds cached proxies", async () => {
    await ok("import", join(fixtures, "red.mp4"), join(fixtures, "tone.wav"), "--copy");
    const dry = await ok("proxy", "build", "--all", "--height", "64", "--dry-run");
    expect(dry.result.dry_run).toBe(true);
    expect((await ok("proxy", "status")).result.proxies.every((p: any) => p.state === "missing")).toBe(true);
    const built = await ok("proxy", "build", "--all", "--height", "64");
    expect(built.result.proxies).toHaveLength(2);
    expect((await ok("proxy", "status")).result.proxies.every((p: any) => p.state === "ready")).toBe(true);
    expect((await ok("proxy", "build", "--all", "--height", "64")).result.proxies.every((p: any) => p.skipped)).toBe(
      true,
    );
    const asset = (await loadProject(dir)).assets.red!;
    await utimes(join(dir, asset.path), new Date(), new Date(Date.now() + 3000));
    expect((await ok("proxy", "status")).result.proxies.find((p: any) => p.id === "red").state).toBe("stale");
    await ok("proxy", "build", "red", "--height", "64");
    expect((await ok("proxy", "status")).result.proxies.find((p: any) => p.id === "red").state).toBe("ready");
  }, 20_000);
});

describe("M1 clip placement", () => {
  beforeEach(importMedia);
  test("linked trims, negative in, append and timing summaries", async () => {
    const first = (await ok("clip", "add", "--asset", "red", "--in=-1", "--at", "end")).result;
    expect(first.clip.in_f).toBe(30);
    expect(first.clip.link).toBe(first.linked_clip.id);
    expect(first.linked_clip.link).toBe(first.clip.id);
    const second = (await ok("clip", "add", "--asset", "blue", "--duration", "f:17", "--at", "end")).result.clip;
    expect(second.start_f).toBe(30);
    expect((await ok("timeline", "show")).result.duration_f).toBe(47);
    expect((await ok("clip", "list", "--track", "V1")).result.clips).toHaveLength(2);
    expect((await ok("assets", "show", "red")).result.asset.usage.clips).toHaveLength(2);
    await ok("validate");
  });
  test("dry-run and failed overlap never consume IDs or modify project", async () => {
    await ok("clip", "add", "--asset", "red");
    const before = await Bun.file(join(dir, "project.json")).text();
    const ids = await Bun.file(join(dir, ".montash/ids.json")).text();
    expect((await ok("clip", "add", "--asset", "blue", "--dry-run")).result.dry_run).toBe(true);
    expect((await run("clip", "add", "--asset", "blue", "--at", "0")).error.code).toBe("E_CLIP_OVERLAP");
    expect(await Bun.file(join(dir, "project.json")).text()).toBe(before);
    expect(await Bun.file(join(dir, ".montash/ids.json")).text()).toBe(ids);
  });
  test("stream selection flags are honored by real CLI parsing", async () => {
    const video = (await ok("clip", "add", "--asset", "red", "--video-only", "--duration", "1")).result;
    expect(video.linked_clip).toBeNull();
    const audio = (await ok("clip", "add", "--asset", "red", "--audio-only", "--duration", "1")).result;
    expect(audio.clip.audio).toBeDefined();
    expect(audio.clip.start_f).toBe(0);
    expect((await run("clip", "add", "--asset", "blue", "--audio-only")).code).toBe(2);
    expect((await run("clip", "add", "--asset", "red", "--video-only", "--audio-only")).code).toBe(2);
  });
  test("locked linked tracks and invalid ranges are rejected before changes", async () => {
    const project = await loadProject(dir);
    project.tracks[1]!.locked = true;
    await saveProject(dir, project);
    expect((await run("clip", "add", "--asset", "red")).error.code).toBe("E_TRACK_LOCKED");
    expect((await run("clip", "add", "--asset", "blue", "--in", "3")).error.code).toBe("E_RANGE_OUT_OF_ASSET");
    expect((await run("clip", "add", "--asset", "blue", "--at", "-1")).code).toBe(2);
  });
  test("explicit IDs cannot collide with the generated linked ID or later IDs", async () => {
    const first = (await ok("clip", "add", "--asset", "red", "--id", "c1", "--duration", "1")).result;
    expect(first.linked_clip.id).not.toBe("c1");
    const second = (await ok("clip", "add", "--asset", "red", "--duration", "1")).result;
    expect(new Set([first.clip.id, first.linked_clip.id, second.clip.id, second.linked_clip.id]).size).toBe(4);
  });
});

async function renderSmall(path = join(dir, "out", "cut.mp4")) {
  return ok(
    "render",
    "-o",
    path,
    "--preset",
    "web-preview",
    "--resolution",
    "64x64",
    "--preset-speed",
    "ultrafast",
    "--progress",
    "none",
  );
}

describe("M1 render", () => {
  for (const fps of ["30", "29.97", "59.94"]) {
    test(`golden ${fps}: exact 47 frames, red→blue cut and matching audio duration`, async () => {
      await ok("init", dir, "--force", "--fps", fps, "--resolution", "64x64");
      await importMedia();
      await ok("clip", "add", "--asset", "red", "--in", "f:3", "--duration", "f:17");
      await ok("clip", "add", "--asset", "blue", "--in", "f:5", "--duration", "f:30");
      const result = await renderSmall();
      expect(result.result.actual_frames).toBe(47);
      expect(result.result.valid).toBe(true);
      const output = result.result.output.path;
      expect((await ok("render", "verify", output)).result.valid).toBe(true);
      const proc = Bun.spawn(
        [
          bins.ffmpeg,
          "-v",
          "error",
          "-i",
          output,
          "-vf",
          "scale=1:1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-an",
          "-",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const pixels = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      expect(await proc.exited).toBe(0);
      expect(pixels.length).toBe(47 * 3);
      for (let frame = 0; frame < 47; frame++) {
        expect(pixels[frame * 3 + (frame < 17 ? 0 : 2)]!).toBeGreaterThan(200);
        expect(pixels[frame * 3 + (frame < 17 ? 2 : 0)]!).toBeLessThan(30);
      }
    }, 20_000);
  }
  test("handles images, leading gaps and silent video", async () => {
    await ok("import", join(fixtures, "still.png"), join(fixtures, "blue.mp4"));
    await ok("clip", "add", "--asset", "still", "--duration", "f:15", "--at", "f:10");
    await ok("clip", "add", "--asset", "blue", "--duration", "f:20");
    expect((await renderSmall()).result.actual_frames).toBe(45);
  }, 20_000);
  test("audio-only timeline renders background with audio", async () => {
    await ok("import", join(fixtures, "tone.wav"));
    await ok("clip", "add", "--asset", "tone", "--duration", "f:20");
    expect((await renderSmall()).result.actual_frames).toBe(20);
  }, 20_000);
  test("dry-run reports real command and does not create output directories", async () => {
    await importMedia();
    await ok("clip", "add", "--asset", "red", "--duration", "f:20");
    const output = join(dir, "new folder", "output.mp4");
    const result = await ok("render", "-o", output, "--dry-run");
    expect(result.result.command).toContain("-filter_complex");
    expect(result.result.duration_f).toBe(20);
    expect(existsSync(dirname(output))).toBe(false);
  });
  test("preserves existing outputs and source assets; verifies mismatched output", async () => {
    await importMedia();
    await ok("clip", "add", "--asset", "red", "--duration", "f:20");
    const output = join(dir, "out", "cut.mp4");
    await Bun.write(output, "existing output");
    expect((await run("render", "-o", output)).error.code).toBe("E_OUTPUT_EXISTS");
    expect(await Bun.file(output).text()).toBe("existing output");
    expect((await run("render", "-o", join(fixtures, "red.mp4"), "--overwrite")).code).toBe(2);
    const alias = join(dir, "out", "source-alias.mp4");
    await link(join(fixtures, "red.mp4"), alias);
    expect((await run("render", "-o", alias, "--overwrite")).code).toBe(2);
    expect((await run("render", "verify", join(fixtures, "red.mp4"))).error.code).toBe("E_RENDER_VERIFY");
    const result = await ok(
      "render",
      "-o",
      output,
      "--overwrite",
      "--resolution",
      "64x64",
      "--preset-speed",
      "ultrafast",
      "--progress",
      "none",
    );
    expect(result.result.valid).toBe(true);
  }, 20_000);
  test("new output directories below symlinks cannot enter protected project state", async () => {
    await importMedia();
    await ok("clip", "add", "--asset", "red", "--duration", "f:20");
    const alias = join(dir, "state-alias");
    await symlink(join(dir, ".montash"), alias, "dir");
    const result = await run("render", "-o", join(alias, "new-directory", "render.mp4"));
    expect(result.code).toBe(2);
    expect(existsSync(join(dir, ".montash/new-directory"))).toBe(false);
  });
  test("unsupported effects fail explicitly instead of silently disappearing", async () => {
    await importMedia();
    await ok("clip", "add", "--asset", "red", "--duration", "f:20");
    const project = await loadProject(dir);
    // 不透明度・トランジション・速度は実装済み。LUT はまだ（graph/video.ts の unsupported）
    (project.tracks[0]!.clips[0] as any).video.lut = "look.cube";
    await saveProject(dir, project);
    const result = await run("render", "-o", join(dir, "out", "effects.mp4"));
    expect(result.error.code).toBe("E_NOT_IMPLEMENTED");
    expect(existsSync(join(dir, "out", "effects.mp4"))).toBe(false);
  });
});
