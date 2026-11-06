import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PersistedWorkspace } from "../../src/shared/types";

test.skip(process.env.COCKPIT_ACTUAL_PROVIDERS !== "1" || !process.env.COCKPIT_PACKAGED_EXECUTABLE || process.platform !== "win32",
  "Explicit real Codex startup acceptance in an isolated profile, using four small inference turns.");
const swappedEnter = process.env.COCKPIT_ACTUAL_ENTER_NEWLINE === "1";
const submitKey = swappedEnter ? "Shift+Enter" : "Enter";

test("new Codex tabs persist distinct conversations and restore both automatically, including an inactive tab and legacy migration", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE!;
  const cwd = testInfo.outputPath("owned-project"), directory = testInfo.outputPath("profile");
  await mkdir(cwd, { recursive: true }); await mkdir(directory, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Owned startup acceptance fixture. Do not read files, use tools or execute commands. Reply only as requested.\n", "utf8");
  const cases = ["a", "b"].map(name => ({ name, id: `startup-${name}`, tab: `tab-${name}`, pane: `pane-${name}`,
    marker: `COCKPIT_STARTUP_${name.toUpperCase()}_${randomUUID().replaceAll("-", "")}` }));
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
  workspace.settings.enterInsertsNewline = swappedEnter; workspace.settings.ctrlCCopies = swappedEnter;
  const savedPath = join(directory, "session.json");
  await writeFile(savedPath, JSON.stringify(workspace), "utf8");
  const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(savedPath, "utf8")) as PersistedWorkspace;
  const trace = testInfo.outputPath("observed-identities.jsonl"); await writeFile(trace, "", "utf8");
  const hiddenEntry = testInfo.outputPath("hidden-entry.cjs");
  await writeFile(hiddenEntry, "const {app}=require('electron');app.on('browser-window-created',(_,window)=>{window.show=()=>{};window.showInactive=()=>{}});", "utf8");
  const observations = async (): Promise<{ phase: string; sessionId: string; id: string }[]> => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { phase: string; sessionId: string; id: string });
  const start = async (phase: string): Promise<ElectronApplication> => {
    const app = await electron.launch({ executablePath, args: ["-r", hiddenEntry, "--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: directory } });
    await app.evaluate(({ app, BrowserWindow }, input) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
        Object.getPrototypeOf(window).showInactive.call(window); window.webContents.setBackgroundThrottling(false);
        window.show = () => {}; window.showInactive = () => {};
      }
      const fs = process.getBuiltinModule("fs"), { createRequire } = process.getBuiltinModule("module");
      const requireApp = createRequire(`${app.getAppPath()}/package.json`);
      const module = requireApp("./dist/electron/pty-manager.js") as { PtyManager: { prototype: {
        recordConversation: (sessionId: string, conversation: { cli: string; id: string }) => void;
      } } };
      const original = module.PtyManager.prototype.recordConversation;
      module.PtyManager.prototype.recordConversation = function(sessionId, conversation): void {
        fs.appendFileSync(input.trace, JSON.stringify({ phase: input.phase, sessionId, id: conversation.id }) + "\n");
        original.call(this, sessionId, conversation);
      };
    }, { trace, phase });
    return app;
  };
  let app: ElectronApplication | undefined, page: Page | undefined, turns = 0;
  const terminal = (item: typeof cases[number]) => page!.getByTestId(`terminal-${item.id}`);
  const text = async (item: typeof cases[number]): Promise<string> => (await terminal(item).locator(".xterm-rows > div").allTextContents()).join("\n").replaceAll("\u00a0", " ");
  const activate = async (item: typeof cases[number]): Promise<void> => {
    await page!.getByTestId(`tab-${item.tab}`).click(); await expect(terminal(item)).toBeVisible();
    let trusted = false;
    await expect.poll(async () => {
      const value = await text(item);
      const trust = /(?:trust|Trust).*(?:folder|directory)|(?:folder|directory).*(?:trust|Trust)/u.test(value) && /1\.\s*(?:Yes|Trust and continue)/u.test(value);
      if (trust && !trusted && /[❯›>]\s*1\.\s*(?:Yes|Trust)/u.test(value)) { trusted = true; await terminal(item).locator(".xterm-helper-textarea").press(submitKey); }
      return !trust && /[❯›]/u.test(value) && /context.{0,18}(?:left|remaining)|(?:left|remaining).{0,18}context|·\s*Ready\s*·/iu.test(value);
    }, { timeout: 60_000, intervals: [300, 600, 1000] }).toBe(true);
  };
  const prompt = async (item: typeof cases[number], value: string, answer: string): Promise<void> => {
    await page!.evaluate(payload => window.cockpit!.writeSession(payload), { sessionId: item.id, data: `\x1b[200~${value}\x1b[201~` });
    await expect.poll(() => text(item)).toContain(value);
    await terminal(item).locator(".xterm-helper-textarea").press(submitKey); turns += 1;
    await expect.poll(async () => (await text(item)).split("\n").some(line => line.trim().replace(/^[●•]\s*/u, "") === answer), { timeout: 90_000 }).toBe(true);
  };
  const capture = async (phase: string): Promise<void> => {
    for (const item of cases) {
      await activate(item);
      const contents = await text(item);
      expect(contents).toContain(item.marker);
      expect(contents).not.toContain(cases.find(other => other !== item)!.marker);
      expect(contents).not.toMatch(/Resume (?:a previous )?session/iu);
      await writeFile(testInfo.outputPath(`${phase}-${item.name}.txt`), contents, "utf8");
      await terminal(item).screenshot({ path: testInfo.outputPath(`${phase}-${item.name}.png`) });
    }
  };
  try {
    app = await start("new"); page = await app.firstWindow();
    for (const item of cases) {
      if (item !== cases[0]) await page.getByRole("button", { name: "新規タブ", exact: true }).click();
      const launcher = page.getByTestId("launcher").filter({ visible: true });
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cwd);
      await launcher.getByTestId("cli-option-codex").check(); await launcher.getByTestId("launch-mode-new").check();
      await launcher.getByLabel("セッション名", { exact: true }).fill(`Owned ${item.name}`);
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      await expect.poll(async () => (await saved()).sessions.find(session => session.title === `Owned ${item.name}`)?.id).toBeTruthy();
      const current = await saved(); item.id = current.sessions.find(session => session.title === `Owned ${item.name}`)!.id;
      const tab = current.tabs.find(tab => tab.root.type === "pane" && tab.root.sessionId === item.id)!;
      item.tab = tab.id; item.pane = tab.activePaneId;
      await activate(item);
      await prompt(item, `Remember ${item.marker}. Reply only READY. Do not use tools.`, "READY");
    }
    await expect.poll(async () => (await saved()).sessions.filter(session => session.conversation?.cli === "codex").length, { timeout: 20_000 }).toBe(2);
    const first = await saved(), ids = first.sessions.map(session => session.conversation!.id);
    expect(new Set(ids).size).toBe(2); expect(first.activeTabId).toBe(cases[1].tab);
    await writeFile(testInfo.outputPath("saved-before-quit.json"), JSON.stringify(first), "utf8");
    await app.close(); app = undefined;
    expect((await saved()).sessions.map(session => session.conversation?.id)).toEqual(ids);

    app = await start("automatic"); page = await app.firstWindow();
    // No tab selection or CLI keystroke before both real thread/resume results.
    // The inactive tab must also have started and selected its own conversation.
    await expect.poll(async () => {
      const records = await observations();
      return cases.every((item, index) => records.some(record => record.phase === "automatic" && record.sessionId === item.id && record.id === ids[index]));
    }, { timeout: 45_000 }).toBe(true);
    for (const item of cases) {
      await activate(item);
      await prompt(item, "What marker did I ask you to remember? Reply only that marker. Do not use tools.", item.marker);
    }
    await capture("automatic");
    expect((await saved()).sessions.map(session => session.conversation?.id)).toEqual(ids);
    await app.close(); app = undefined;

    // Emulate one old tab with no identity, retaining the other exact mapping.
    const legacy = await saved(); legacy.sessions[0].conversation = null; legacy.activeTabId = cases[0].tab;
    await writeFile(savedPath, JSON.stringify(legacy), "utf8");
    app = await start("legacy"); page = await app.firstWindow();
    const older = cases[0];
    await expect.poll(() => text(older), { timeout: 45_000 }).toMatch(/Resume (?:a previous )?session/iu);
    await expect.poll(() => text(older), { timeout: 30_000 }).toMatch(/\b[12]\s*\/\s*2\b/u);
    await terminal(older).screenshot({ path: testInfo.outputPath("legacy-picker.png") });
    // B was created after A. Pick the older A, never the folder's latest B.
    if (!/\b2\s*\/\s*2\b/u.test(await text(older))) await terminal(older).locator(".xterm-helper-textarea").press("ArrowDown");
    await expect.poll(() => text(older)).toMatch(/\b2\s*\/\s*2\b/u);
    await terminal(older).locator(".xterm-helper-textarea").press(submitKey);
    await expect.poll(async () => (await saved()).sessions[0].conversation?.id, { timeout: 30_000 }).toBe(ids[0]);
    await capture("legacy-selected");
    await app.close(); app = undefined;

    app = await start("after-legacy"); page = await app.firstWindow();
    await expect.poll(async () => {
      const records = await observations();
      return cases.every((item, index) => records.some(record => record.phase === "after-legacy" && record.sessionId === item.id && record.id === ids[index]));
    }, { timeout: 45_000 }).toBe(true);
    await capture("after-legacy");
    expect((await saved()).sessions.map(session => session.conversation?.id)).toEqual(ids);
    const asar = join(dirname(executablePath), "resources", "app.asar");
    await writeFile(testInfo.outputPath("startup-acceptance.json"), JSON.stringify({ passed: true, executablePath,
      asarSha256: createHash("sha256").update(await readFile(asar)).digest("hex"), actualInferenceTurns: turns,
      settings: { enterInsertsNewline: swappedEnter, ctrlCCopies: swappedEnter },
      newConversationsObservedAndPersisted: true, distinctConversationsInSameFolder: 2, inactiveTabResumedBeforeInteraction: true,
      rememberedMarkersRecalled: true, legacySelectedOlderConversation: true, selectedOnceThenAutomatic: true,
      installedUserProfileTouched: false, mockedProviders: false, cases: cases.map((item, index) => ({ ...item, conversationId: ids[index] })),
    }, null, 2), "utf8");
  } finally {
    if (app) {
      if (page) await page.screenshot({ path: testInfo.outputPath("last-state.png") }).catch(() => undefined);
      for (const item of cases) await writeFile(testInfo.outputPath(`last-${item.name}.txt`), await text(item).catch(() => ""), "utf8");
      await app.close();
    }
  }
});

