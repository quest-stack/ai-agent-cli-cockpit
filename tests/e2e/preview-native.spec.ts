import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test as base } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PreviewSnapshot } from "../../src/shared/preview";
import type { SpawnSessionRequest } from "../../src/shared/types";

interface NativeFixture {
  app: ElectronApplication; page: Page; directory: string; url: string;
  setHtml: (html: string) => void;
  add: (source: string) => Promise<string>;
  snapshot: () => Promise<PreviewSnapshot>;
  guest: (id: string, script: string) => Promise<unknown>;
}
const test = base.extend<{ cockpit: NativeFixture }>({ cockpit: async ({}, provide, testInfo) => {
  const directory = testInfo.outputPath("data"); await mkdir(directory, { recursive: true });
  const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
  await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
  let developmentHtml = "<h1>Local development app</h1><input id='draft' value='Keep this draft'>";
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "https://example.com/" }); res.end(); return; }
    res.setHeader("Content-Type", "text/html"); res.setHeader("Cache-Control", "no-store"); res.end(developmentHtml);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const url = `http://127.0.0.1:${address.port}/`;
  const entry = join(directory, "hidden-entry.cjs");
  await writeFile(entry, `const {app}=require('electron');app.on('web-contents-created',(_e,c)=>c.setBackgroundThrottling(false));if(process.platform!=='darwin')app.on('browser-window-created',(_e,w)=>{w.show=()=>{};w.showInactive=()=>{}});require(${JSON.stringify(resolve("dist/electron/main.js"))});`, "utf8");
  const packagedExecutable = process.env.COCKPIT_PACKAGED_EXECUTABLE;
  const app = await electron.launch({
    args: packagedExecutable ? [] : [entry],
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    env: { ...process.env, COCKPIT_USER_DATA: directory },
  });
  try {
    await app.evaluate(({ app: electronApp, webContents }) => {
      for (const contents of webContents.getAllWebContents()) contents.setBackgroundThrottling(false);
      electronApp.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await expect(page.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "false");
    const tabId = await page.locator("[data-active-tab-panel]").getAttribute("data-tab-panel-id");
    if (!tabId) throw new Error("No fixture tab");
    const snapshot = async (): Promise<PreviewSnapshot> => page.evaluate(async (tabId) => {
      const result = await window.cockpit!.preview!.request({ action: "list", tabId });
      if (!result.ok) throw new Error("No preview snapshot");
      return result.value;
    }, tabId);
    await provide({ app, page, directory, url, snapshot, setHtml: (html) => { developmentHtml = html; },
      add: async (source) => {
        const toggle = page.locator("[data-active-tab-panel]").getByTestId("preview-toggle");
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await page.getByRole("button", { name: "プレビュー対象を追加", exact: true }).click();
        await page.getByLabel("localhostのURLまたはファイルパス").fill(source);
        await page.getByRole("button", { name: "プレビューを開く", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "ファイル・URLを追加" })).toHaveCount(0);
        const item = (await snapshot()).targets.find((target) => target.source === source || target.source.replaceAll("\\", "/") === source.replaceAll("\\", "/"));
        if (!item) throw new Error("No added preview target");
        return item.id;
      },
      guest: async (id, script) => app.evaluate(async ({ webContents }, input) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getURL().includes(input.id));
        if (!guest) throw new Error("No guest view");
        return guest.executeJavaScript(input.script);
      }, { id, script }),
    });
  } finally { await app.close(); await new Promise<void>((done) => server.close(() => done())); }
} });

async function guestText(cockpit: NativeFixture, id: string): Promise<string> {
  try { return String(await cockpit.guest(id, "document.body.innerText")); } catch { return ""; }
}

