/**
 * 配布物に同梱する第三者ライセンス表記を生成する。
 *
 * MIT や BSD は「著作権表示とライセンス本文を添えること」を再配布の条件に
 * している。これが無いまま配ると条件違反になるため、手書きではなく
 * 実際の node_modules を辿って機械的に集める。
 *
 * 対象は package.json の dependencies から到達できるものだけ。devDependencies
 * （ビルドツール）は配布物に入らないので含めない。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** node_modules から package.json を探す（ネストにも対応）。 */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** ライセンス本文らしきファイルを拾う。 */
function readLicenseText(pkgDir) {
  let names = [];
  try {
    names = readdirSync(pkgDir);
  } catch {
    return undefined;
  }
  const hit = names.find((n) => /^(LICENSE|LICENCE|COPYING)($|[.\-_])/i.test(n));
  if (!hit) return undefined;
  try {
    return readFileSync(join(pkgDir, hit), "utf8").trim();
  } catch {
    return undefined;
  }
}

const seen = new Map();
const queue = Object.keys(rootPkg.dependencies ?? {}).map((n) => [n, root]);

while (queue.length > 0) {
  const [name, fromDir] = queue.shift();
  if (seen.has(name)) continue;
  const pkgDir = resolvePkgDir(name, fromDir);
  if (!pkgDir) continue;

  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const license =
    typeof pkg.license === "string"
      ? pkg.license
      : pkg.license?.type ?? "UNKNOWN";
  seen.set(name, {
    license,
    name,
    text: readLicenseText(pkgDir),
    version: pkg.version,
  });

  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    queue.push([dep, pkgDir]);
  }
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = entries.filter((e) => !e.text);

const lines = [
  "# Third-party software licenses / 第三者ソフトウェアのライセンス",
  "",
  "CLI Cockpit は次のオープンソースソフトウェアを利用しています。",
  "各ソフトウェアの著作権は、それぞれの権利者に帰属します。",
  "CLI Cockpit uses the following open-source software. Copyright belongs to each respective owner.",
  "",
  `Packages / 対象: ${entries.length}`,
  "",
  "---",
  "",
];

for (const entry of entries) {
  lines.push(`## ${entry.name} v${entry.version}`, "", `License: ${entry.license}`, "");
  if (entry.text) lines.push("```", entry.text, "```", "");
  lines.push("---", "");
}

writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"), "utf8");

console.log(`生成: ${entries.length} パッケージ`);
const counts = {};
for (const e of entries) counts[e.license] = (counts[e.license] ?? 0) + 1;
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)} ${k}`);
}
if (missing.length > 0) {
  console.log("ライセンス本文が見つからない（要確認）:");
  for (const m of missing) console.log(`  ${m.name} (${m.license})`);
}
