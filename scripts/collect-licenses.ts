/**
 * 直接依存のライセンス一覧と、全依存のライセンス種別の内訳を出力する。
 * THIRD-PARTY-NOTICES.md を更新するときに使う（`bun run licenses`）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Row {
  name: string;
  version: string;
  license: string;
  repo: string;
}

function licenseOf(pkg: Record<string, unknown>): string {
  const lic = pkg.license;
  if (typeof lic === "string") return lic;
  if (lic && typeof lic === "object" && "type" in lic) return String((lic as { type: unknown }).type);
  const licenses = pkg.licenses;
  if (Array.isArray(licenses)) return licenses.map((l: { type?: string }) => l.type ?? "?").join(" OR ");
  return "UNKNOWN";
}

function repoOf(pkg: Record<string, unknown>): string {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : ((r as { url?: string } | undefined)?.url ?? "");
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const direct = { ...(root.dependencies ?? {}), ...(root.devDependencies ?? {}) };
const rows: Row[] = [];
for (const [name, range] of Object.entries(direct)) {
  const p = join("node_modules", name, "package.json");
  if (!existsSync(p)) {
    rows.push({ name, version: String(range), license: "NOT INSTALLED", repo: "" });
    continue;
  }
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  rows.push({ name, version: String(pkg.version), license: licenseOf(pkg), repo: repoOf(pkg) });
}

// 推移的依存も含めた内訳
const all = new Map<string, string>();
const walk = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (entry.startsWith("@")) {
      walk(full);
      continue;
    }
    const pj = join(full, "package.json");
    if (!existsSync(pj)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      if (typeof pkg.name === "string") all.set(pkg.name, licenseOf(pkg));
    } catch {
      // package.json が壊れているものは数えない
    }
  }
};
walk("node_modules");

const counts = new Map<string, number>();
for (const lic of all.values()) counts.set(lic, (counts.get(lic) ?? 0) + 1);

console.log("| パッケージ | バージョン | ライセンス | リポジトリ |");
console.log("|---|---|---|---|");
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`| ${r.name} | ${r.version} | ${r.license} | ${r.repo} |`);
}
console.log("");
console.log("全依存の内訳:");
for (const [lic, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${lic}: ${n}`);
console.log(`  合計: ${all.size} パッケージ`);

const risky = [...all].filter(([, lic]) => /GPL|AGPL/i.test(lic) && !/LGPL/i.test(lic));
if (risky.length > 0) {
  console.error("\n注意: コピーレフトの依存があります:");
  for (const [name, lic] of risky) console.error(`  ${name}: ${lic}`);
  process.exit(1);
}
