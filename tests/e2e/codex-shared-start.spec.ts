import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

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
    'require("node:fs").appendFileSync(process.env.COCKPIT_TEST_TRACE, JSON.stringify(process.argv.slice(2)) + "\\n"); if(process.argv[2] === "--remote") process.stdout.write("COCKPIT_REMOTE_DONE\\r\\n");',
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
    console.info("[Shared Codex E2E] Launcher ready");
    const output = await page.evaluateHandle(() => {
      const state = { text: "" };
      window.cockpit!.onPtyData((event) => { state.text = (state.text + event.data).slice(-32_000); });
      return state;
    });
    await page.getByRole("combobox", { name: "プロジェクト" }).fill(project);
    await page.getByTestId(`cli-option-${"codex"}`).check();
    await page.getByRole("button", { name: /Start Session/u }).click();
    console.info("[Shared Codex E2E] Session requested");
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
    console.info("[Shared Codex E2E] Daemon and client arguments verified");
    // The call file is written before the stub process exits. Sending exit at
    // that point can deliver it to the child rather than PSReadLine. Wait for
    // the real parent shell's prompt after the remote stub's final marker.
    await expect.poll(async () => {
      const plain = stripVTControlCharacters((await output.jsonValue()).text);
      const marker = "COCKPIT_REMOTE_DONE";
      const lastMarker = plain.lastIndexOf(marker);
      return lastMarker >= 0 && plain.slice(lastMarker + marker.length).includes(`PS ${project}>`);
    }).toBe(true);
    console.info("[Shared Codex E2E] PowerShell prompt restored");
    // The stub returns to PowerShell. Let that real shell exit before quitting
    // Electron; an active ConPTY can otherwise strand native cleanup on CI.
    const row = page.getByTestId(/^session-row-/u);
    const sessionId = (await row.getAttribute("data-testid"))!.slice("session-row-".length);
    const exitCode = await page.evaluate((id) => new Promise<number | undefined>((resolveExit) => {
      const api = window.cockpit;
      if (!api) throw new Error("Electron preload API is missing.");
      const unsubscribe = api.onPtyStatus((event) => {
        if (event.sessionId !== id || !["exited", "error"].includes(event.status)) return;
        unsubscribe();
        resolveExit(event.exitCode);
      });
      api.writeSession({ sessionId: id, data: "exit 0\r" });
    }), sessionId);
    expect(exitCode).toBe(0);
    console.info("[Shared Codex E2E] PowerShell exited");
  } finally {
    console.info("[Shared Codex E2E] Closing Electron");
    await app.close();
    console.info("[Shared Codex E2E] Electron closed");
  }
});
