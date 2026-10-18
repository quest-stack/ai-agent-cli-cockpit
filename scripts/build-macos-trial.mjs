import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { icoToPng } from "./icon-png.mjs";

const root = resolve(import.meta.dirname, "..");
const architecture = process.argv[2] ?? process.arch;
if (process.platform !== "darwin" || architecture !== process.arch
  || !["arm64", "x64"].includes(architecture) || process.argv.length > 3) {
  throw new Error("Build on a native Mac: node scripts/build-macos-trial.mjs [arm64|x64]");
}
const output = resolve(root, "release", "mac-trial", architecture);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const run = (script, args = []) => execFileSync(process.execPath,
  [resolve(root, script), ...args], { cwd: root, stdio: "inherit" });
run("scripts/generate-third-party-notices.mjs");
run("scripts/build-editions.mjs", ["--language=ja"]);

// Reuse the existing public icon. Create the Mac formats only in generated
// output; no new binary artwork or tool dependency enters the repository.
const ico = await readFile(resolve(root, "build", "icon.ico"));
const sourcePng = resolve(output, "icon-source.png");
await writeFile(sourcePng, icoToPng(ico));
const iconset = resolve(output, "Cockpit.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync("sips", ["-z", String(size * scale), String(size * scale), sourcePng,
      "--out", resolve(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "pipe" });
  }
}
const icon = resolve(output, "Cockpit.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icon]);
const config = {
  ...manifest.build,
  directories: { ...manifest.build.directories, output },
  extraMetadata: { cockpitLanguage: "ja", cockpitTrial: "macos" },
  files: [
    { from: "dist/editions/ja", to: "dist", filter: ["**/*", "!**/*.map", "!**/*.tsbuildinfo"] },
    "node_modules/**/*", "package.json",
  ],
  extraResources: [
    ...manifest.build.extraResources.filter((entry) => entry.to !== "icon.ico"),
    { from: "docs/MACOS_TRIAL.md", to: "README.md" },
    { from: "docs/PRIVACY.md", to: "docs/PRIVACY.md" },
  ],
  // Build node-pty for the target Electron ABI on this architecture.
  npmRebuild: true,
  mac: {
    icon, category: "public.app-category.developer-tools", minimumSystemVersion: "13.0",
    target: ["dmg", "zip"],
    artifactName: "CLI-Cockpit-${version}-mac-trial-${arch}.${ext}",
    // Local ad-hoc signatures allow native ARM binaries to run, but are not
    // Developer ID signing or notarization. No certificate/secrets are used.
    identity: "-", hardenedRuntime: false, notarize: false,
  },
  dmg: { title: "CLI Cockpit Mac Trial", sign: false },
};
const configPath = resolve(output, "builder.config.json");
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
run("node_modules/electron-builder/out/cli/cli.js",
  ["--config", configPath, "--mac", "dmg", "zip", `--${architecture}`, "--publish", "never"]);