test("preview chrome preserves the launcher's primary button in enabled, hovered and disabled states", async ({ cockpit }, testInfo) => {
  const launcher = cockpit.page.getByTestId("launcher");
  const project = launcher.getByRole("combobox", { name: "プロジェクト" });
  const button = launcher.getByRole("button", { name: /Start Session/u });
  await project.fill(cockpit.directory);
  await launcher.getByLabel("セッション名").fill("test");
  await expect(button).toBeEnabled();
  const colors = async (): Promise<{ background: string; foreground: string; opacity: number; accent: string; contrast: number }> => button.evaluate((node) => {
    const style = window.getComputedStyle(node);
    const probe = document.createElement("span"); probe.style.background = "var(--accent)"; node.append(probe);
    const accent = window.getComputedStyle(probe).backgroundColor; probe.remove();
    const luminance = (color: string): number => {
      const rgb = color.match(/[\d.]+/gu)!.slice(0, 3).map(Number).map((value) => {
        const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const light = luminance(style.backgroundColor); const dark = luminance(style.color);
    return { background: style.backgroundColor, foreground: style.color, opacity: Number(style.opacity), accent,
      contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
  });
  const enabled = await colors();
  expect(enabled.background).toBe(enabled.accent);
  expect(enabled.contrast).toBeGreaterThanOrEqual(4.5);
  expect(enabled.opacity).toBe(1);
  await button.hover();
  const hovered = await colors();
  expect(hovered.background).toBe(enabled.accent);
  expect(hovered.foreground).toBe(enabled.foreground);
  expect(hovered.contrast).toBeGreaterThanOrEqual(4.5);
  await button.focus(); await expect(button).toBeFocused();
  await launcher.screenshot({ path: testInfo.outputPath("launcher-enabled.png") });
  await project.fill("");
  await expect(button).toBeDisabled();
  const disabled = await colors();
  expect(disabled.background).toBe(enabled.accent);
  expect(disabled.opacity).toBeLessThan(enabled.opacity);
  await launcher.screenshot({ path: testInfo.outputPath("launcher-disabled.png") });
});

test("local HTML and relative assets render in a sandbox with no Cockpit or Node API", async ({ cockpit }, testInfo) => {
  const { directory, page } = cockpit;
  const file = join(directory, "sample page.html");
  await writeFile(join(directory, "style.css"), "body{color:rgb(12, 34, 56)}");
  await writeFile(file, "<link rel='stylesheet' href='style.css'><h1>Actual HTML</h1><button onclick='this.textContent=\"Clicked\"'>Try</button>");
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Actual HTML");
  expect(await cockpit.guest(id, "[typeof window.cockpit,typeof require,getComputedStyle(document.body).color]")).toEqual(["undefined", "undefined", "rgb(12, 34, 56)"]);
  await cockpit.guest(id, "document.querySelector('button').click()");
  expect(await guestText(cockpit, id)).toContain("Clicked");
  expect(await cockpit.app.evaluate(({ ipcMain, webContents }, id) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().includes(id))!;
    try { ipcMain.emit("cockpit:pty-write", { sender: guest, senderFrame: guest.mainFrame }, { sessionId: "fake", data: "blocked" }); return false; }
    catch { return true; }
  }, id)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("native-preview.png"), Buffer.from(png, "base64"));
});

test("visual comparison keeps the saved appearance and highlights changes without an AI request", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "visual-review.html");
  const html = (color: string, title: string): string => `<style>body{margin:0;padding:32px;background:#fff;color:#183c2c;font:16px sans-serif}h1{font-size:30px}section{height:130px;background:${color};padding:24px;color:white}</style><h1>${title}</h1><section>Review this banner and the space around it.</section><p>The remaining page stays the same.</p>`;
  await writeFile(file, html("#245536", "Original design"));
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Original design");
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await writeFile(file, html("#254da0", "Updated design"));
  await expect.poll(() => guestText(cockpit, id)).toContain("Updated design");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  const dialog = cockpit.page.getByTestId("visual-comparison");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "画像", exact: true }).click();
  const tabId = (await cockpit.snapshot()).tabId;
  const wrongTab = await cockpit.page.evaluate((targetId) => window.cockpit!.preview!.request({ action: "capture", tabId: "other-tab", targetId }), id);
  expect(wrongTab.ok).toBe(false);
  await expect.poll(() => cockpit.page.evaluate(async ({ tabId, targetId }) => (await window.cockpit!.preview!.request({ action: "capture", tabId, targetId })).ok, { tabId, targetId: id })).toBe(false);
  await expect(dialog.getByAltText("変更前のプレビュー")).toBeVisible();
  await expect(dialog.getByAltText("変更後のプレビュー")).toBeVisible();
  await expect.poll(() => dialog.getByTestId("visual-diff-region").count()).toBeGreaterThan(0);
  const images = await dialog.locator("img").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  expect(images[0] === images[1]).toBe(false);
  await dialog.screenshot({ path: testInfo.outputPath("visual-comparison-desktop.png") });
  await dialog.getByLabel("変更箇所を強調", { exact: true }).uncheck();
  await expect(dialog.getByTestId("visual-diff-region")).toHaveCount(0);
  await dialog.getByLabel("変更箇所を強調", { exact: true }).check();
  await expect.poll(() => dialog.getByTestId("visual-diff-region").count()).toBeGreaterThan(0);
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath("visual-comparison-390.png") });
  await cockpit.page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});

test("Markdown comparisons work and changed viewport sizes never produce misleading highlights", async ({ cockpit }) => {
  const file = join(cockpit.directory, "sample-agreement.md");
  await writeFile(file, "# Sample agreement\n\nDelivery: 30 days.\n\nOther terms stay the same.");
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("30 days");
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await writeFile(file, "# Sample agreement\n\nDelivery: 45 days.\n\nOther terms stay the same.");
  await expect.poll(() => guestText(cockpit, id)).toContain("45 days");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("visual-comparison")).toBeVisible();
  await cockpit.page.getByTestId("visual-comparison").getByRole("button", { name: "画像", exact: true }).click();
  await expect.poll(() => cockpit.page.getByTestId("visual-diff-region").count()).toBeGreaterThan(0);
  await cockpit.page.getByRole("button", { name: "比較を閉じる", exact: true }).click();
  await cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 960));
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("visual-comparison")).toBeVisible();
  await cockpit.page.getByTestId("visual-comparison").getByRole("button", { name: "画像", exact: true }).click();
  await expect(cockpit.page.getByLabel("変更箇所を強調", { exact: true })).toBeDisabled();
  await expect(cockpit.page.getByTestId("visual-diff-region")).toHaveCount(0);
});

test("saving a baseline in a narrow window does not change the preview size or invent differences", async ({ cockpit }) => {
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  const file = join(cockpit.directory, "unchanged.html"); await writeFile(file, "<h1>Unchanged page</h1><p>Same layout and content.</p>");
  const id = await cockpit.add(file); await expect.poll(() => guestText(cockpit, id)).toContain("Unchanged page");
  const dimensions = await cockpit.guest(id, "[innerWidth,innerHeight]");
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  expect(await cockpit.guest(id, "[innerWidth,innerHeight]")).toEqual(dimensions);
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  const dialog = cockpit.page.getByTestId("visual-comparison"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "画像", exact: true }).click();
  await expect(dialog.getByLabel("変更箇所を強調", { exact: true })).toBeEnabled();
  await expect(dialog.getByTestId("visual-diff-region")).toHaveCount(0);
});

