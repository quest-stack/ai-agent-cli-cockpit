import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PersistedWorkspace } from "../../src/shared/types";
import type { ProviderConversation } from "../../src/shared/provider-conversation";

test.skip(process.env.COCKPIT_ACTUAL_PROVIDERS !== "1" || process.platform !== "win32", "Explicit actual-provider acceptance; uses isolated owned conversations.");

const metadataOnly = process.env.COCKPIT_PROVIDER_METADATA_ONLY === "1";
test(metadataOnly ? "actual providers publish four distinct conversation identities" : "actual Claude and Codex restore four distinct conversations in one folder", async ({}, testInfo) => {
  test.setTimeout(420_000);
  const cwd = await mkdtemp(join(tmpdir(), "cockpit-owned-conversation-"));
  const rules = "This folder is an owned acceptance fixture. Do not inspect files, call tools, execute commands, or modify anything. Reply only as requested in the message.\n";
  await writeFile(join(cwd, "AGENTS.md"), rules, "utf8");
  await writeFile(join(cwd, "CLAUDE.md"), rules, "utf8");
  // Match the normal Windows user-data path length. The deep evidence path is
  // retained for screenshots/traces, separately from the actual CLI profile.
  const directory = join(cwd, "cockpit-profile");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(testInfo.outputPath("fixture-paths.json"), JSON.stringify({ cwd, directory }), "utf8");
  const cases = ["claude-a", "claude-b", "codex-a", "codex-b"].map(name => ({
    name, command: name.startsWith("claude") ? "claude" : "codex",
    marker: `COCKPIT_QA_${name.replace("-", "_").toUpperCase()}_${randomUUID().replaceAll("-", "")}`,
    sessionId: `qa-${name}`, tabId: `qa-tab-${name}`, paneId: `qa-pane-${name}`,
  }));
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  const workspacePath = join(directory, "session.json");
  await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
  const trace = testInfo.outputPath("identity-observations.jsonl");
  await writeFile(trace, "", "utf8");
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE;
  const appRoot = executablePath ? join(dirname(executablePath), "resources", "app.asar") : process.cwd();
  const entry = testInfo.outputPath("hidden-entry.cjs");
  await writeFile(entry, `
    const {app,net}=require('electron');
    app.on('browser-window-created',(_,w)=>{w.show=()=>{};w.showInactive=()=>{};w.setSkipTaskbar(true)});
    net.fetch=async()=>new Response('{}');
    ${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}
  `, "utf8");
  const start = async (): Promise<ElectronApplication> => {
    const application = await electron.launch({
      args: ["--disable-gpu", "--disable-software-rasterizer", ...(executablePath ? ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion", "-r", entry] : [entry])], ...(executablePath ? { executablePath } : {}),
      env: { ...process.env, COCKPIT_USER_DATA: directory },
    });
    // A packaged Electron application does not reliably honor Node's -r.
    // Attach the passive recorder through the actual main-process context.
    await application.evaluate(({ app, BrowserWindow }, input) => {
      const hide = (window: Electron.BrowserWindow): void => {
        window.webContents.setBackgroundThrottling(false);
        if (app.isPackaged) {
          window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
          Object.getPrototypeOf(window).showInactive.call(window);
        } else window.hide();
        window.show = () => {}; window.showInactive = () => {};
        window.setSkipTaskbar(true);
      };
      app.on("browser-window-created", (_event, window) => hide(window));
      for (const window of BrowserWindow.getAllWindows()) hide(window);
      const fs = process.getBuiltinModule("fs");
      const { createRequire } = process.getBuiltinModule("module");
      const root = app.isPackaged ? app.getAppPath() : input.appRoot;
      const requireApp = createRequire(`${root}/package.json`);
      const module = requireApp("./dist/electron/pty-manager.js") as { PtyManager: { prototype: {
        recordConversation: (sessionId: string, conversation: ProviderConversation) => void;
        spawn: (request: { cwd: string; command: string }) => unknown;
      } } };
      const proto = module.PtyManager.prototype;
      const originalSpawn = proto.spawn;
      proto.spawn = function(request): unknown {
        if (request.cwd.replaceAll("\\", "/").toLowerCase() !== input.cwd.replaceAll("\\", "/").toLowerCase()) throw new Error("Actual-provider fixture escaped its owned project");
        return originalSpawn.call(this, request);
      };
      const original = proto.recordConversation;
      if (typeof original !== "function") throw new Error("Candidate has no conversation observation");
      proto.recordConversation = function(sessionId, conversation): void {
        fs.appendFileSync(input.trace, `${JSON.stringify({ sessionId, conversation, time: Date.now() })}\n`);
        original.call(this, sessionId, conversation);
      };
    }, { appRoot, trace, cwd });
    return application;
  };
  const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(workspacePath, "utf8")) as PersistedWorkspace;
  const lines = async (page: Page, sessionId: string): Promise<string[]> => page.getByTestId(`terminal-${sessionId}`)
    .locator(".xterm-rows > div").allTextContents().then(lines => lines.map(line => line.replaceAll("\u00a0", " ")));
  const activate = async (page: Page, item: typeof cases[number]): Promise<void> => {
    await page.getByTestId(`tab-${item.tabId}`).click();
    await expect(page.getByTestId(`terminal-${item.sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-rows")).toBeAttached();
    let trusted = false;
    let trustSelectionAdvanced = false;
    let declinedMcp = false;
    let declinedExternalImports = false;
    await expect.poll(async () => {
      const text = (await lines(page, item.sessionId)).join("\n");
      if (text.includes("Allow external CLAUDE.md file imports?")) {
        if (!declinedExternalImports && /[❯›>]\s*No, disable external imports/u.test(text)) {
          declinedExternalImports = true;
          await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Enter");
        }
        return false;
      }
      if (/new MCP servers found in this project|Select any you wish to enable/iu.test(text)) {
        if (!declinedMcp) {
          declinedMcp = true;
          await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Escape");
        }
        return false;
      }
      const claudeTrust = text.includes("Yes, I trust this folder") && text.includes("No, exit");
      const codexTrust = /(?:trust|Trust).*(?:folder|directory)|(?:folder|directory).*(?:trust|Trust)/u.test(text) && /1\.\s*(?:Yes|Trust and continue)/u.test(text);
      const trustPrompt = claudeTrust || codexTrust;
      if (trustPrompt && !text.includes(cwd.split(/[\\/]/u).at(-1)!)) throw new Error("Trust prompt does not identify the owned fixture folder");
      await writeFile(testInfo.outputPath(`startup-observation-${item.name}.json`), JSON.stringify({ text, claudeTrust, codexTrust, trusted, trustSelectionAdvanced }), "utf8");
      if (!trusted && claudeTrust && /[❯›>]\s*No, exit/u.test(text)) {
        trustSelectionAdvanced = true;
        await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("ArrowDown");
      }
      if (!trusted && trustPrompt && /[❯›>]\s*(?:1\.\s*(?:Yes|Trust)|Yes, I trust this folder)/u.test(text)) {
        trusted = true;
        await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Enter");
      }
      const idleFooter = item.command !== "codex" || /context.{0,18}(?:left|remaining)|(?:left|remaining).{0,18}context|·\s*Ready\s*·/iu.test(text);
      return idleFooter && /[❯›]/u.test(text) && !trustPrompt && !/(?:1\.\s*Yes|Sign in to)/u.test(text);
    }, { timeout: 90_000, intervals: [300, 600, 1000] }).toBe(true);
  };
  const sendPrompt = async (page: Page, item: typeof cases[number], prompt: string, fragment: string): Promise<void> => {
    await page.evaluate(({ sessionId, data }) => window.cockpit!.writeSession({ sessionId, data }), {
      sessionId: item.sessionId, data: `\x1b[200~${prompt}\x1b[201~`,
    });
    await expect.poll(async () => (await lines(page, item.sessionId)).join("\n").includes(fragment)).toBe(true);
    // Real paste completion and Enter are separate actions. Sending text plus
    // CR in one burst is treated as a multiline paste by the actual TUI.
    await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Enter");
  };
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    app = await start(); page = await app.firstWindow();
    await page.evaluate(() => { window.localStorage.setItem("cockpit.disableWebgl", "1"); });
    for (const item of cases) {
      if (item !== cases[0]) await page.getByRole("button", { name: "新規タブ", exact: true }).click();
      const launcher = page.getByTestId("launcher").filter({ visible: true });
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cwd);
      await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Tab");
      await launcher.getByTestId(`cli-option-${item.command}`).check(); await launcher.getByTestId("launch-mode-new").check();
      await launcher.getByLabel("セッション名", { exact: true }).fill(item.name);
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      await expect.poll(async () => (await saved()).sessions.find(session => session.title === item.name)?.id).toBeTruthy();
      const current = await saved(); item.sessionId = current.sessions.find(session => session.title === item.name)!.id;
      const tab = current.tabs.find(tab => tab.root.type === "pane" && tab.root.sessionId === item.sessionId)!;
      item.tabId = tab.id; item.paneId = tab.activePaneId;
      await activate(page, item);
      await page.getByTestId(`terminal-${item.sessionId}`).screenshot({ path: testInfo.outputPath(`startup-${item.name}.png`) });
      await writeFile(testInfo.outputPath("progress.json"), JSON.stringify({ phase: "started", session: item.name, metadataOnly }), "utf8");
      if (metadataOnly) continue;
      const prompt = `Remember the marker ${item.marker}. Reply only READY. Do not use tools or inspect files.`;
      await sendPrompt(page, item, prompt, item.marker);
      await writeFile(testInfo.outputPath("progress.json"), JSON.stringify({ phase: "submitted", session: item.name }), "utf8");
      await expect.poll(async () => (await lines(page!, item.sessionId)).some(line => /^(?:[●•]\s*)?READY[.!]?$/u.test(line.trim())), { timeout: 90_000 }).toBe(true);
      await writeFile(testInfo.outputPath("progress.json"), JSON.stringify({ phase: "first-reply", session: item.name }), "utf8");
    }
    await expect.poll(async () => (await saved()).sessions.filter(session => session.conversation).length, { timeout: 30_000 }).toBe(4);
    const before = await saved();
    const ids = before.sessions.map(session => session.conversation?.id);
    expect(new Set(ids).size).toBe(4);
    if (metadataOnly) {
      await writeFile(testInfo.outputPath("metadata-only.json"), JSON.stringify({ actualCliStartup: true, observedIdentities: 4, inferenceTurns: 0, conversationRestorationVerified: false }, null, 2), "utf8");
      return;
    }
    const observedBefore = (await readFile(trace, "utf8")).trim().split("\n").length;
    await app.close(); app = undefined;
    expect((await saved()).sessions.every(session => session.shouldRestore)).toBe(true);
    app = await start(); page = await app.firstWindow();
    for (const item of cases) {
      await activate(page, item);
      await sendPrompt(page, item, "What marker did I ask you to remember? Reply only the marker. Do not use tools.", "What marker did I ask you to remember?");
      await expect.poll(async () => (await lines(page!, item.sessionId)).some(line => line.trim().replace(/^[●•]\s*/u, "") === item.marker), { timeout: 90_000 }).toBe(true);
      await page.getByTestId(`terminal-${item.sessionId}`).screenshot({ path: testInfo.outputPath(`restored-${item.name}.png`) });
      await writeFile(testInfo.outputPath("progress.json"), JSON.stringify({ phase: "restored-reply", session: item.name }), "utf8");
    }
    const after = await saved();
    expect(after.sessions.map(session => session.conversation?.id)).toEqual(ids);
    const observations = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { sessionId: string; conversation: { id: string } });
    for (const item of cases) {
      const expected = before.sessions.find(session => session.id === item.sessionId)!.conversation!.id;
      expect(observations.slice(observedBefore).some(observation => observation.sessionId === item.sessionId && observation.conversation.id === expected)).toBe(true);
    }
    await writeFile(testInfo.outputPath("actual-acceptance.json"), JSON.stringify({
      passed: true, packaged: Boolean(executablePath), actualProviders: ["claude", "codex"],
      sameFolderDistinctConversations: 4, exactConversationIdsRetained: true,
      actualInferenceTurns: 8, previousMarkersRecalled: true, mockProviders: false,
      directory, cwd, executablePath, entry,
      artifactSha256: executablePath ? createHash("sha256").update(await readFile(appRoot)).digest("hex") : undefined,
      runtime: await app.evaluate(({ app }) => ({ appVersion: app.getVersion(), electron: process.versions.electron, arch: process.arch })),
      cases: cases.map(item => ({ ...item, conversationId: before.sessions.find(session => session.id === item.sessionId)!.conversation!.id })),
    }, null, 2), "utf8");
  } finally {
    if (app) {
      if (page) await page.screenshot({ path: testInfo.outputPath("last-state.png") }).catch(() => undefined);
      await app.close();
    }
  }
});
