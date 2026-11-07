import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PersistedWorkspace, RecentSession } from "../../src/shared/types";

test.skip(process.env.COCKPIT_ACTUAL_DIRECT_RESUME !== "1" || process.platform !== "win32",
  "Explicit real-Claude/Codex acceptance: owned conversations, eight short turns, no tools.");

test("Resume then Start and recent Resume reopen exact Claude and Codex conversations without a CLI picker", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const cwd = await mkdtemp(join(tmpdir(), "cockpit-direct-")), profile = join(cwd, "profile"), workspacePath = join(profile, "session.json");
  await mkdir(profile);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) await writeFile(join(cwd, name),
    "Owned acceptance fixture. Never use tools, inspect files, run commands, or change anything. Reply only as requested.\n", "utf8");
  const cases = ["claude-a", "claude-b", "codex-a", "codex-b"].map(name => ({
    name, cli: name.startsWith("claude") ? "claude" as const : "codex" as const,
    marker: `DIRECT_${name.replace("-", "_").toUpperCase()}_${randomUUID().slice(0, 8)}`, conversationId: "",
  }));
  const fresh = async (recent: RecentSession[] = []): Promise<void> => {
    const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true;
    workspace.settings.notificationsEnabled = false; workspace.settings.scanRoots = []; workspace.recent = recent;
    await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
  };
  const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(workspacePath, "utf8")) as PersistedWorkspace;
  const entry = testInfo.outputPath("hidden-entry.cjs");
  await writeFile(entry, `const {app,net}=require('electron');
    globalThis.__directResumeWindowGuard=true;
    app.on('browser-window-created',(_,w)=>{w.setOpacity(0);w.setFocusable(false);w.setSkipTaskbar(true);w.setPosition(-30000,-30000);w.show=()=>{};w.showInactive=()=>{}});
    net.fetch=async()=>new Response('{}');require(${JSON.stringify(resolve("dist/electron/main.js"))});`, "utf8");
  let app: ElectronApplication | undefined, page: Page | undefined, sessionId = "", turns = 0;
  const terminal = () => page!.getByTestId(`terminal-${sessionId}`);
  const text = async (): Promise<string> => (await terminal().locator(".xterm-rows > div").allTextContents()).join("\n").replaceAll("\u00a0", " ");
  const press = async (key: string): Promise<void> => terminal().locator(".xterm-helper-textarea").press(key);
  const start = async (): Promise<void> => {
    app = await electron.launch({ args: [entry, "--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
      env: { ...process.env, COCKPIT_USER_DATA: profile, COCKPIT_LANGUAGE: "ja" } });
    await app.evaluate(({ BrowserWindow }, input) => {
      if (!(globalThis as typeof globalThis & { __directResumeWindowGuard?: boolean }).__directResumeWindowGuard) throw Error("Owned window guard missing");
      for (const w of BrowserWindow.getAllWindows()) { w.webContents.setBackgroundThrottling(false); Object.getPrototypeOf(w).showInactive.call(w); }
      const load = process.getBuiltinModule("module").createRequire(`${input.repo}/package.json`);
      const proto = (load("./dist/electron/pty-manager.js") as { PtyManager: { prototype: { spawn: (r: { cwd: string }) => unknown } } }).PtyManager.prototype;
      const original = proto.spawn;
      proto.spawn = function(request): unknown { if (request.cwd.replaceAll("\\", "/").toLowerCase() !== input.cwd.replaceAll("\\", "/").toLowerCase()) throw Error("Refuse CLI outside owned fixture"); return original.call(this, request); };
    }, { cwd, repo: process.cwd() });
    page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
  };
  const ready = async (cli: "claude" | "codex"): Promise<void> => {
    let trusted = false, importsDeclined = false;
    await expect.poll(async () => {
      const value = await text();
      await writeFile(testInfo.outputPath("current-screen.txt"), value, "utf8");
      if (value.includes("Allow external CLAUDE.md file imports?")) {
        if (!importsDeclined && /[❯›>]\s*No, disable external imports/u.test(value)) { importsDeclined = true; await press("Enter"); }
        return false;
      }
      const trust = value.includes("Yes, I trust this folder") && value.includes("No, exit")
        || /(?:trust|Trust).*(?:folder|directory)|(?:folder|directory).*(?:trust|Trust)/u.test(value) && /1\.\s*(?:Yes|Trust and continue)/u.test(value);
      if (trust) {
        if (!value.includes(basename(cwd))) throw Error("Unrelated trust prompt");
        if (!trusted && /[❯›>]\s*(?:1\.\s*(?:Yes|Trust)|Yes, I trust this folder)/u.test(value)) { trusted = true; await press("Enter"); }
        return false;
      }
      expect(value).not.toMatch(/Resume a previous session|Type to search|Search conversations/u);
      return /[❯›]/u.test(value) && (cli === "claude" ? /(?:shift.tab to cycle|for shortcuts|for agents)/iu.test(value)
        : /context.{0,18}(?:left|remaining)|(?:left|remaining).{0,18}context|·\s*Ready\s*·/iu.test(value));
    }, { timeout: 90_000, intervals: [300, 600, 1000] }).toBe(true);
  };
  const send = async (prompt: string, expected: string): Promise<void> => {
    await page!.evaluate(input => window.cockpit!.writeSession(input), { sessionId, data: `\x1b[200~${prompt}\x1b[201~` });
    await expect.poll(text).toContain(prompt); await press("Enter"); turns += 1;
    await expect.poll(async () => (await text()).split("\n").some(line => line.trim().replace(/^[●•]\s*/u, "") === expected), { timeout: 90_000 }).toBe(true);
  };
  const attach = async (name: string): Promise<void> => {
    await expect.poll(async () => (await saved()).sessions.find(item => item.title === name)?.id).toBeTruthy();
    sessionId = (await saved()).sessions.find(item => item.title === name)!.id;
    await expect(terminal().locator(".xterm-rows")).toBeAttached();
  };
  try {
    await fresh(); await start();
    for (const item of cases) {
      if (item !== cases[0]) await page!.getByRole("button", { name: "新規タブ", exact: true }).click();
      const launcher = page!.getByTestId("launcher").filter({ visible: true });
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cwd);
      await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Tab");
      await launcher.getByTestId(`cli-option-${item.cli}`).check(); await launcher.getByTestId("launch-mode-new").check();
      await launcher.getByLabel("セッション名", { exact: true }).fill(item.name);
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      await attach(item.name); await ready(item.cli);
      await send(`Remember ${item.marker}. Reply only READY. Do not use tools.`, "READY");
      await expect.poll(async () => (await saved()).recent.find(record => record.sessionId === sessionId)?.conversation?.id).toBeTruthy();
      item.conversationId = (await saved()).sessions.find(record => record.id === sessionId)!.conversation!.id;
      await writeFile(testInfo.outputPath("progress.json"), JSON.stringify({ phase: "created", cases, turns }), "utf8");
    }
    expect(new Set(cases.map(item => item.conversationId)).size).toBe(4);
    await app!.close(); app = undefined;
    const history = (await saved()).recent;
    // Retain only durable recent history, not saved panes or live session mappings.
    // Each provider's B is newer; form Resume must still reopen selected A.
    for (const [route, name] of [["form", "claude-a"], ["form", "codex-a"], ["recent", "claude-b"], ["recent", "codex-b"]] as const) {
      const item = cases.find(item => item.name === name)!;
      await fresh(history); await start();
      const launcher = page!.getByTestId("launcher");
      if (route === "form") {
        await launcher.getByTestId(`cli-option-${item.cli}`).check(); await launcher.getByTestId("launch-mode-resume").check();
        await launcher.getByTestId("resume-conversation").selectOption(item.conversationId.toLowerCase());
        await launcher.screenshot({ path: testInfo.outputPath(`before-${route}-${name}.png`) });
        await launcher.getByRole("button", { name: /Start Session/u }).click();
      } else {
        const index = history.findIndex(record => record.conversation?.id === item.conversationId);
        await launcher.getByTestId(`recent-resume-${index}`).click();
      }
      await attach(item.name); await ready(item.cli);
      expect((await saved()).sessions[0]).toMatchObject({ command: `${item.cli} ${item.cli === "claude" ? "--resume" : "resume"} ${item.conversationId}`,
        conversation: { cli: item.cli, id: item.conversationId } });
      // No input was sent to a CLI history picker. Ask the real model to prove
      // the old context exists, rather than trusting the requested UUID alone.
      await send("What marker did I ask you to remember? Reply only the marker. Do not use tools.", item.marker);
      await terminal().screenshot({ path: testInfo.outputPath(`restored-${route}-${name}.png`) });
      await writeFile(testInfo.outputPath(`restored-${route}-${name}.txt`), await text(), "utf8");
      await app!.close(); app = undefined;
    }
    await writeFile(testInfo.outputPath("direct-resume-acceptance.json"), JSON.stringify({ passed: true, sourceDirectory: process.cwd(), packaged: false,
      cwd, profile, actualInferenceTurns: turns, providers: ["claude", "codex"], sameFolderDistinctConversations: 4,
      formResumesOlderExactConversation: true, recentResumesExactConversation: true, cliHistorySelectionActions: 0,
      originalMarkersRecalled: true, globalConfigModified: false, customerConversationsUsed: false, cases }, null, 2), "utf8");
  } finally {
    if (app) {
      if (page && sessionId) await writeFile(testInfo.outputPath("failure-screen.txt"), await text().catch(() => ""), "utf8");
      if (page) await page.screenshot({ path: testInfo.outputPath("last-state.png") }).catch(() => undefined);
      await app.close();
    }
  }
});
