import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import { collectPanes } from "../../src/shared/layout";

import type { ElectronApplication, JSHandle, Page } from "@playwright/test";
import type { PersistedWorkspace, PtyWriteRequest } from "../../src/shared/types";

test.skip(process.platform !== "darwin", "Runs against a native Mac PTY and native clipboard.");

let app: ElectronApplication;
let page: Page;
let root: string;
let userData: string;
let project: string;
let observedWrites: JSHandle<PtyWriteRequest[]>;
let launch: () => Promise<ElectronApplication>;
let errors: string[];

async function readJsonLines<T>(file: string): Promise<T[]> {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T); }
  catch { return []; }
}

test.beforeEach(async ({}, testInfo) => {
  root = testInfo.outputPath("fixture");
  userData = join(root, "user-data");
  const userHome = join(root, "home");
  const bin = join(root, "bin");
  project = join(root, "space & apostrophe's 日本語");
  errors = [];
  for (const directory of [userData, userHome, bin, project]) await mkdir(directory, { recursive: true });
  project = await realpath(project);
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  await writeFile(join(userData, "session.json"), JSON.stringify(workspace), "utf8");
  const recorder = join(root, "record.cjs");
  await writeFile(recorder, 'require("node:fs").appendFileSync(process.env.COCKPIT_TEST_CALLS, JSON.stringify({command:process.argv[2],args:process.argv.slice(3),cwd:process.cwd()})+"\\n");', "utf8");
  for (const command of ["claude", "codex"]) {
    await writeFile(join(bin, command), `#!/bin/sh\n"$COCKPIT_TEST_NODE" "$COCKPIT_TEST_RECORDER" ${command} "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }
  const entry = join(root, "hidden-entry.cjs");
  await writeFile(entry, `
    const { app } = require('electron');
    app.on('browser-window-created', (_event, win) => { win.show = () => {}; });
    require(${JSON.stringify(resolve("dist/electron/main.js"))});
  `, "utf8");
  launch = () => electron.launch({
    args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? [] : [entry],
    ...(process.env.COCKPIT_PACKAGED_EXECUTABLE ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE } : {}),
    env: { ...process.env, HOME: userHome, COCKPIT_USER_DATA: userData,
      PATH: `${bin}:${process.env.PATH ?? ""}`, COCKPIT_TEST_NODE: process.execPath,
      COCKPIT_TEST_RECORDER: recorder, COCKPIT_TEST_CALLS: join(root, "cli-calls.jsonl") },
  });
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByTestId("launcher")).toBeVisible();
  observedWrites = await app.evaluateHandle(({ ipcMain }) => {
    const requests: PtyWriteRequest[] = [];
    ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => {
      requests.push(request);
    });
    return requests;
  });
});

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath("mac-trial.png") }).catch(() => undefined);
  await app?.close().catch(() => undefined);
  expect(errors).toEqual([]);
});

async function start(command: string): Promise<void> {
  await page.getByRole("combobox", { name: "プロジェクト" }).fill(project);
  await page.getByTestId(`cli-option-${command}`).check();
  await page.getByRole("button", { name: /Start Session/u }).click();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await expect.poll(async () => {
    try { return (await readFile(join(userData, "diagnostic.log"), "utf8")).includes('"bootstrapWritten":true'); }
    catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
}

test("Mac launcher finds a CLI on PATH and preserves its working directory", async () => {
  await start("claude");
  await expect.poll(() => readJsonLines(join(root, "cli-calls.jsonl"))).toEqual([
    { command: "claude", args: [], cwd: project },
  ]);
});

test("a completed shell task stays idle through split cursor and title redraws", async ({}, testInfo) => {
  const script = join(root, "idle-redraw.cjs"), framesFile = join(root, "redraw-frames.txt");
  await writeFile(script, `
    const fs=require('node:fs');console.log('Task completed.');
    const chunks=['\\u001b','[?25l\\u001b[?25h','\\u001b]0;','CLI ready','\\u0007','\\r'];let frame=0;
    setInterval(()=>{process.stdout.write(chunks[frame%chunks.length]);fs.writeFileSync(${JSON.stringify(framesFile)},String(++frame))},100);
  `, "utf8");
  await page.getByLabel("セッション名").fill("Completed redraw");
  await start("shell");
  const id = (await page.getByTestId(/^terminal-/u).getAttribute("data-testid"))?.slice("terminal-".length);
  if (!id) throw new Error("No test shell");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await page.evaluate(({ sessionId, data }) => window.cockpit!.writeSession({ sessionId, data }), {
    sessionId: id, data: `${quote(process.execPath)} ${quote(script)}\r`,
  });
  const frames = async () => { try { return Number(await readFile(framesFile, "utf8")); } catch { return 0; } };
  await expect.poll(frames).toBeGreaterThanOrEqual(30);
  const signal = page.getByRole("button", { name: /Completed redraw/u }).locator(".status-dot");
  await expect(signal).toHaveAttribute("data-status", "idle");
  await page.screenshot({ path: testInfo.outputPath("completed-desktop.png") });
  await app.evaluate(({ BrowserWindow }) => {
    const testWindow = BrowserWindow.getAllWindows()[0];
    testWindow.setMinimumSize(320, 320);
    testWindow.setContentSize(390, 844);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(390);
  await expect.poll(frames).toBeGreaterThanOrEqual(40);
  const paneSignal = page.locator("[data-active-tab-panel] .status-dot").first();
  await expect(paneSignal).toBeVisible();
  await expect(paneSignal).toHaveAttribute("data-status", "idle");
  await page.screenshot({ path: testInfo.outputPath("completed-mobile.png") });
});

async function screenshotPaste(useNativeMenu: boolean): Promise<void> {
  await start("shell");
  await app.evaluate(({ clipboard, nativeImage }) => {
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }));
  });
  await page.locator(".xterm-screen").click();
  if (useNativeMenu) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  else await page.keyboard.press("Meta+v");
  await expect.poll(async () => (await observedWrites.jsonValue())
    .filter((event) => event.data.includes("cockpit-paste-"))).toHaveLength(1);
  const events = await observedWrites.jsonValue();
  const event = events.find((entry) => entry.data.includes("cockpit-paste-"))!;
  const filePath = /'([^']+cockpit-paste-\d+\.png)'/u.exec(event.data)?.[1];
  expect(filePath).toBeTruthy();
  expect((await readFile(filePath!)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(events.some((entry) => entry.data.includes("\x16"))).toBe(false);
}

test("Command+V pastes a screenshot through the real native clipboard once", async () => screenshotPaste(false));
test("native Edit-menu Paste uses the same screenshot path once", async () => screenshotPaste(true));

test("Command split shortcut persists and restores the pane layout", async () => {
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect.poll(async () => {
    const saved = JSON.parse(await readFile(join(userData, "session.json"), "utf8")) as PersistedWorkspace;
    return collectPanes(saved.tabs[0].root).length;
  }).toBe(2);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
});

test("Mac Codex launcher attaches only after starting the opted-in daemon", async () => {
  const directory = join(root, "home", ".codex", "app-server-daemon");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), JSON.stringify({ remoteControlEnabled: true }), "utf8");
  await start("codex");
  await expect.poll(() => readJsonLines(join(root, "cli-calls.jsonl"))).toEqual([
    { command: "codex", args: ["app-server", "daemon", "start"], cwd: project },
    { command: "codex", args: ["--remote", "unix://", "--cd", project, "-c", "tui.whimsy=false"], cwd: project },
  ]);
});

test("Mac remembers the selected CLI across app restart and a new pane", async () => {
  await page.getByTestId("cli-option-codex").check();
  await expect.poll(async () => (JSON.parse(await readFile(join(userData, "session.json"), "utf8")) as PersistedWorkspace)
    .settings.defaultCommand).toBe("codex");
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByTestId("cli-option-codex")).toBeChecked();
  await page.keyboard.press("Meta+Shift+d");
  await expect(page.getByTestId("cli-option-codex")).toHaveCount(2);
  await expect(page.getByTestId("cli-option-codex").last()).toBeChecked();
});

test("Mac cancel shortcut and button send Ctrl+C without changing copy mode", async () => {
  await start("shell");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByTestId("ctrl-c-toggle").check();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+Shift+x");
  await expect.poll(async () => (await observedWrites.jsonValue()).filter((event) => event.data === "\x03")).toHaveLength(1);
  await page.getByTestId("cancel-input").click();
  await expect(input).toBeFocused();
  await expect.poll(async () => (await observedWrites.jsonValue()).filter((event) => event.data === "\x03")).toHaveLength(2);
  await expect.poll(async () => (JSON.parse(await readFile(join(userData, "session.json"), "utf8")) as PersistedWorkspace)
    .settings.ctrlCCopies).toBe(true);
});