test("SVG stroke-only changes are included in page highlights", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "ring-review.html");
  const html = (color: string): string => `<style>body{margin:0;padding:24px;background:white}svg{width:240px;height:240px}circle{fill:none;stroke:${color};stroke-width:9}</style><svg viewBox='0 0 240 240'><circle cx='120' cy='120' r='100'/></svg><p>Unchanged content</p>`;
  await writeFile(file, html("#d9f279"));
  const id = await cockpit.add(file);
  await expect(cockpit.page.getByText("基準を自動保存しました", { exact: true })).toBeVisible();
  await writeFile(file, html("#bce3ff"));
  await expect.poll(() => cockpit.guest(id, "getComputedStyle(document.querySelector('circle')).stroke")).toBe("rgb(188, 227, 255)");
  const tabId = (await cockpit.snapshot()).tabId;
  const result = await cockpit.page.evaluate(({ tabId, targetId }) => window.cockpit!.preview!.request({ action: "capture", tabId, targetId, baseline: false }), { tabId, targetId: id });
  expect(result.ok && result.capture?.page?.changedElements).toBe(1);
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  let png = "";
  await expect.poll(async () => {
    try {
      png = await cockpit.app.evaluate(async ({ BrowserWindow }) => {
        const views = BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml")).sort((left, right) => left.getBounds().x - right.getBounds().x);
        return (await (views[1] as Electron.WebContentsView).webContents.capturePage()).toPNG().toString("base64");
      }); return png.length;
    } catch { return 0; }
  }).toBeGreaterThan(100);
  await writeFile(testInfo.outputPath("svg-ring-highlight.png"), Buffer.from(png, "base64"));
});

test("file updates retain the first automatic baseline without a manual save", async ({ cockpit }) => {
  const file = join(cockpit.directory, "automatic-review.html");
  await writeFile(file, "<h1>First automatic version</h1><p>Initial page</p>");
  const id = await cockpit.add(file);
  await expect(cockpit.page.getByText("基準を自動保存しました", { exact: true })).toBeVisible();
  await writeFile(file, "<h1>Second automatic version</h1><p>Edited page</p>");
  await expect.poll(() => guestText(cockpit, id)).toContain("Second automatic version");
  await writeFile(file, "<h1>Third automatic version</h1><p>Edited page again</p>");
  await expect.poll(() => guestText(cockpit, id)).toContain("Third automatic version");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  const archives = await cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml")).sort((left, right) => left.getBounds().x - right.getBounds().x).map((view) => (view as Electron.WebContentsView).webContents.getURL()));
  expect(await readFile(fileURLToPath(archives[0]), "utf8")).toContain("First automatic version");
  expect(await readFile(fileURLToPath(archives[1]), "utf8")).toContain("Third automatic version");
});

test("localhost DOM updates keep the automatic baseline and a manual save can replace it", async ({ cockpit }) => {
  cockpit.setHtml("<h1>Original development version</h1>");
  await cockpit.add(cockpit.url);
  await expect(cockpit.page.getByText("基準を自動保存しました", { exact: true })).toBeVisible();
  const update = (text: string) => cockpit.app.evaluate(async ({ webContents }, input) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === input.url)!;
    await guest.executeJavaScript(`document.querySelector('h1').textContent=${JSON.stringify(input.text)}`);
  }, { url: cockpit.url, text });
  const beforeText = async () => {
    const url = await cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml")).sort((left, right) => left.getBounds().x - right.getBounds().x).map((view) => (view as Electron.WebContentsView).webContents.getURL())[0]);
    return readFile(fileURLToPath(url), "utf8");
  };
  await update("First development update");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  expect(await beforeText()).toContain("Original development version");
  await cockpit.page.getByRole("button", { name: "比較を閉じる", exact: true }).click();
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await update("Second development update");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  expect(await beforeText()).toContain("First development update");
});

