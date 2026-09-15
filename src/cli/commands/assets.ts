import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative as relativePath, resolve } from "node:path";
import { assetUsage } from "../../core/assets.ts";
import { assertIdAvailable } from "../../core/ids.ts";
import { atomicWrite, loadProject, projectPaths } from "../../core/project.ts";
import { type Asset, AssetSchema, type Fps, type Project } from "../../core/schema.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { durationFrames, probeFile } from "../../ffmpeg/probe.ts";
import { assetCacheDir, proxyEligible, proxyState } from "../../ffmpeg/proxy.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, toMontashError, type Warning, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";

export function requireAsset(project: Project, id: string): Asset {
  const asset = Object.hasOwn(project.assets, id) ? project.assets[id] : undefined;
  if (!asset)
    throw new MontashError("E_ASSET_NOT_FOUND", `asset "${id}" not found`, {
      hint: "Use `montash assets list --json` to find an asset ID.",
    });
  return asset;
}

async function describeAsset(dir: string, project: Project, asset: Asset) {
  return {
    ...asset,
    missing: !existsSync(resolveAssetPath(dir, asset.path)),
    usage: assetUsage(project, asset.id),
    proxy: proxyEligible(asset) ? await proxyState(dir, asset, project) : null,
  };
}

export const assetsList = defineCommand({
  path: "assets list",
  summary: "list imported assets with metadata, usage and proxy state",
  workflows: ["W-02"],
  options: {
    type: { type: "string", describe: "asset type", choices: ["video", "audio", "image", "subtitle", "text"] },
    tag: { type: "string", describe: "filter by tag" },
    unused: { type: "boolean", describe: "only unused assets" },
    missing: { type: "boolean", describe: "only missing source files" },
    search: { type: "string", describe: "search ID, label and path" },
  },
  examples: [
    { cmd: "montash assets list --type video" },
    { cmd: "montash assets list --unused", note: "assets no clip refers to" },
    { cmd: "montash assets list --missing --json", note: "files that moved or were deleted; fix with `assets relink`" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const assets = (await Promise.all(Object.values(project.assets).map((a) => describeAsset(dir, project, a)))).filter(
      (a) =>
        (!args.type || a.type === args.type) &&
        (!args.tag || a.tags.includes(String(args.tag))) &&
        (!args.unused || a.usage.clips.length === 0) &&
        (!args.missing || a.missing) &&
        (!args.search ||
          `${a.id} ${a.label ?? ""} ${a.path}`.toLowerCase().includes(String(args.search).toLowerCase())),
    );
    return {
      result: { assets },
      human:
        assets
          .map(
            (a) =>
              `${a.id}  ${a.type}  ${a.duration_f ?? "-"} frames  proxy:${a.proxy ?? "n/a"}  clips:${a.usage.clips.length}  ${a.path}`,
          )
          .join("\n") || "no assets",
    };
  },
});

export const assetsShow = defineCommand({
  path: "assets show",
  summary: "show asset metadata, usage and optionally raw ffprobe data",
  workflows: ["W-02"],
  positionals: [{ name: "id", describe: "asset ID", required: true }],
  options: { probe: { type: "boolean", describe: "include raw ffprobe JSON" } },
  examples: [{ cmd: "montash assets show clip_a --probe", note: "include the raw ffprobe result" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const asset = requireAsset(project, String(args.id));
    let probe: unknown;
    if (args.probe && ["video", "audio", "image"].includes(asset.type)) {
      const cache = join(assetCacheDir(dir, asset.id), "probe.json");
      try {
        probe = await Bun.file(cache).json();
      } catch {
        probe = (await probeFile(locateBinaries({ ...ctx.globals, env: ctx.env }), resolveAssetPath(dir, asset.path)))
          .raw;
        if (!ctx.globals.dryRun) {
          await mkdir(assetCacheDir(dir, asset.id), { recursive: true });
          await atomicWrite(cache, JSON.stringify(probe));
        }
      }
    }
    const text = asset.type === "text" ? await Bun.file(resolveAssetPath(dir, asset.path)).text() : undefined;
    return {
      result: {
        asset: await describeAsset(dir, project, asset),
        ...(probe === undefined ? {} : { probe }),
        ...(text === undefined ? {} : { text }),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 素材管理（docs/04 §4, W-13 / W-17）
// ---------------------------------------------------------------------------

/** `--tags a,b` / 配列のどちらでも受け、トリム・空要素除去・重複除去した一覧にする */
function toTagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : String(value).split(",");
  const out: string[] = [];
  for (const t of raw.flatMap((v) => v.split(","))) {
    const tag = t.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** ハイフン付きオプションは yargs が camelCase も生やすが、ハンドラ直呼び出しでは両方受ける */
function option(args: Record<string, unknown>, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return args[camel] ?? args[name];
}

/** `hash_head` の接頭辞からアルゴリズムを読む（import は sha256、docs/05 の例は sha1） */
function hashAlgorithm(hashHead: string | undefined): "sha1" | "sha256" {
  return hashHead?.startsWith("sha1:") ? "sha1" : "sha256";
}

/** 先頭 1MB のハッシュ（relink の照合と素材の指紋に使う） */
async function hashHeadOfFile(path: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const s = await stat(path);
  const head = Buffer.alloc(Math.min(s.size, 1024 * 1024));
  const file = await open(path, "r");
  try {
    await file.read(head, 0, head.length, 0);
  } finally {
    await file.close();
  }
  return `${algorithm}:${new Bun.CryptoHasher(algorithm).update(head).digest("hex")}`;
}

function hashBuffer(data: Uint8Array, algorithm: "sha1" | "sha256" = "sha256"): string {
  const head = data.subarray(0, 1024 * 1024);
  return `${algorithm}:${new Bun.CryptoHasher(algorithm).update(head).digest("hex")}`;
}

/** テキスト素材の派生メタデータ（docs/05 §5: 先頭 80 文字と行数） */
function textMeta(text: string): { text_preview: string; line_count: number } {
  return { text_preview: text.slice(0, 80), line_count: text.split(/\r?\n/).length };
}

function decodeUtf8(bytes: ArrayBuffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new MontashError("E_ASSET_UNREADABLE", `${path} is not valid UTF-8 text`, {
      hint: "Convert the file to UTF-8 and retry.",
      detail: { path },
      cause: e,
    });
  }
}

/** `--text` / `--text-file` のどちらか一方から本文を読む */
async function readTextInput(ctx: CommandContext, args: Record<string, unknown>): Promise<string> {
  const text = args.text;
  const file = option(args, "text-file");
  if ((text === undefined) === (file === undefined)) throw errors.usage("use either --text or --text-file");
  if (text !== undefined) return String(text);
  const path = resolve(ctx.cwd, String(file));
  let bytes: ArrayBuffer;
  try {
    bytes = await Bun.file(path).arrayBuffer();
  } catch (e) {
    throw new MontashError("E_ASSET_MISSING", `cannot read ${path}`, {
      hint: "Check the path passed to --text-file.",
      detail: { path },
      cause: e,
    });
  }
  return decodeUtf8(bytes, path);
}

export const assetsSet = defineCommand({
  path: "assets set",
  summary: "set display metadata (label, tags, color, note); the ID cannot be changed",
  workflows: ["W-17"],
  mutates: true,
  positionals: [{ name: "id", describe: "asset ID", required: true }],
  options: {
    label: { type: "string", describe: "display label (empty string clears it)" },
    tags: { type: "string", describe: "replace all tags (comma separated)" },
    "add-tag": { type: "array", describe: "add a tag (repeatable)" },
    "remove-tag": { type: "array", describe: "remove a tag (repeatable)" },
    color: { type: "string", describe: "hex color such as #3B82F6 (empty string clears it)" },
    note: { type: "string", describe: "free-form note (empty string clears it)" },
  },
  examples: [{ cmd: 'montash assets set clip_a --label "冒頭ドローン" --tags 空撮,冒頭' }],
  async handler(ctx, args) {
    const addTags = option(args, "add-tag");
    const removeTags = option(args, "remove-tag");
    if ([args.label, args.tags, addTags, removeTags, args.color, args.note].every((v) => v === undefined))
      throw errors.usage("specify at least one of --label, --tags, --add-tag, --remove-tag, --color, --note");
    return runMutation(ctx, ({ project, before }) => {
      const id = String(args.id);
      const asset = requireAsset(project, id);
      if (args.label !== undefined) {
        if (String(args.label) === "") delete asset.label;
        else asset.label = String(args.label);
      }
      if (args.note !== undefined) {
        if (String(args.note) === "") delete asset.note;
        else asset.note = String(args.note);
      }
      if (args.color !== undefined) {
        const color = String(args.color);
        if (color === "") delete asset.color;
        else if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color))
          throw errors.usage(`invalid --color "${color}"`, "Use a hex color such as #3B82F6.");
        else asset.color = color;
      }
      if (args.tags !== undefined) asset.tags = toTagList(args.tags);
      if (addTags !== undefined)
        for (const tag of toTagList(addTags)) if (!asset.tags.includes(tag)) asset.tags.push(tag);
      if (removeTags !== undefined) {
        const drop = toTagList(removeTags);
        asset.tags = asset.tags.filter((t) => !drop.includes(t));
      }
      const changed = JSON.stringify(asset) !== JSON.stringify(before.assets[id]);
      return {
        result: { asset },
        summary: `set metadata of asset ${id}`,
        changed,
        affects: { clips: assetUsage(project, id).clips.map((c) => c.id), range_f: null },
        human: `${id}  ${asset.label ?? "-"}  tags:[${asset.tags.join(", ")}]${asset.color ? `  ${asset.color}` : ""}`,
      };
    });
  },
});

export const assetsNewText = defineCommand({
  path: "assets new-text",
  summary: "create assets/text/<id>.txt and register it as a reusable text asset",
  workflows: ["W-17"],
  mutates: true,
  positionals: [{ name: "id", describe: "new asset ID", required: true }],
  options: {
    text: { type: "string", describe: "text body" },
    "text-file": { type: "string", describe: "read the body from a UTF-8 file" },
    label: { type: "string", describe: "display label" },
    tags: { type: "string", describe: "tags (comma separated)" },
  },
  examples: [{ cmd: 'montash assets new-text title_main --text "Summer Trip 2026"' }],
  async handler(ctx, args) {
    const body = await readTextInput(ctx, args);
    return runMutation(ctx, async ({ project, dir }) => {
      const id = String(args.id);
      assetCacheDir(dir, id); // ID が安全な文字だけか（パスにするため）
      assertIdAvailable(project, id); // E_ID_EXISTS
      const relative = join("assets", "text", `${id}.txt`);
      const full = join(dir, relative);
      if (existsSync(full))
        throw new MontashError("E_OUTPUT_EXISTS", `${full} already exists`, {
          hint: "Choose another ID, or remove the stale file first.",
          detail: { path: full },
        });
      const bytes = new TextEncoder().encode(body);
      if (!ctx.globals.dryRun) {
        await mkdir(dirname(full), { recursive: true });
        await atomicWrite(full, body);
      }
      const asset = AssetSchema.parse({
        id,
        type: "text",
        path: relative,
        owned: true,
        imported_by: ctx.actor,
        imported_at: new Date().toISOString(),
        size: bytes.byteLength,
        mtime: (ctx.globals.dryRun ? new Date() : (await stat(full)).mtime).toISOString(),
        hash_head: hashBuffer(bytes),
        duration_s: null,
        duration_f: null,
        tags: args.tags === undefined ? [] : toTagList(args.tags),
        ...(args.label === undefined ? {} : { label: String(args.label) }),
        ...textMeta(body),
      });
      project.assets[id] = asset;
      return {
        result: { asset },
        summary: `create text asset ${id}`,
        human: `${id}  text  ${relative}\n  ${asset.type === "text" ? asset.text_preview : ""}`,
      };
    });
  },
});

export const assetsSetText = defineCommand({
  path: "assets set-text",
  summary: "rewrite the body of a project-owned text asset",
  workflows: ["W-17"],
  mutates: true,
  positionals: [{ name: "id", describe: "text asset ID", required: true }],
  options: {
    text: { type: "string", describe: "new text body" },
    "text-file": { type: "string", describe: "read the new body from a UTF-8 file" },
  },
  examples: [{ cmd: 'montash assets set-text title_main --text "Summer Trip 2027"' }],
  async handler(ctx, args) {
    const body = await readTextInput(ctx, args);
    return runMutation(ctx, async ({ project, dir }) => {
      const id = String(args.id);
      const asset = requireAsset(project, id);
      if (asset.type !== "text")
        throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${id}" is a ${asset.type} asset, not text`, {
          hint: "Use `montash assets new-text <id> --text ...` to create a text asset.",
          detail: { asset: id, type: asset.type },
        });
      if (!asset.owned)
        throw new MontashError("E_ASSET_NOT_OWNED", `text asset "${id}" is an imported external file`, {
          hint: `Re-import it with \`montash import ${asset.path} --copy\` (or use \`assets new-text\`) so montash owns the file; montash never rewrites external sources.`,
          detail: { asset: id, path: asset.path },
        });
      const full = resolveAssetPath(dir, asset.path);
      const bytes = new TextEncoder().encode(body);
      if (!ctx.globals.dryRun) {
        await mkdir(dirname(full), { recursive: true });
        await atomicWrite(full, body);
      }
      asset.size = bytes.byteLength;
      asset.mtime = (ctx.globals.dryRun ? new Date() : (await stat(full)).mtime).toISOString();
      asset.hash_head = hashBuffer(bytes, hashAlgorithm(asset.hash_head));
      Object.assign(asset, textMeta(body));
      return {
        result: { asset },
        summary: `update text asset ${id}`,
        affects: { clips: assetUsage(project, id).clips.map((c) => c.id), range_f: null },
        human: `${id}  ${asset.line_count} line(s)\n  ${asset.text_preview}`,
      };
    });
  },
});

export const assetsRemove = defineCommand({
  path: "assets remove",
  summary: "remove an asset (with --force, also the clips that reference it)",
  workflows: ["W-02", "W-17"],
  mutates: true,
  positionals: [{ name: "id", describe: "asset ID", required: true }],
  options: { force: { type: "boolean", describe: "also delete referencing clips, linked clips and transitions" } },
  examples: [{ cmd: "montash assets remove clip_x" }, { cmd: "montash assets remove clip_x --force" }],
  async handler(ctx, args) {
    return runMutation(ctx, async ({ project, dir }) => {
      const id = String(args.id);
      const asset = requireAsset(project, id);
      const usage = assetUsage(project, id);
      if (usage.clips.length > 0 && !args.force)
        throw new MontashError("E_ASSET_IN_USE", `asset "${id}" is used by ${usage.clips.length} clip(s)`, {
          hint: "Delete or repoint those clips first, or pass --force to remove them together with the asset.",
          detail: { asset: id, clips: usage.clips },
        });

      // 参照クリップ＋その link 相手（映像／音声のペア）をまとめて消す
      const doomed = new Set(usage.clips.map((c) => c.id));
      for (const track of project.tracks)
        for (const clip of track.clips) {
          const link = (clip as { link?: string | null }).link;
          if (doomed.has(clip.id) && typeof link === "string") doomed.add(link);
        }
      const removedClips: Array<{ id: string; track: string }> = [];
      for (const track of project.tracks) {
        track.clips = track.clips.filter((clip) => {
          if (!doomed.has(clip.id)) return true;
          removedClips.push({ id: clip.id, track: track.id });
          return false;
        });
        // 生き残ったクリップのリンク切れを解消する（§14.6）
        for (const clip of track.clips) {
          const link = (clip as { link?: string | null }).link;
          if (typeof link === "string" && doomed.has(link)) (clip as { link: string | null }).link = null;
        }
      }
      const removedTransitions = project.transitions.filter((t) => doomed.has(t.from) || doomed.has(t.to));
      project.transitions = project.transitions.filter((t) => !doomed.has(t.from) && !doomed.has(t.to));
      delete project.assets[id];

      const removedFiles: string[] = [];
      if (!ctx.globals.dryRun) {
        // プロジェクトが所有するテキスト素材だけは実体も消す（assets/ 配下に限る）
        const full = resolveAssetPath(dir, asset.path);
        const inside = !relativePath(projectPaths(dir).assetsDir, full).startsWith("..");
        if (asset.owned && asset.type === "text" && inside && existsSync(full)) {
          await rm(full, { force: true });
          removedFiles.push(full);
        }
        const cache = assetCacheDir(dir, id);
        if (existsSync(cache)) {
          await rm(cache, { recursive: true, force: true });
          removedFiles.push(cache);
        }
      }
      return {
        result: {
          removed: id,
          clips: removedClips,
          transitions: removedTransitions.map((t) => t.id),
          files: removedFiles,
        },
        summary: `remove asset ${id}${removedClips.length ? ` and ${removedClips.length} clip(s)` : ""}`,
        affects: { clips: removedClips.map((c) => c.id), range_f: null },
        warnings: removedTransitions.map((t) =>
          warning("W_TRANSITION_REMOVED", `transition ${t.id} (${t.from} → ${t.to}) was removed with its clips`, {
            detail: { transition: t.id, track: t.track },
          }),
        ),
        human: `removed ${id}${removedClips.length ? `; clips: ${removedClips.map((c) => c.id).join(", ")}` : ""}${removedTransitions.length ? `; transitions: ${removedTransitions.map((t) => t.id).join(", ")}` : ""}`,
      };
    });
  },
});

/** relink の照合方法（既定の優先順位。`--match` で先頭に持ってくる） */
const MATCH_STRATEGIES = ["name", "size", "hash"] as const;
type MatchStrategy = (typeof MATCH_STRATEGIES)[number];

/** `--search` 用の候補ファイル */
interface Candidate {
  path: string;
  /** NFC 正規化したファイル名（macOS の NFD 名と Linux の NFC 名を同一視する） */
  name: string;
  size: number;
  hashes: Map<string, string>;
}

/** 走査するディレクトリの深さ上限とファイル数上限（暴走防止） */
const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_FILES = 50_000;

async function collectCandidates(root: string, out: Candidate[] = [], depth = 0): Promise<Candidate[]> {
  if (depth > MAX_SEARCH_DEPTH || out.length >= MAX_SEARCH_FILES) return out;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (depth === 0)
      throw new MontashError("E_ASSET_MISSING", `cannot read search directory ${root}`, {
        hint: "Check the path passed to --search.",
        detail: { path: root },
        cause: e,
      });
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(root, entry.name);
    // ディレクトリのシンボリックリンクは辿らない（循環を避ける）
    if (entry.isDirectory()) await collectCandidates(child, out, depth + 1);
    else if (entry.isFile()) {
      if (out.length >= MAX_SEARCH_FILES) break;
      out.push({ path: child, name: entry.name.normalize("NFC"), size: (await stat(child)).size, hashes: new Map() });
    }
  }
  return out;
}

async function candidateHash(candidate: Candidate, algorithm: "sha1" | "sha256"): Promise<string> {
  const cached = candidate.hashes.get(algorithm);
  if (cached !== undefined) return cached;
  const hash = await hashHeadOfFile(candidate.path, algorithm);
  candidate.hashes.set(algorithm, hash);
  return hash;
}

async function matches(asset: Asset, candidate: Candidate, strategy: MatchStrategy): Promise<boolean> {
  if (strategy === "name") return candidate.name === basename(asset.path).normalize("NFC");
  if (strategy === "size") return asset.size !== undefined && candidate.size === asset.size;
  if (asset.hash_head === undefined) return false;
  return (await candidateHash(candidate, hashAlgorithm(asset.hash_head))) === asset.hash_head;
}

/**
 * 再リンク後のメタデータ更新。ffprobe で尺などを取り直し、派生物（proxy / thumbs / waveform）は stale にする。
 */
async function refreshRelinked(ctx: CommandContext, dir: string, asset: Asset, full: string, fps: Fps): Promise<void> {
  const s = await stat(full);
  asset.path = full;
  asset.size = s.size;
  asset.mtime = s.mtime.toISOString();
  asset.hash_head = await hashHeadOfFile(full, hashAlgorithm(asset.hash_head));
  if (asset.type === "text") {
    Object.assign(asset, textMeta(decodeUtf8(await Bun.file(full).arrayBuffer(), full)));
  } else if (asset.type !== "subtitle") {
    const probe = await probeFile(locateBinaries({ ...ctx.globals, env: ctx.env }), full);
    const { container, ...summary } = probe.summary;
    asset.duration_s = summary.duration_s;
    asset.duration_f = summary.duration_s === null ? null : durationFrames(summary.duration_s, fps);
    asset.start_time_s = summary.start_time_s;
    const containerInfo = {
      format: container.format,
      ...(container.bit_rate === null ? {} : { bit_rate: container.bit_rate }),
    };
    if (asset.type === "video") {
      if (summary.video) asset.video = { ...summary.video };
      asset.audio = summary.audio ? { ...summary.audio } : null;
      asset.container = containerInfo;
    } else if (asset.type === "audio") {
      if (summary.audio) asset.audio = { ...summary.audio };
      asset.container = containerInfo;
    } else if (summary.video) {
      asset.video = { ...summary.video };
    }
    if (!ctx.globals.dryRun) {
      const cache = assetCacheDir(dir, asset.id);
      await mkdir(cache, { recursive: true });
      await atomicWrite(join(cache, "probe.json"), JSON.stringify(probe.raw));
    }
  }
  // 元ファイルが変わったので派生物は作り直しが必要
  for (const key of ["proxy", "thumbs", "waveform"]) {
    const entry = asset.derived?.[key];
    if (asset.derived && entry) asset.derived[key] = { ...entry, state: "stale" };
  }
}

export const assetsRelink = defineCommand({
  path: "assets relink",
  summary: "point missing assets at their new location by path or directory search",
  workflows: ["W-13", "W-17"],
  mutates: true,
  positionals: [{ name: "id", describe: "asset ID (default: every missing asset)" }],
  options: {
    path: { type: "string", describe: "new file path (requires an asset ID)" },
    search: { type: "string", describe: "directory to search recursively" },
    match: {
      type: "string",
      describe: "matching rule to try first (default order: name, size, hash)",
      choices: [...MATCH_STRATEGIES],
    },
  },
  examples: [
    { cmd: "montash assets relink --search /Volumes/ext/raw --json" },
    { cmd: "montash assets relink clip_a --path /Volumes/ext/raw/clip_a.mp4" },
  ],
  async handler(ctx, args) {
    const byPath = args.path !== undefined;
    const bySearch = args.search !== undefined;
    if (byPath === bySearch) throw errors.usage("use either --path or --search");
    if (byPath && args.id === undefined) throw errors.usage("--path requires an asset ID");
    const order: MatchStrategy[] = args.match
      ? [args.match as MatchStrategy, ...MATCH_STRATEGIES.filter((s) => s !== args.match)]
      : [...MATCH_STRATEGIES];

    return runMutation(ctx, async ({ project, dir, fps }) => {
      const targets = args.id
        ? [requireAsset(project, String(args.id))]
        : Object.values(project.assets).filter((a) => !existsSync(resolveAssetPath(dir, a.path)));
      const relinked: Array<{ id: string; from: string; to: string; matched_by: string }> = [];
      const unresolved: string[] = [];
      const warnings: Warning[] = [];

      if (byPath) {
        const asset = targets[0]!;
        const full = resolve(ctx.cwd, String(args.path));
        if (!existsSync(full))
          throw new MontashError("E_ASSET_MISSING", `no file at ${full}`, {
            hint: "Pass an existing file path, or use --search <dir> to look for it.",
            detail: { path: full },
          });
        const from = asset.path;
        await refreshRelinked(ctx, dir, asset, full, fps);
        relinked.push({ id: asset.id, from, to: full, matched_by: "path" });
      } else {
        const root = resolve(ctx.cwd, String(args.search));
        const candidates = await collectCandidates(root);
        for (const asset of targets) {
          let found: { path: string; matched_by: MatchStrategy } | null = null;
          for (const strategy of order) {
            for (const candidate of candidates) {
              if (await matches(asset, candidate, strategy)) {
                found = { path: candidate.path, matched_by: strategy };
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            unresolved.push(asset.id);
            continue;
          }
          const from = asset.path;
          try {
            await refreshRelinked(ctx, dir, asset, found.path, fps);
          } catch (e) {
            // 読めないファイルに繋ぎ替えても壊れるだけなので元のパスに戻す
            asset.path = from;
            unresolved.push(asset.id);
            warnings.push(warning("W_RELINK_FAILED", `${asset.id}: ${toMontashError(e).message}`));
            continue;
          }
          relinked.push({ id: asset.id, from, to: found.path, matched_by: found.matched_by });
        }
      }
      return {
        result: { relinked, unresolved },
        summary: `relink ${relinked.length} asset(s)`,
        changed: relinked.length > 0,
        warnings,
        human:
          [
            ...relinked.map((r) => `${r.id}  ${r.matched_by}  ${r.to}`),
            ...unresolved.map((id) => `${id}  unresolved`),
          ].join("\n") || "nothing to relink",
      };
    });
  },
});
