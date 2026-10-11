import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const architecture = args[0]?.replace(/^--arch=/u, "");
if (args.length !== 1 || !/^--arch=(?:arm64|x64)$/u.test(args[0])) {
  throw new Error("Usage: collect-ci-artifacts.mjs --arch=arm64|x64");
}
if (process.platform !== "win32" || process.arch !== architecture) {
  throw new Error("Build and collect on Windows with the target architecture's native Node.js.");
}

const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(manifest.version)) {
  throw new Error("Unexpected package version.");
}
const commit = process.env.GITHUB_SHA ?? null;
if (commit !== null && !/^[a-f0-9]{40}$/u.test(commit)) {
  throw new Error("Unexpected GitHub commit SHA.");
}
const runId = process.env.GITHUB_RUN_ID ?? null;
if (runId !== null && !/^\d+$/u.test(runId)) {
  throw new Error("Unexpected GitHub run ID.");
}
const repository = "quest-stack/ai-agent-cli-cockpit";
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) {
  throw new Error("Build metadata must identify this project's repository.");
}

const output = resolve(root, "release", "ci", architecture);
const installers = [];
// Read both expected installers first. A missing edition must fail the job.
for (const language of ["ja", "en"]) {
  const fileName = `CLI-Cockpit-${manifest.version}${language === "en" ? "-en" : ""}-win-${architecture}.exe`;
  const source = resolve(root, "release", manifest.version, language, fileName);
  const content = await readFile(source);
  if (content.length < 2 || content[0] !== 0x4d || content[1] !== 0x5a) {
    throw new Error(`Expected a Windows executable: ${fileName}`);
  }
  installers.push({
    source,
    language,
    fileName,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

await mkdir(output, { recursive: true });
const expectedFiles = new Set([
  ...installers.map(({ fileName }) => fileName),
  "CODE_SIGNING_POLICY.md", "PRIVACY.md", "LICENSE", "THIRD-PARTY-NOTICES.md",
  "checksums-sha256.txt", "build-metadata.json",
]);
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!entry.isFile() || !expectedFiles.has(entry.name)) {
    throw new Error(`Unexpected old artifact in release/ci/${architecture}: ${entry.name}`);
  }
}
for (const installer of installers) {
  await copyFile(installer.source, resolve(output, installer.fileName));
}
for (const [source, name] of [
  ["docs/CODE_SIGNING_POLICY.md", "CODE_SIGNING_POLICY.md"],
  ["docs/PRIVACY.md", "PRIVACY.md"],
  ["LICENSE", "LICENSE"],
  ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
]) {
  await copyFile(resolve(root, source), resolve(output, name));
}
await writeFile(resolve(output, "checksums-sha256.txt"), installers.map(
  ({ sha256, fileName }) => `${sha256}  ${fileName}`,
).join("\n") + "\n", "utf8");
await writeFile(resolve(output, "build-metadata.json"), JSON.stringify({
  project: "AI Agent CLI Cockpit",
  version: manifest.version,
  architecture,
  signingStatus: "unsigned",
  repository: `https://github.com/${repository}`,
  commit,
  workflowRun: runId === null ? null : `https://github.com/${repository}/actions/runs/${runId}`,
  nodeVersion: process.version,
  electronVersion: manifest.devDependencies.electron,
  installers: installers.map(({ language, fileName, bytes, sha256 }) => ({
    language, fileName, bytes, sha256,
  })),
}, null, 2) + "\n", "utf8");
console.log(`Collected ${installers.length} unsigned installers in release/ci/${basename(output)}.`);
