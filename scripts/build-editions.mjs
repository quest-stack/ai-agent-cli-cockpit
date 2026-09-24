import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const language = args.find((arg) => arg.startsWith("--language="))?.split("=")[1] ?? "all";
const architecture = args.find((arg) => arg.startsWith("--arch="))?.split("=")[1] ?? "all";
if (!["ja", "en", "all"].includes(language) || !["arm64", "x64", "all"].includes(architecture)
  || args.some((arg) => arg !== "--package" && !/^--(?:language|arch)=/u.test(arg))) {
  throw new Error("Usage: build-editions.mjs [--language=ja|en|all] [--package] [--arch=arm64|x64|all]");
}
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const languages = language === "all" ? ["ja", "en"] : [language];
const archArgs = architecture === "all" ? ["--arm64", "--x64"] : [`--${architecture}`];

function run(script, commandArgs, env) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...commandArgs], {
    cwd: root, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status ?? result.signal}`);
}

if (args.includes("--package")) run("scripts/generate-third-party-notices.mjs", [], {});

for (const edition of languages) {
  const editionRoot = resolve(root, "dist", "editions", edition);
  // Delete only the selected generated edition, never dist/release as a whole.
  const allowedRoot = resolve(root, "dist", "editions");
  if (!editionRoot.startsWith(`${allowedRoot}${sep}`) || dirname(editionRoot) !== allowedRoot) {
    throw new Error("Edition output escaped the generated build directory.");
  }
  await rm(editionRoot, { recursive: true, force: true });
  await mkdir(editionRoot, { recursive: true });
  const env = { COCKPIT_LANGUAGE: edition, COCKPIT_EDITION_BUILD: "1" };
  console.log(`Building ${edition} edition ${manifest.version}`);
  run("node_modules/typescript/bin/tsc", [
    "-p", "tsconfig.electron.json", "--outDir", editionRoot,
    "--tsBuildInfoFile", resolve(editionRoot, "electron.tsbuildinfo"),
  ], env);
  run("node_modules/vite/bin/vite.js", ["build", "--configLoader", "native"], env);

  if (!args.includes("--package")) continue;
  const output = resolve(root, "release", manifest.version, edition);
  await mkdir(output, { recursive: true });
  const config = {
    ...manifest.build,
    directories: { ...manifest.build.directories, output: relative(root, output) },
    extraMetadata: { cockpitLanguage: edition },
    files: [
      { from: relative(root, editionRoot), to: "dist", filter: ["**/*", "!**/*.map", "!**/*.tsbuildinfo"] },
      "node_modules/**/*", "package.json",
    ],
    extraResources: [
      ...manifest.build.extraResources,
      { from: edition === "en" ? "README.en.md" : "README.md", to: "README.md" },
      { from: edition === "en" ? "CHANGELOG.en.md" : "CHANGELOG.md", to: "CHANGELOG.md" },
    ],
    win: {
      ...manifest.build.win,
      artifactName: `CLI-Cockpit-\${version}${edition === "en" ? "-en" : ""}-win-\${arch}.\${ext}`,
    },
    nsis: {
      ...manifest.build.nsis,
      installerLanguages: [edition === "en" ? "en_US" : "ja_JP"],
      language: edition === "en" ? "1033" : "1041",
      displayLanguageSelector: false,
      buildUniversalInstaller: false,
    },
  };
  const configPath = resolve(output, "builder.config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  run("node_modules/electron-builder/out/cli/cli.js", ["--config", configPath, "--win", "nsis", ...archArgs], env);
}