test("version history deduplicates, keeps three generations, compares selected versions and releases closed views", async ({ cockpit }, testInfo) => {
  test.setTimeout(60_000);
  const file = join(cockpit.directory, "version-history.html");
  const html = (version: number) => `<style>body{background:white;padding:20px;font:20px sans-serif}</style><h1>Version ${version}</h1><p>Review saved appearances.</p>`;
  await writeFile(file, html(1));
  const id = await cockpit.add(file);
  await expect(cockpit.page.getByText("基準を自動保存しました", { exact: true })).toBeVisible();
  const tabId = (await cockpit.snapshot()).tabId;
  const history = () => cockpit.page.evaluate(async ({ tabId, targetId }) => {
    const result = await window.cockpit!.preview!.request({ action: "history", tabId, targetId });
    return result.ok ? result.versions ?? [] : [];
  }, { tabId, targetId: id });
  const first = (await history())[0];
  const compare = async () => {
    await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
    await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  };
  const close = () => cockpit.page.getByRole("button", { name: "比較を閉じる", exact: true }).click();
  const archivePaths = () => cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml")).sort((left, right) => left.getBounds().x - right.getBounds().x).map((view) => (view as Electron.WebContentsView).webContents.getURL()));
  await writeFile(file, html(2)); await expect.poll(() => guestText(cockpit, id)).toContain("Version 2");
  await compare();
  const originalPath = fileURLToPath((await archivePaths())[0]);
  await close(); await compare();
  expect(await history()).toHaveLength(2);
  await close();
  await expect.poll(async () => (await archivePaths()).length).toBe(0);
  await writeFile(file, html(3)); await expect.poll(() => guestText(cockpit, id)).toContain("Version 3");
  await compare();
  const versions = await history(); expect(versions).toHaveLength(3);
  await cockpit.page.getByLabel("左の版", { exact: true }).selectOption(versions[1].id);
  await expect(cockpit.page.getByLabel("左の版", { exact: true })).toHaveValue(versions[1].id);
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  expect(await readFile(fileURLToPath((await archivePaths())[0]), "utf8")).toContain("Version 2");
  expect(await readFile(fileURLToPath((await archivePaths())[1]), "utf8")).toContain("Version 3");
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  expect(await cockpit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await cockpit.page.getByTestId("visual-comparison").screenshot({ path: testInfo.outputPath("history-390.png") });
  await close();
  await writeFile(file, html(4)); await expect.poll(() => guestText(cockpit, id)).toContain("Version 4");
  await compare();
  const remaining = await history(); expect(remaining).toHaveLength(3);
  expect(remaining.map((version) => version.sequence)).toEqual([2, 3, 4]);
  await expect(cockpit.page.getByLabel("左の版", { exact: true }).getByRole("option")).toHaveCount(3);
  const rejected = await cockpit.page.evaluate(({ tabId, targetId, beforeId, afterId }) => window.cockpit!.preview!.request({ action: "compare-versions", tabId, targetId, beforeId, afterId }), { tabId, targetId: id, beforeId: first.id, afterId: remaining[2].id });
  expect(rejected.ok).toBe(false);
  await expect.poll(async () => { try { await access(originalPath); return true; } catch { return false; } }).toBe(false);
  const files = await readdir(dirname(fileURLToPath((await archivePaths())[0])));
  expect(files.filter((name) => name.endsWith(".mhtml"))).toHaveLength(3);
  expect(files.filter((name) => name.startsWith("page-") && name.endsWith(".png"))).toHaveLength(3);
});

test("relative artifacts automatically open from each CLI directory and never replace the selected preview", async ({ cockpit }) => {
  await cockpit.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cockpit:pty-spawn");
    ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({ session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } }));
  });
  for (const label of ["a", "b"]) {
    const root = join(cockpit.directory, `project-${label}`);
    await mkdir(join(root, "preview"), { recursive: true }); await mkdir(join(root, "output"), { recursive: true });
    await mkdir(join(root, "src", "electron"), { recursive: true });
    await writeFile(join(root, "preview", "index.html"), `<h1>Project ${label}</h1>`);
    await writeFile(join(root, "output", "report.pdf"), "%PDF-1.4\nfixture");
    await writeFile(join(root, "src", "electron", "preview-files.ts"), "export {};");
    if (label === "b") await cockpit.page.getByRole("button", { name: "新規タブ", exact: true }).click();
    const launcher = cockpit.page.getByTestId("launcher").filter({ visible: true });
    await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(root);
    await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Escape");
    await launcher.getByRole("button", { name: /Start Session/u }).click();
    const terminal = cockpit.page.getByTestId(/^terminal-/u).filter({ visible: true }); await expect(terminal).toBeVisible();
    const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
    await expect.poll(() => cockpit.page.evaluate(async (id) => (await window.cockpit!.getBootstrap()).workspace.sessions.some((session) => session.id === id), sessionId)).toBe(true);
    const send = async (data: string): Promise<void> => cockpit.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data });
    await send("Created: preview/in"); await send("dex.html\r\noutput/report.pdf\r\nsrc/electron/preview-files.ts\r\n");
    const active = cockpit.page.locator("[data-active-tab-panel]");
    await expect(active.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(active.getByRole("tab", { name: "index.html", exact: true })).toBeVisible();
    const tabId = (await active.getAttribute("data-tab-panel-id"))!;
    const result = await cockpit.page.evaluate((tabId) => window.cockpit!.preview!.request({ action: "list", tabId }), tabId);
    expect(result.ok && result.value.targets[0].source).toBe(join(root, "preview", "index.html"));
    await send("Next file: output/report.pdf\r\nMissing: output/missing.pdf\r\n");
    await active.getByRole("button", { name: "プレビュー対象を追加", exact: true }).click();
    await expect(active.getByText("場所を特定できない成果物があります。「ファイルを選ぶ」から開いてください。", { exact: true })).toBeVisible();
    await expect(active.getByRole("tab", { name: "index.html", exact: true })).toHaveAttribute("aria-selected", "true");
    const wrongTab = await cockpit.page.evaluate((sessionId) => window.cockpit!.preview!.request({ action: "discover", tabId: "other-tab", sessionId, paths: ["preview/index.html"] }), sessionId);
    expect(wrongTab.ok && wrongTab.discovery?.files).toEqual([]);
    await active.getByRole("button", { name: "閉じる", exact: true }).click();
  }
});

test("responsive HTML uses real CSS viewport sizes, preserves input and maps clicks through the scaled view", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "responsive.html");
  await writeFile(file, '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:24px;background:#fff;color:#153d2a}h1{font:32px sans-serif}.phone{display:none}@media(max-width:600px){.phone{display:block}.desktop{display:none}}button{display:block;margin-top:24px;padding:16px}</style><h1>Responsive studio</h1><p class="desktop">Desktop navigation</p><p class="phone">Phone menu</p><input id="draft" value="Keep my input"><button onclick="this.textContent=\'Clicked at phone width\'">Try this button</button>');
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Responsive studio");
  await cockpit.guest(id, "document.querySelector('#draft').value='My unfinished edit'");
  await cockpit.page.getByRole("button", { name: "PC", exact: true }).click();
  await expect.poll(() => cockpit.guest(id, "[innerWidth,innerHeight,matchMedia('(max-width:600px)').matches]")).toEqual([1440, 900, false]);
  const capture = async (name: string): Promise<void> => {
    const png = await cockpit.app.evaluate(async ({ webContents }, id) => (await webContents.getAllWebContents().find((wc) => wc.getURL().includes(id))!.capturePage()).toPNG().toString("base64"), id);
    await writeFile(testInfo.outputPath(name), Buffer.from(png, "base64"));
  };
  await capture("desktop-1440.png");
  await cockpit.page.getByRole("button", { name: "スマホ", exact: true }).click();
  await expect.poll(() => cockpit.guest(id, "[innerWidth,innerHeight,matchMedia('(max-width:600px)').matches]")).toEqual([390, 844, true]);
  expect(await cockpit.guest(id, "document.querySelector('#draft').value")).toBe("My unfinished edit");
  expect(await cockpit.guest(id, "getComputedStyle(document.querySelector('.phone')).display")).toBe("block");
  await cockpit.app.evaluate(async ({ BrowserWindow }, id) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => 'webContents' in view && (view as Electron.WebContentsView).webContents.getURL().includes(id)) as Electron.WebContentsView;
    const point = await view.webContents.executeJavaScript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()") as {x:number;y:number};
    const bounds = view.getBounds(); const scale = Math.min(bounds.width / 390, bounds.height / 844);
    const coordinates = { x: Math.round(point.x * scale), y: Math.round(point.y * scale) };
    view.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...coordinates });
    view.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...coordinates });
  }, id);
  await expect.poll(() => guestText(cockpit, id)).toContain("Clicked at phone width");
  await capture("phone-390.png");
});