test("an unavailable recorded Codex conversation shows an error and retains its identity", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const directory = testInfo.outputPath("profile"), cwd = testInfo.outputPath("owned-project");
  await mkdir(directory, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Owned missing-history acceptance fixture. No inference or tool use is requested.\n", "utf8");
  const workspace = createDefaultWorkspace(), id = randomUUID();
  workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
  workspace.sessions = [{ id: "missing-history", command: "codex", cwd, title: "Owned missing history", projectName: "Owned missing history", shouldRestore: true, conversation: { cli: "codex", id } }];
  workspace.tabs = [{ id: "missing-tab", activePaneId: "missing-pane", title: "Owned missing history", root: { id: "missing-pane", sessionId: "missing-history", type: "pane" } }]; workspace.activeTabId = "missing-tab";
  const file = join(directory, "session.json"); await writeFile(file, JSON.stringify(workspace), "utf8");
  const hiddenEntry = testInfo.outputPath("hidden-entry.cjs");
  await writeFile(hiddenEntry, "const {app}=require('electron');app.on('browser-window-created',(_,window)=>{window.show=()=>{};window.showInactive=()=>{}});", "utf8");
  const app = await electron.launch({ executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE!, args: ["-r", hiddenEntry, "--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: directory } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0];
      window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000); Object.getPrototypeOf(window).showInactive.call(window); window.webContents.setBackgroundThrottling(false);
    });
    const terminal = page.getByTestId("terminal-missing-history");
    await expect(terminal.locator(".xterm-rows")).toContainText("No saved session found", { timeout: 45_000 });
    const contents = await terminal.locator(".xterm-rows").innerText();
    expect(contents).not.toContain("Ask Codex to do anything");
    const saved = JSON.parse(await readFile(file, "utf8")) as PersistedWorkspace;
    expect(saved.sessions[0].conversation).toEqual({ cli: "codex", id });
    await writeFile(testInfo.outputPath("missing-history.txt"), contents, "utf8");
    await terminal.screenshot({ path: testInfo.outputPath("missing-history.png") });
    await writeFile(testInfo.outputPath("missing-history-acceptance.json"), JSON.stringify({ passed: true, noInference: true, recordedIdentityRetained: true, visibleError: true, noNewConversationPrompt: true }), "utf8");
  } finally { await app.close(); }
});
