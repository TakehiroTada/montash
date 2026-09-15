#!/usr/bin/env bun
import { toSchema } from "../src/cli/define-command.ts";
/**
 * 仕様（docs/04）と実装（`montash schema`）の乖離を検出する（docs/13 C-5）。
 *
 * これまで「docs/04 §1.9 の実装状況表」は手作業で `montash schema --json` と突き合わせていた。
 * 実際に #31 では表が古いまま「実装済みのものを未実装」と書いていて、手で直している。
 * 同じことが起きないよう、**表の記述と実装を機械で突き合わせて食い違いだけを報告**する。
 *
 * 判定するのは 2 方向:
 *   1. §1.9 が「未実装」と書いているのに **実装されている**（表が古い）
 *   2. docs/04 が見出しで定義しているのに **実装にも §1.9 にも無い**（仕様の書き漏れ / 実装漏れの候補）
 *
 * 生成はしない（表の文面は人が書く）。`bun run check:spec` で実行し、食い違いがあれば非 0 で終わる。
 */
import { getCommands } from "../src/registry/commands.ts";

const DOC = "docs/04-cli-spec.md";

/** §1.9 の「未実装のコマンド」表から、1 列目のコマンドパスを拾う */
function declaredUnimplemented(doc: string): string[] {
  const section = doc.slice(doc.indexOf("### 1.9 実装状況"));
  const body = section.slice(0, section.indexOf("\n## "));
  const start = body.indexOf("**未実装のコマンド**");
  const end = body.indexOf("**M4 で実装済みになったもの**");
  const table = body.slice(start, end === -1 ? undefined : end);
  const out: string[] = [];
  for (const line of table.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cell = trimmed.split("|")[1];
    if (cell === undefined) continue;
    // 1 セルに複数書ける: `batch` / `explain`、`clip link` / `clip unlink` など
    for (const quoted of cell.matchAll(/`([^`]+)`/g)) {
      const value = quoted[1];
      if (value === undefined) continue;
      // `snapshot save|restore|list|delete` のような書き方は 1 コマンドずつに割る
      const [head, ...rest] = value.split(" ");
      if (head === undefined) continue;
      const last = rest[rest.length - 1];
      if (last?.includes("|")) {
        rest.pop();
        for (const sub of last.split("|")) out.push([head, ...rest, sub].join(" "));
      } else {
        out.push(value);
      }
    }
  }
  return [...new Set(out.map((s) => s.replace(/\s+<.*$/, "").trim()))].filter(Boolean);
}

/** docs/04 の見出し `### \`montash <path> ...\`` から、仕様が定義しているコマンドを拾う */
function documentedCommands(doc: string): string[] {
  const out: string[] = [];
  for (const line of doc.split("\n")) {
    const m = /^###\s+`montash\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/.exec(line);
    if (m?.[1]) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

const doc = await Bun.file(DOC).text();
const implemented = new Set((await getCommands()).map((c) => toSchema(c).path));
const unimplemented = declaredUnimplemented(doc);
const documented = documentedCommands(doc);

const problems: string[] = [];

// 1. 「未実装」と書いてあるのに実装されている
for (const path of unimplemented) {
  if (implemented.has(path))
    problems.push(`§1.9 は \`${path}\` を未実装としているが、実装されている（表を更新すること）`);
}

// 2. 仕様が見出しで定義しているのに、実装にも §1.9 にも無い
const unimplementedSet = new Set(unimplemented);
for (const path of documented) {
  if (implemented.has(path) || unimplementedSet.has(path)) continue;
  // グループ見出し（`montash clip` など、それ自体はコマンドでない）は無視する
  if ([...implemented].some((p) => p.startsWith(`${path} `))) continue;
  problems.push(`docs/04 は \`${path}\` を定義しているが、実装にも §1.9 の未実装表にも無い`);
}

const summary = `commands: ${implemented.size} implemented / ${unimplemented.length} declared unimplemented / ${documented.length} documented`;
if (problems.length === 0) {
  console.log(`spec drift: none  (${summary})`);
  process.exit(0);
}
console.error(`spec drift: ${problems.length} problem(s)  (${summary})\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error(`\n${DOC} の §1.9 を実装に合わせて直すか、実装を仕様に合わせてください。`);
process.exit(1);