test("saved pages retain full before and after documents, scroll and highlight with matched widths", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "complete-review.html");
  const html = (name: string, color: string): string => `<style>body{margin:0;padding:24px;background:white;color:#123;font:24px sans-serif}section{height:1500px;background:${color}}</style><h1>${name} top</h1><section>Long page</section><h2>${name} bottom</h2><script>window.activeScript=true</script>`;
  await writeFile(file, html("Original", "#d9f279"));
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Original top");
  await cockpit.page.getByRole("button", { name: "PC", exact: true }).click();
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await writeFile(file, html("Updated", "#bce3ff"));
  await expect.poll(() => guestText(cockpit, id)).toContain("Updated top");
  await cockpit.page.getByRole("button", { name: "自動", exact: true }).click();
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  const dialog = cockpit.page.getByTestId("visual-comparison");
  await expect(dialog.getByRole("button", { name: "ページ全体", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  await expect(dialog.getByLabel("変更箇所を強調", { exact: true })).toBeEnabled();
  await expect(dialog.getByText("変更した要素を囲んでいます。左右のページをスクロールできます。", { exact: true })).toBeVisible();
  const archives = await cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml"))
    .map((view) => ({ id: (view as Electron.WebContentsView).webContents.id, url: (view as Electron.WebContentsView).webContents.getURL(), x: view.getBounds().x }))
    .sort((left, right) => left.x - right.x));
  expect(archives).toHaveLength(2);
  expect(await readFile(fileURLToPath(archives[0].url), "utf8")).toContain("Original bottom");
  expect(await readFile(fileURLToPath(archives[1].url), "utf8")).toContain("Updated bottom");
  const capture = async (index: number): Promise<string> => {
    let image = "";
    await expect.poll(async () => {
      try { image = await cockpit.app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)!.capturePage()).toPNG().toString("base64"), archives[index].id); return image.length; }
      catch { return 0; }
    }).toBeGreaterThan(100);
    return image;
  };
  await writeFile(testInfo.outputPath("page-before-top.png"), Buffer.from(await capture(0), "base64"));
  const first = await capture(1);
  await writeFile(testInfo.outputPath("page-after-top.png"), Buffer.from(first, "base64"));
  await cockpit.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.sendInputEvent({ type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: -1800, canScroll: true }), archives[1].id);
  await expect.poll(() => capture(1)).not.toBe(first);
  await cockpit.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.scrollToBottom(), archives[1].id);
  let last = ""; let stable = 0;
  await expect.poll(async () => { const image = await capture(1); stable = image === last ? stable + 1 : 0; last = image; return stable; }).toBeGreaterThan(0);
  await writeFile(testInfo.outputPath("page-after-bottom.png"), Buffer.from(await capture(1), "base64"));
  await dialog.getByLabel("変更箇所を強調", { exact: true }).uncheck();
  await dialog.getByLabel("変更箇所を強調", { exact: true }).check();
  const tabId = (await cockpit.snapshot()).tabId;
  const foreign = await cockpit.page.evaluate(({ tabId, targetId }) => window.cockpit!.preview!.request({ action: "review-pages", tabId, targetId, before: { x: 0, y: 0, width: 100, height: 100 }, after: { x: 0, y: 0, width: 100, height: 100 }, highlight: true }), { tabId: `${tabId}-other`, targetId: id });
  expect(foreign.ok).toBe(false);
  await cockpit.app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)!.focus();
    webContents.fromId(id)!.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  }, archives[1].id);
  await expect(dialog).toHaveCount(0);
  await expect(cockpit.page.getByRole("button", { name: "自動", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("complete-page comparisons keep both native pages inside a narrow window", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "narrow-review.html");
  await writeFile(file, "<h1>Original narrow page</h1><p>Page content.</p>");
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Original narrow page");
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await writeFile(file, "<h1>Updated narrow page</h1><p>Page content.</p>");
  await expect.poll(() => guestText(cockpit, id)).toContain("Updated narrow page");
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(cockpit.page.getByTestId("comparison-pages")).toHaveAttribute("data-ready", "true");
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  await expect.poll(() => cockpit.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; const [width, height] = window.getContentSize();
    const boxes = window.contentView.children.filter((view) => "webContents" in view && (view as Electron.WebContentsView).webContents.getURL().endsWith(".mhtml")).map((view) => view.getBounds());
    return boxes.length === 2 && boxes.every((box) => box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= width && box.y + box.height <= height);
  })).toBe(true);
  expect(await cockpit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await cockpit.page.getByTestId("visual-comparison").screenshot({ path: testInfo.outputPath("page-comparison-390.png") });
});

test("localhost refresh retains the chosen viewport and highlights the changed page", async ({ cockpit }) => {
  const html = (title: string, color: string): string => `<style>body{margin:0;padding:30px;font:20px sans-serif;background:white;color:#193c2a}section{height:180px;background:${color}}</style><h1>${title}</h1><section>Comparison area</section>`;
  cockpit.setHtml(html("Original localhost page", "#d9f279"));
  await cockpit.add(cockpit.url);
  const contents = async (script: string): Promise<unknown> => cockpit.app.evaluate(async ({ webContents }, input) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === input.url);
    return guest?.executeJavaScript(input.script);
  }, { url: cockpit.url, script });
  await cockpit.page.getByRole("button", { name: "PC", exact: true }).click();
  await expect.poll(() => contents("[innerWidth,innerHeight]")).toEqual([1440, 900]);
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  cockpit.setHtml(html("Updated localhost page", "#bce3ff"));
  await cockpit.page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect.poll(() => contents("document.body.innerText")).toContain("Updated localhost page");
  await expect.poll(() => contents("[innerWidth,innerHeight]")).toEqual([1440, 900]);
  await cockpit.page.getByRole("button", { name: "自動", exact: true }).click();
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  const dialog = cockpit.page.getByTestId("visual-comparison");
  await dialog.getByRole("button", { name: "画像", exact: true }).click();
  await expect(dialog.getByLabel("変更箇所を強調", { exact: true })).toBeEnabled();
  await expect.poll(() => dialog.getByTestId("visual-diff-region").count()).toBeGreaterThan(0);
});

