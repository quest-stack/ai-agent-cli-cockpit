import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const architecture = process.argv[2] ?? process.arch;
if (process.platform !== "darwin" || architecture !== process.arch
  || !["arm64", "x64"].includes(architecture)) throw new Error("Collect on the native Mac runner.");
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const output = resolve(root, "release", "ci", `mac-${architecture}`);
await mkdir(output, { recursive: true });
const installers = [];
for (const extension of ["dmg", "zip"]) {
  const name = `CLI-Cockpit-${manifest.version}-mac-trial-${architecture}.${extension}`;
  const source = resolve(root, "release", "mac-trial", architecture, name);
  const content = await readFile(source);
  if (extension === "zip" && content.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP.");
  if (extension === "dmg" && content.subarray(-512, -508).toString("ascii") !== "koly") throw new Error("Invalid DMG.");
  installers.push({ name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  await copyFile(source, resolve(output, name));
}
for (const [source, name] of [
  ["docs/MACOS_TRIAL.md", "README.md"], ["docs/PRIVACY.md", "PRIVACY.md"],
  ["LICENSE", "LICENSE"], ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
]) await copyFile(resolve(root, source), resolve(output, name));
await writeFile(resolve(output, "checksums-sha256.txt"),
  installers.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n") + "\n", "utf8");
await writeFile(resolve(output, "build-metadata.json"), JSON.stringify({
  project: "AI Agent CLI Cockpit", version: manifest.version, architecture,
  platform: "darwin", edition: "ja", signing: "ad-hoc; not notarized", trial: true,
  repository: process.env.GITHUB_REPOSITORY ?? null, commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ?? null, electron: manifest.devDependencies.electron, installers,
}, null, 2) + "\n", "utf8");
console.log(`Collected Mac trial ${architecture}: ${installers.map((item) => item.name).join(", ")}`);
