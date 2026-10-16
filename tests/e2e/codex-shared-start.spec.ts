import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

test("the Codex launcher attaches to the opted-in shared server through the real PTY", async ({}, testInfo) => {
  const root = testInfo.outputPath("fixture");
  const userHome = join(root, "home");
  const userData = join(root, "user-data");
  const bin = join(root, "bin");
  const project = join(root, "space & apostrophe's project");
  const daemonSettings = join(userHome, ".codex", "app-server-daemon");
  for (const directory of [userData, bin, project, daemonSettings]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(daemonSettings, "settings.json"),
    JSON.stringify({ remoteControlEnabled: true }), "utf8");
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  workspace.settings.scanRoots = [];
  await writeFile(join(userData, "session.json"), JSON.stringify(workspace), "utf8");

  const trace = join(root, "calls.jsonl");
  const recorder = join(root, "record.cjs");
  await writeFile(recorder,
    'require("node:fs").appendFileSync(process.env.COCKPIT_TEST_TRACE, JSON.stringify(process.argv.slice(2)) + "\\n");',
    "utf8");
  await writeFile(join(bin, "codex.cmd"),
    '@echo off\r\nnode "%COCKPIT_TEST_RECORDER%" %*\r\nexit /b 0\r\n', "utf8");
  const entry = join(root, "hidden-entry.cjs");
  await writeFile(entry, `
    const { app, net } = require('electron');
    app.on('browser-window-created', (_event, win) => {
      win.show = () => {};
      win.showInactive = () => {};
    });
    net.fetch = async () => new Response('{}', { status: 200 });
    require(${JSON.stringify(resolve("dist/electron/main.js"))});
  `, "utf8");

  const app = await electron.launch({
    args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? [] : [entry],
    ...(process.env.COCKPIT_PACKAGED_EXECUTABLE
      ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE }
      : {}),
    cwd: process.cwd(),
    env: {
      ...process.env,
      USERPROFILE: userHome,
      COCKPIT_USER_DATA: userData,
      PATH: `${bin};${process.env.PATH ?? ""}`,
      COCKPIT_TEST_TRACE: trace,
      COCKPIT_TEST_RECORDER: recorder,
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await page.getByRole("combobox", { name: "プロジェクト" }).fill(project);
    await page.getByLabel("CLI").selectOption("codex");
    await page.getByRole("button", { name: /Start Session/u }).click();
    await expect.poll(async () => {
      try {
        return (await readFile(trace, "utf8")).trim().split(/\r?\n/u)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    }, { timeout: 20_000 }).toEqual([
      ["app-server", "daemon", "start"],
      ["--remote", "unix://", "--cd", project, "-c", "tui.whimsy=false"],
    ]);
  } finally {
    await app.close();
  }
});