test("localhost supports tablet rotation, custom dimensions and returning to automatic width", async ({ cockpit }) => {
  await cockpit.add(cockpit.url);
  const dimensions = async (): Promise<unknown> => cockpit.app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    return wc?.executeJavaScript("[innerWidth,innerHeight]");
  }, cockpit.url);
  await cockpit.page.getByRole("button", { name: "タブレット", exact: true }).click();
  await expect.poll(dimensions).toEqual([768, 1024]);
  await cockpit.page.getByRole("button", { name: "縦横を入れ替える", exact: true }).click();
  await expect.poll(dimensions).toEqual([1024, 768]);
  await cockpit.page.getByLabel("プレビュー幅（px）").fill("375");
  await cockpit.page.getByLabel("プレビュー高さ（px）").fill("812");
  await cockpit.page.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(dimensions).toEqual([375, 812]);
  await cockpit.page.getByRole("button", { name: "自動", exact: true }).click();
  const box = await cockpit.page.getByTestId("preview-surface").boundingBox();
  await expect.poll(dimensions).toEqual([Math.floor(box!.width), Math.floor(box!.height)]);
});

test("responsive sizes stay with each target, survive reload and fit in a 390px Cockpit window", async ({ cockpit }, testInfo) => {
  await cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const file = join(cockpit.directory, "responsive.html"); const other = join(cockpit.directory, "other.html");
  await writeFile(file, "<h1>Phone target</h1>"); await writeFile(other, "<h1>Desktop target</h1>");
  const id = await cockpit.add(file);
  await cockpit.page.getByRole("button", { name: "スマホ", exact: true }).click();
  await cockpit.add(other);
  await expect(cockpit.page.getByRole("button", { name: "自動", exact: true })).toHaveAttribute("aria-pressed", "true");
  await cockpit.page.getByRole("tab", { name: "responsive.html", exact: true }).click();
  await expect(cockpit.page.getByRole("button", { name: "スマホ", exact: true })).toHaveAttribute("aria-pressed", "true");
  await cockpit.page.reload();
  await expect(cockpit.page.getByRole("button", { name: "スマホ", exact: true })).toHaveAttribute("aria-pressed", "true");
  const desktopPng = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("responsive-controls-1440.png"), Buffer.from(desktopPng, "base64"));
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  const switchButton = cockpit.page.locator(".preview-view-switch").getByRole("button", { name: "プレビュー", exact: true });
  await switchButton.click();
  await expect.poll(() => cockpit.guest(id, "[innerWidth,innerHeight]")).toEqual([390, 844]);
  expect(await cockpit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const controls = cockpit.page.getByTestId("preview-viewport-controls");
  expect(await controls.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("responsive-controls-390.png"), Buffer.from(png, "base64"));
  await expect(cockpit.page.getByRole("alert")).toHaveCount(0);
});

test("Markdown escapes HTML, updates on save and recovers after an atomic file replacement", async ({ cockpit }) => {
  const file = join(cockpit.directory, "article.md");
  await writeFile(file, "# First heading\n<script>window.bad=true</script>");
  const id = await cockpit.add(file);
  await expect.poll(() => guestText(cockpit, id)).toContain("First heading");
  expect(await cockpit.guest(id, "typeof window.bad")).toBe("undefined");
  const replacement = join(cockpit.directory, "article.next.md");
  await writeFile(replacement, "# Updated heading\n**Saved content**"); await rename(replacement, file);
  await expect.poll(() => guestText(cockpit, id)).toContain("Updated heading");
  expect((await cockpit.snapshot()).targets[0].revision).toBeGreaterThan(1);
});

