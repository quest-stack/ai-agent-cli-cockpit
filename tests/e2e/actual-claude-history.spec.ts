import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PersistedWorkspace } from "../../src/shared/types";

test.skip(process.env.COCKPIT_ACTUAL_CLAUDE_HISTORY !== "1" || process.platform !== "win32",
  "Explicit owned real-Claude history acceptance; two inference turns, no tools.");

const newline = process.env.COCKPIT_CLAUDE_HISTORY_NEWLINE === "1";
test(`Claude history resumes the selected conversation with Enter (newline=${newline})`, async ({}, testInfo) => {
  test.setTimeout(240_000);
  const unique = randomUUID().slice(0, 8), marker = `HISTORY_QA_${unique}`, cwd = join(tmpdir(), `history-${unique}`), profile = join(cwd, "cockpit");
  await mkdir(profile, { recursive: true });
  for (const name of ["AGENTS.md", "CLAUDE.md"]) await writeFile(join(cwd, name), "Owned acceptance fixture. Never use tools, inspect files, execute commands or modify anything. Reply only as requested.\n", "utf8");
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE, workspacePath = join(profile, "session.json");
  const fresh = async (enterInsertsNewline: boolean): Promise<void> => {
    const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
    workspace.settings.enterInsertsNewline = enterInsertsNewline;
    await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
  };
  await fresh(false);
  const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(workspacePath, "utf8")) as PersistedWorkspace;
  let app: ElectronApplication | undefined, page: Page | undefined, sessionId = "", turns = 0;
  const terminal = () => page!.getByTestId(`terminal-${sessionId}`);
  const text = async (): Promise<string> => (await terminal().locator(".xterm-rows > div").allTextContents()).join("\n").replaceAll("\u00a0", " ");
  const press = async (key: string): Promise<void> => terminal().locator(".xterm-helper-textarea").press(key);
  const start = async (): Promise<void> => {
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(process.env.COCKPIT_QA_WINDOW_PRELOAD ? ["-r", process.env.COCKPIT_QA_WINDOW_PRELOAD] : []), ...(!executablePath ? [process.cwd()] : []), "--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: profile } });
    await app.evaluate(({ app, BrowserWindow, ipcMain }, cwd) => {
      if (process.env.COCKPIT_QA_WINDOW_PRELOAD && !(globalThis as typeof globalThis & { __cockpitOwnedWindowGuardLoaded?: boolean }).__cockpitOwnedWindowGuardLoaded) throw Error("Window guard did not load before the application");
      const hide = (w: Electron.BrowserWindow): void => { w.setOpacity(0); w.setFocusable(false); w.setSkipTaskbar(true); w.setPosition(-30000, -30000); Object.getPrototypeOf(w).showInactive.call(w); w.webContents.setBackgroundThrottling(false); w.show = () => {}; w.showInactive = () => {}; };
      for (const w of BrowserWindow.getAllWindows()) hide(w);
      app.on("browser-window-created", (_event, w) => hide(w));
      const observed = globalThis as typeof globalThis & { historyQaWrites?: { sessionId: string; data: string }[] };
      observed.historyQaWrites = [];
      ipcMain.on("cockpit:pty-write", (_event, request: { sessionId: string; data: string }) => observed.historyQaWrites!.push({ ...request }));
      const { createRequire } = process.getBuiltinModule("module"), load = createRequire(`${app.getAppPath()}/package.json`);
      const proto = (load("./dist/electron/pty-manager.js") as { PtyManager: { prototype: { spawn: (r: { cwd: string }) => unknown } } }).PtyManager.prototype;
      const original = proto.spawn;
      proto.spawn = function(request): unknown { if (request.cwd.replaceAll("\\", "/").toLowerCase() !== cwd.replaceAll("\\", "/").toLowerCase()) throw Error("Refuse provider launch outside owned fixture"); return original.call(this, request); };
    }, cwd);
    page = await app.firstWindow();
  };
  const launch = async (mode: "new" | "resume"): Promise<void> => {
    const launcher = page!.getByTestId("launcher").filter({ visible: true });
    await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cwd);
    await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Tab");
    await launcher.getByTestId("cli-option-claude").check(); await launcher.getByTestId(`launch-mode-${mode}`).check();
    await launcher.getByLabel("セッション名", { exact: true }).fill("Owned Claude history");
    await launcher.getByRole("button", { name: /Start Session/u }).click();
    await expect.poll(async () => (await saved()).sessions.length).toBe(1);
    sessionId = (await saved()).sessions[0].id;
    await expect(terminal().locator(".xterm-rows")).toBeAttached();
  };
  let declinedImports = false, trusted = false;
  const handleConfirmation = async (value: string): Promise<boolean> => {
    if (value.includes("Allow external CLAUDE.md file imports?")) {
      if (!declinedImports && /[❯›>]\s*No, disable external imports/u.test(value)) { declinedImports = true; await press("Enter"); }
      return true;
    }
    if (value.includes("Yes, I trust this folder") && value.includes("No, exit")) {
      if (!value.includes(`history-${unique}`)) throw Error("Refuse trust outside owned fixture");
      if (!trusted && /[❯›>]\s*Yes, I trust this folder/u.test(value)) { trusted = true; await press("Enter"); }
      return true;
    }
    return false;
  };
  const composer = async (): Promise<void> => {
    await expect.poll(async () => { const value = await text(); if (await handleConfirmation(value)) return false; return value.includes("Claude Code") && /(?:shift.tab to cycle|for shortcuts|for agents)/iu.test(value) && /^\s*[❯›]\s/mu.test(value); }, { timeout: 60_000 }).toBe(true);
  };
  const send = async (value: string, submit: string): Promise<void> => {
    await page!.evaluate(input => window.cockpit!.writeSession(input), { sessionId, data: `\x1b[200~${value}\x1b[201~` });
    await expect.poll(text).toContain(value); await press(submit); turns += 1;
  };
  try {
    await start(); await launch("new"); await composer();
    await send(`Remember ${marker}. Reply only READY. Do not use tools.`, "Enter");
    await expect.poll(async () => (await text()).split("\n").some(line => /^(?:[●•]\s*)?READY[.!]?$/u.test(line.trim())), { timeout: 90_000 }).toBe(true);
    await expect.poll(async () => (await saved()).sessions[0].conversation?.id).toBeTruthy();
    const expectedId = (await saved()).sessions[0].conversation!.id;
    await writeFile(testInfo.outputPath("created.json"), JSON.stringify({ cwd, profile, expectedId, marker }), "utf8");
    await app!.close(); app = undefined; await fresh(newline); declinedImports = false; trusted = false;
    await start(); await launch("resume");
    await expect.poll(async () => {
      const value = await text(); await writeFile(testInfo.outputPath("history-screen.txt"), value, "utf8");
      if (await handleConfirmation(value)) return false;
      return /resume|conversation|session/iu.test(value) && /search|filter|select/iu.test(value);
    }, { timeout: 60_000 }).toBe(true);
    await terminal().screenshot({ path: testInfo.outputPath("history-before.png") });
    // Narrow the actual CLI selector to our own first message before selecting.
    await page!.evaluate(input => window.cockpit!.writeSession(input), { sessionId, data: marker });
    await expect.poll(text).toContain(marker);
    await press("Enter");
    let plainEnterSelected = true;
    await expect.poll(async () => (await saved()).sessions[0].conversation?.id, { timeout: 12_000 }).toBe(expectedId).catch(() => { plainEnterSelected = false; });
    if (!plainEnterSelected) {
      await writeFile(testInfo.outputPath("after-enter.txt"), await text(), "utf8");
      await terminal().screenshot({ path: testInfo.outputPath("after-enter.png") });
      if (process.env.COCKPIT_CLAUDE_HISTORY_DIAGNOSE === "1" && newline) await press("Shift+Enter");
    }
    await expect.poll(async () => (await saved()).sessions[0].conversation?.id, { timeout: 20_000 }).toBe(expectedId);
    await composer();
    const question = "What marker did I ask you to remember? Reply only the marker.";
    if (newline) {
      await page!.evaluate(input => window.cockpit!.writeSession(input), { sessionId, data: `\x1b[200~${question}\x1b[201~` });
      await expect.poll(text).toContain(question);
      await press("Enter");
      await expect.poll(async () => app!.evaluate(() => (globalThis as typeof globalThis & { historyQaWrites: { data: string }[] }).historyQaWrites.at(-1)?.data)).toBe("\x1b[13;2u");
      await page!.evaluate(input => window.cockpit!.writeSession(input), { sessionId, data: "\x1b[200~Do not use tools.\x1b[201~" });
      await expect.poll(text).toContain("Do not use tools.");
      await writeFile(testInfo.outputPath("conversation-newline-before-submit.txt"), await text(), "utf8");
      await press("Shift+Enter"); turns += 1;
    } else await send(`${question} Do not use tools.`, "Enter");
    await expect.poll(async () => (await text()).split("\n").some(line => line.trim().replace(/^[●•]\u0020*/u, "") === marker), { timeout: 90_000 }).toBe(true);
    await terminal().screenshot({ path: testInfo.outputPath("restored.png") });
    await writeFile(testInfo.outputPath("history-acceptance.json"), JSON.stringify({ plainEnterSelected, newline, rememberedMarkerRecalled: true, exactConversationId: expectedId, inferenceTurns: turns, packaged: Boolean(executablePath), ...(executablePath ? { asarSha256: createHash("sha256").update(await readFile(join(dirname(executablePath), "resources/app.asar"))).digest("hex") } : { sourceDirectory: process.cwd() }) }, null, 2), "utf8");
    expect(plainEnterSelected, "Plain Enter must select a history item even when Enter inserts a newline in conversation input").toBe(true);
  } finally {
    if (app) { if (page && sessionId) { await writeFile(testInfo.outputPath("last-screen.txt"), await text().catch(() => ""), "utf8"); await page.screenshot({ path: testInfo.outputPath("last-state.png") }).catch(() => undefined); } await app.close(); }
  }
});
