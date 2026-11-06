import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test as base } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PreviewSnapshot } from "../../src/shared/preview";
import type { PersistedWorkspace, SpawnSessionRequest } from "../../src/shared/types";

interface Fixture { app: ElectronApplication; page: Page; directory: string; workspace: PersistedWorkspace; snapshot: (tabId: string) => Promise<PreviewSnapshot> }
const test = base.extend<{ lifecycle: Fixture }>({ lifecycle: async ({}, provide, testInfo) => {
  const directory = testInfo.outputPath("profile"); await mkdir(directory, { recursive: true });
  const source = join(directory, "retained.md"); await writeFile(source, "# Retained original preview\n", "utf8");
  const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
  for (const name of ["a", "b"]) workspace.tabs.push({ id: `keep-${name}`, activePaneId: `pane-${name}`, title: `Keep ${name}`, root: { id: `pane-${name}`, sessionId: null, type: "pane" } });
  await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
  const previews = [...Array.from({ length: 30 }, (_, i) => `closed-${i}`), "keep-a", "keep-b"].map(tabId => ({ tabId, targets: [{ id: randomUUID(), source }] }));
  await writeFile(join(directory, "preview.json"), JSON.stringify(previews), "utf8");
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE, entry = testInfo.outputPath("entry.cjs");
  await writeFile(entry, `const {app}=require('electron');app.on('browser-window-created',(_,w)=>{w.show=()=>{};w.showInactive=()=>{}});${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}`, "utf8");
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? ["-r", entry] : [entry]), "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: directory } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
      Object.getPrototypeOf(window).showInactive.call(window); window.webContents.setBackgroundThrottling(false); window.show = () => {}; window.showInactive = () => {};
      ipcMain.removeHandler("cockpit:pty-spawn"); ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({ session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } }));
    });
    await expect(page.getByTestId("launcher").filter({ visible: true })).toBeVisible();
    await provide({ app, page, directory, workspace, snapshot: tabId => page.evaluate(async tabId => {
      const result = await window.cockpit!.preview!.request({ action: "list", tabId }); if (!result.ok) throw Error("No preview snapshot"); return result.value;
    }, tabId) });
  } finally { await app.close(); }
} });

test("orphaned saved tabs cannot block candidate clicks for existing Japanese Markdown and HTML files", async ({ lifecycle: fixture }, testInfo) => {
  const { page, app, directory } = fixture;
  const files = [{ name: "資料 下書き.md", body: "# Owned Markdown opened\n\nCandidate body", expected: "Owned Markdown opened" },
    { name: "確認 用.html", body: "<!doctype html><html><body><h1>Owned HTML opened</h1></body></html>", expected: "Owned HTML opened" }];
  for (const file of files) await writeFile(join(directory, file.name), file.body, "utf8");
  const launcher = page.getByTestId("launcher").filter({ visible: true });
  await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(directory);
  await launcher.getByRole("button", { name: /Start Session/u }).click();
  const terminal = page.getByTestId(/^terminal-/u).filter({ visible: true }); await expect(terminal).toBeVisible();
  const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
  await expect.poll(async () => (await page.evaluate(() => window.cockpit!.getBootstrap())).workspace.sessions.some(session => session.id === sessionId)).toBe(true);
  await page.getByTestId("preview-toggle").filter({ visible: true }).click();
  await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data: files.map(file => `Reference: "${join(directory, file.name)}"\r\n`).join("") });
  for (const [index, file] of files.entries()) {
    if (index) await page.getByRole("button", { name: "プレビュー対象を追加", exact: true }).click();
    const button = page.getByRole("button").filter({ hasText: file.name }); await expect(button).toBeVisible(); await button.click();
    await expect(page.getByRole("tab", { name: file.name, exact: true })).toHaveAttribute("aria-selected", "true");
    const target = (await fixture.snapshot("tab-welcome")).targets.find(target => target.name === file.name)!;
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().includes(id));
      return guest ? guest.executeJavaScript("document.body.innerText") : "";
    }, target.id)).toContain(file.expected);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  expect((await fixture.snapshot("keep-a")).targets).toHaveLength(1); expect((await fixture.snapshot("keep-b")).targets).toHaveLength(1);
  await expect.poll(async () => (JSON.parse(await readFile(join(directory, "preview.json"), "utf8")) as { tabId: string }[]).map(tab => tab.tabId).sort()).toEqual(["keep-a", "keep-b", "tab-welcome"]);
  await page.screenshot({ path: testInfo.outputPath("candidate-opened.png") });
});

test("closing a workspace tab releases its preview while preserving previews of remaining tabs", async ({ lifecycle: fixture }) => {
  await fixture.page.getByTestId("tab-keep-a").getByRole("button", { name: /を閉じる$/u }).click();
  await expect.poll(async () => (await fixture.snapshot("keep-a")).targets.length).toBe(0);
  expect((await fixture.snapshot("keep-b")).targets).toHaveLength(1);
  // Also cover workspace removal without relying on the renderer's close action.
  await expect.poll(async () => (await fixture.page.evaluate(() => window.cockpit!.getBootstrap())).workspace.tabs.some(tab => tab.id === "keep-a")).toBe(false);
  const workspace = (await fixture.page.evaluate(() => window.cockpit!.getBootstrap())).workspace;
  await fixture.page.evaluate(workspace => window.cockpit!.saveWorkspace({ ...workspace, tabs: workspace.tabs.filter(tab => tab.id !== "keep-b") }), workspace);
  await expect.poll(async () => (await fixture.snapshot("keep-b")).targets.length).toBe(0);
});