test("SVG loads as an image, blocks scripts and preserves the selected target on another file update", async ({ cockpit }) => {
  const markdown = join(cockpit.directory, "article.md"); const image = join(cockpit.directory, "cover.svg");
  await writeFile(markdown, "# Article");
  await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><script>window.bad=true</script><rect width="320" height="240" fill="green"/></svg>');
  await cockpit.add(markdown); const id = await cockpit.add(image);
  await expect.poll(async () => { try { return await cockpit.guest(id, "document.querySelector('img')?.naturalWidth"); } catch { return 0; } }).toBe(320);
  expect(await cockpit.guest(id, "typeof window.bad")).toBe("undefined");
  await writeFile(markdown, "# A new article");
  await expect.poll(async () => (await cockpit.snapshot()).targets.find((target) => target.kind === "markdown")?.updated).toBe(true);
  await expect(cockpit.page.getByRole("tab", { name: "cover.svg", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("localhost loads, rejects external URLs and prevents redirects outside the local origin", async ({ cockpit }) => {
  const id = await cockpit.add(cockpit.url);
  await expect.poll(() => cockpit.app.evaluate(async ({ webContents }, url) => {
    const view = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    return view ? view.executeJavaScript("document.body.innerText") : "";
  }, cockpit.url)).toContain("Local development app");
  const tabId = (await cockpit.snapshot()).tabId;
  const invalid = await cockpit.page.evaluate((tabId) => window.cockpit!.preview!.request({ action: "add", tabId, source: "https://example.com" }), tabId);
  expect(invalid.ok).toBe(false);
  const ownership = await cockpit.page.evaluate((id) => window.cockpit!.preview!.request({ action: "refresh", tabId: "other-tab", targetId: id }), id);
  expect(ownership).toEqual({ ok: false, error: "invalid" });
  await cockpit.add(`${cockpit.url}redirect`);
  await expect.poll(async () => (await cockpit.snapshot()).targets.find((target) => target.source.endsWith("redirect"))?.error).toBe("missing");
});

test("PDF updates are explicit and the original can be regenerated while the old version remains cached", async ({ cockpit }, testInfo) => {
  // The built-in PDF viewer receives a real immutable file response.
  const file = join(cockpit.directory, "overview.pdf");
  const content = "BT /F1 24 Tf 45 740 Td (Actual PDF preview) Tj /F1 12 Tf 0 -40 Td (Immutable file version, page 1 of 1.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(file, pdf);
  const id = await cockpit.add(file);
  await expect.poll(async () => (await cockpit.snapshot()).targets[0]?.revision).toBe(1);
  await expect.poll(async () => cockpit.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes(".pdf") && !wc.isLoading()))).toBe(true);
  await expect.poll(async () => cockpit.app.evaluate(async ({ webContents }) => {
    const document = webContents.getAllWebContents().find((wc) => wc.getURL().includes(".pdf"));
    const frame = document?.mainFrame.framesInSubtree.find((frame) => frame.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"));
    return frame ? frame.executeJavaScript("Boolean(document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('embed'))") : false;
  })).toBe(true);
  const guestPng = await cockpit.app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find((wc) => wc.getURL().includes(".pdf"))!.capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("pdf-guest.png"), Buffer.from(guestPng, "base64"));
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("native-pdf.png"), Buffer.from(png, "base64"));
  await cockpit.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(cockpit.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  const first = await readFile(file, "utf8"); await writeFile(file, first.replace("Actual PDF preview", "Edited PDF preview") + "\n% regenerated\n");
  await expect.poll(async () => (await cockpit.snapshot()).targets[0]?.updated).toBe(true);
  expect((await cockpit.snapshot()).targets[0].revision).toBe(1);
  await cockpit.page.getByRole("button", { name: "新しい版を表示", exact: true }).click();
  await expect.poll(async () => (await cockpit.snapshot()).targets.find((target) => target.id === id)?.revision).toBe(2);
  await expect.poll(async () => cockpit.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes(".pdf") && !wc.isLoading()))).toBe(true);
  await cockpit.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  const comparison = cockpit.page.getByTestId("visual-comparison");
  await expect(comparison).toBeVisible();
  await expect.poll(() => comparison.getByTestId("visual-diff-region").count()).toBeGreaterThan(0);
  await comparison.screenshot({ path: testInfo.outputPath("pdf-visual-comparison.png") });
});

test("detected localhost URLs automatically open for every CLI and respect an explicit close", async ({ cockpit }, testInfo) => {
  await cockpit.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cockpit:pty-spawn");
    ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({ session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } }));
  });
  for (const command of ["claude", "codex", process.platform === "darwin" ? "shell" : "powershell"]) {
    if (command !== "claude") await cockpit.page.getByRole("button", { name: "新規タブ", exact: true }).click();
    const launcher = cockpit.page.getByTestId("launcher").filter({ visible: true });
    await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cockpit.directory);
    await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Escape");
    await launcher.getByTestId(`cli-option-${command}`).focus();
    await cockpit.page.keyboard.press("Space");
    await expect(launcher.getByTestId(`cli-option-${command}`)).toBeChecked();
    await launcher.getByRole("button", { name: /Start Session/u }).click();
    const terminal = cockpit.page.getByTestId(/^terminal-/u).filter({ visible: true });
    await expect(terminal).toBeVisible();
    const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
    await cockpit.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data: `Local: ${cockpit.url}\r\n` });
    const active = cockpit.page.locator("[data-active-tab-panel]");
    await expect(active.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(active.getByRole("tab", { name: new URL(cockpit.url).host, exact: true })).toBeVisible();
    await expect.poll(() => cockpit.app.evaluate(async ({ webContents }, url) => {
      const view = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      return view ? view.executeJavaScript("document.body.innerText") : "";
    }, cockpit.url)).toContain("Local development app");
    if (command === "claude") {
      const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
      await writeFile(testInfo.outputPath("automatic-preview-desktop.png"), Buffer.from(png, "base64"));
    }
    // A narrow Mac display can switch to Preview and hide the retained terminal.
    const input = cockpit.page.getByTestId(`terminal-${sessionId}`).locator("textarea");
    const node = await input.elementHandle();
    await active.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    // Empty the target list so a remaining target cannot mask an unwanted reopen.
    const tabId = (await active.getAttribute("data-tab-panel-id"))!;
    await cockpit.page.evaluate((tabId) => window.cockpit!.preview!.request({ action: "clear", tabId }), tabId);
    if (command === "powershell" || command === "shell") {
      await cockpit.page.reload();
      await expect(cockpit.page.getByTestId(`terminal-${sessionId}`)).toBeVisible();
      await expect(active.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "false");
    }
    await cockpit.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data: `Next: ${cockpit.url}after-close\r\noutput/missing.html\r\n` });
    await expect(active.getByText("場所を特定できない成果物があります。「ファイルを選ぶ」から開いてください。", { exact: true })).toHaveCount(1);
    await expect(active.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "false");
    const result = await cockpit.page.evaluate((tabId) => window.cockpit!.preview!.request({ action: "list", tabId }), tabId);
    expect(result.ok && result.value.targets).toEqual([]);
  }
});

