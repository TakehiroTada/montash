/**
 * コマンド実行コンテキスト: グローバルオプション、プロジェクトディレクトリの解決、actor。
 * docs/04 §1.2, docs/11 §4.6
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { errors } from "./errors.ts";

export type Actor = "ai" | "human" | "web" | "system";

export interface GlobalOptions {
  project?: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  dryRun: boolean;
  yes: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  message?: string;
  body?: string;
  noColor: boolean;
  timeFormat: "frames" | "seconds" | "tc";
}

export interface CommandContext {
  cwd: string;
  globals: GlobalOptions;
  actor: Actor;
  actorDetail: string | undefined;
  env: NodeJS.ProcessEnv;
  /** 実行された引数（bin 以降）。履歴の op.command に記録する */
  argv: string[];
  /** プロジェクトディレクトリ（project.json のあるディレクトリ）。無ければ E_PROJECT_NOT_FOUND */
  requireProjectDir(): string;
  /** プロジェクトディレクトリ（無ければ null） */
  findProjectDir(): string | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const PROJECT_FILE = "project.json";
export const STATE_DIR = ".montash";

/** start から上方向に project.json を探す */
export function findProjectDirFrom(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, PROJECT_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function detectActor(env: NodeJS.ProcessEnv, isTTY: boolean): Actor {
  const a = env.MONTASH_ACTOR;
  if (a === "ai" || a === "human" || a === "web" || a === "system") return a;
  return isTTY ? "human" : "ai";
}

export function createContext(
  globals: GlobalOptions,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; isTTY?: boolean; argv?: string[] } = {},
): CommandContext {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let cached: string | null | undefined;

  const findProjectDir = (): string | null => {
    if (cached !== undefined) return cached;
    const explicit = globals.project ?? env.MONTASH_PROJECT;
    if (explicit) {
      const dir = resolve(cwd, explicit);
      cached = existsSync(join(dir, PROJECT_FILE)) ? dir : null;
    } else {
      cached = findProjectDirFrom(cwd);
    }
    return cached;
  };

  return {
    cwd,
    globals,
    actor: detectActor(env, isTTY),
    actorDetail: env.MONTASH_ACTOR_DETAIL,
    env,
    argv: opts.argv ?? [],
    findProjectDir,
    requireProjectDir() {
      const dir = findProjectDir();
      if (!dir) throw errors.projectNotFound(globals.project ? resolve(cwd, globals.project) : cwd);
      return dir;
    },
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  };
}