test("real shell output opens a native preview without preview actions on desktop and phone", async ({ cockpit }, testInfo) => {
  const output = await cockpit.page.evaluateHandle(() => {
    const output = { text: "" };
    window.cockpit!.onPtyData((event) => { output.text = (output.text + event.data).slice(-16384); });
    return output;
  });
  const launcher = cockpit.page.getByTestId("launcher");
  const command = process.platform === "darwin" ? "shell" : "powershell";
  await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cockpit.directory);
  await launcher.getByRole("combobox", { name: "プロジェクト" }).press("Escape");
  await launcher.getByTestId(`cli-option-${command}`).focus();
  await cockpit.page.keyboard.press("Space");
  await launcher.getByRole("button", { name: /Start Session/u }).click();
  const terminal = cockpit.page.getByTestId(/^terminal-/u);
  await expect(terminal).toBeVisible();
  const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
  await expect.poll(async () => (await readFile(join(cockpit.directory, "diagnostic.log"), "utf8")).includes('"bootstrapWritten":true')).toBe(true);
  await cockpit.page.evaluate(({ sessionId, command }) => window.cockpit!.writeSession({ sessionId,
    data: command === "shell" ? "printf '\\nCOCKPIT_PREVIEW_SHELL_READY\\n'\r" : "Write-Output 'COCKPIT_PREVIEW_SHELL_READY'\r",
  }), { sessionId, command });
  await expect.poll(() => output.evaluate((state) => /COCKPIT_PREVIEW_SHELL_READY\r?\n/u.test(state.text))).toBe(true);
  const input = terminal.locator("textarea");
  await input.pressSequentially(command === "shell" ? `printf 'Local: %s\\n' '${cockpit.url}'` : `Write-Output 'Local: ${cockpit.url}'`, { delay: 20 });
  await input.press("Enter");
  await expect(cockpit.page.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(cockpit.page.getByRole("tab", { name: new URL(cockpit.url).host, exact: true })).toBeVisible();
  await expect.poll(async () => (await cockpit.snapshot()).targets.map((target) => target.source)).toEqual([cockpit.url]);
  await expect.poll(() => cockpit.app.evaluate(async ({ webContents }, url) => {
    const view = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    return view ? view.executeJavaScript("document.body.innerText") : "";
  }, cockpit.url)).toContain("Local development app");
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844);
  });
  await expect(cockpit.page.getByRole("region", { name: "プレビュー", exact: true })).toBeVisible();
  expect(await cockpit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("automatic-preview-phone.png"), Buffer.from(png, "base64"));
});

test("MP4 plays in Electron, pauses when closed, keeps position and applies updates paused", async ({ cockpit }) => {
  const file = join(cockpit.directory, "movie.mp4");
  try {
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", file], { windowsHide: true });
  } catch { test.skip(true, "Local ffmpeg is required to generate the codec fixture."); }
  const id = await cockpit.add(file);
  await expect.poll(async () => { try { return await cockpit.guest(id, "document.querySelector('video')?.readyState"); } catch { return 0; } }).toBeGreaterThanOrEqual(2);
  await cockpit.guest(id, "document.querySelector('video').muted=true;document.querySelector('video').play()");
  await expect.poll(() => cockpit.guest(id, "document.querySelector('video').currentTime")).toBeGreaterThan(0);
  await cockpit.app.evaluate(async ({ BrowserWindow, webContents }, id) => {
    const view = webContents.getAllWebContents().find((wc) => wc.getURL().includes(id))!;
    // macOS completes its native fullscreen animation after the HTML promise.
    const entered = process.platform === "darwin"
      ? new Promise<void>((done) => BrowserWindow.getAllWindows()[0].once("enter-full-screen", () => done()))
      : Promise.resolve();
    await view.executeJavaScript("document.querySelector('video').requestFullscreen()", true);
    await entered;
  }, id);
  await expect.poll(() => cockpit.guest(id, "document.fullscreenElement?.tagName")).toBe("VIDEO");
  await cockpit.app.evaluate(async ({ BrowserWindow, webContents }, id) => {
    const view = webContents.getAllWebContents().find((wc) => wc.getURL().includes(id))!;
    const left = process.platform === "darwin"
      ? new Promise<void>((done) => BrowserWindow.getAllWindows()[0].once("leave-full-screen", () => done()))
      : Promise.resolve();
    await view.executeJavaScript("document.exitFullscreen()");
    await left;
  }, id);
  await expect.poll(() => cockpit.guest(id, "Boolean(document.fullscreenElement)")).toBe(false);
  await cockpit.page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await expect.poll(() => cockpit.guest(id, "document.querySelector('video').paused")).toBe(true);
  await cockpit.page.getByTestId("preview-toggle").click();
  expect(await cockpit.guest(id, "document.querySelector('video').paused")).toBe(true);
  await cockpit.guest(id, "document.querySelector('video').currentTime=2");
  const bytes = await readFile(file); await writeFile(file, bytes);
  await expect.poll(async () => (await cockpit.snapshot()).targets[0].updated).toBe(true);
  await cockpit.page.getByRole("button", { name: "新しい版を表示", exact: true }).click();
  await expect.poll(() => cockpit.guest(id, "Math.round(document.querySelector('video').currentTime)")).toBe(2);
  expect(await cockpit.guest(id, "document.querySelector('video').paused")).toBe(true);
});

test("file picker, close-state persistence and narrow AI switching work without restarting the CLI", async ({ cockpit }, testInfo) => {
  const file = join(cockpit.directory, "picked.md"); await writeFile(file, "# Picked file");
  await cockpit.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  await cockpit.page.getByTestId("preview-toggle").click();
  await cockpit.page.getByRole("button", { name: "ファイルを選ぶ", exact: true }).click();
  await expect(cockpit.page.getByRole("tab", { name: "picked.md", exact: true })).toBeVisible();
  await cockpit.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(390, 520); window.setContentSize(390, 844); });
  await expect(cockpit.page.getByRole("button", { name: "AI", exact: true })).toBeVisible();
  await cockpit.page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(cockpit.page.getByTestId("launcher")).toBeVisible();
  await cockpit.page.locator(".preview-view-switch").getByRole("button", { name: "プレビュー", exact: true }).click();
  expect(await cockpit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("native-preview-390.png"), Buffer.from(png, "base64"));
  await cockpit.page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await cockpit.page.reload();
  await expect(cockpit.page.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "false");
  await cockpit.page.getByTestId("preview-toggle").click();
  await expect(cockpit.page.getByRole("tab", { name: "picked.md", exact: true })).toBeVisible();
});
