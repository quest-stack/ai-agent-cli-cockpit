import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test as base } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page } from "@playwright/test";
import type { PreviewSnapshot } from "../../src/shared/preview";
import type { SpawnSessionRequest } from "../../src/shared/types";

interface SiteFixture {
  app: ElectronApplication; page: Page; directory: string; root: string;
  snapshot: () => Promise<PreviewSnapshot>;
  guest: (script: string) => Promise<unknown>;
  capture: (name: string) => Promise<void>;
}
const test = base.extend<{ site: SiteFixture }>({ site: async ({}, provide, testInfo) => {
  const directory = testInfo.outputPath("profile");
  const rootPath = join(directory, "制作 サイト"); await mkdir(join(rootPath, "images"), { recursive: true });
  const root = await realpath(rootPath);
  await writeFile(join(root, "index.html"), `<!doctype html><meta charset="utf-8"><title>Local directions</title><h1>Choose a direction</h1>${[1, 2, 3, 4].map(n => `<p><a href="/d${n}${n === 1 ? "" : "/"}" ${n === 1 ? 'target="_blank"' : ""}>Direction ${n}</a></p>`).join("")}`);
  await writeFile(join(root, "images/shared.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#27976b"/></svg>');
  await writeFile(join(root, ".env.local"), "never expose");
  for (const n of [1, 2, 3, 4]) {
    await mkdir(join(root, `d${n}`));
    await writeFile(join(root, `d${n}/index.html`), `<!doctype html><meta charset="utf-8"><title>Direction ${n}</title><style>body{margin:16px;background:#fff8ef;font:22px sans-serif}img{max-width:100%}</style><h1>Direction ${n} before</h1><img src="../images/shared.svg"><p><a href="/">All directions</a></p>`);
  }
  const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false; workspace.settings.scanRoots = [];
  await writeFile(join(directory, "session.json"), JSON.stringify(workspace));
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE, entry = join(directory, "entry.cjs");
  await writeFile(entry, `const {app}=require('electron');app.on('browser-window-created',(_,w)=>{w.show=()=>{};w.showInactive=()=>{}});${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}`);
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? ["-r", entry] : [entry]), "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: directory } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, ipcMain, dialog }, root) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
      Object.getPrototypeOf(window).showInactive.call(window); window.webContents.setBackgroundThrottling(false); window.show = () => {}; window.showInactive = () => {};
      ipcMain.removeHandler("cockpit:pty-spawn"); ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({ session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } }));
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    await expect(page.getByTestId("launcher")).toBeVisible();
    const snapshot = async (): Promise<PreviewSnapshot> => page.evaluate(async () => {
      const result = await window.cockpit!.preview!.request({ action: "list", tabId: "tab-welcome" }); if (!result.ok) throw Error("No preview snapshot"); return result.value;
    });
    const guest = async (script: string): Promise<unknown> => app.evaluate(async ({ webContents }, script) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("cockpit-preview:") && item.isFocused())
        ?? webContents.getAllWebContents().filter(item => item.getURL().startsWith("cockpit-preview:")).at(-1);
      if (!contents) throw Error("No site view");
      return contents.executeJavaScript(script);
    }, script);
    await provide({ app, page, directory, root, snapshot, guest, capture: async (name) => {
      const selectedId = await page.getByRole("tab", { selected: true }).last().getAttribute("title");
      await app.evaluate(async ({ webContents }, input) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("cockpit-preview:") && item.getURL().includes(input.id));
        if (!contents) throw Error("No selected site view");
        process.getBuiltinModule("fs").writeFileSync(input.file, (await contents.capturePage()).toPNG());
      }, { id: (await snapshot()).targets.find(t => t.source === selectedId)?.id ?? "", file: testInfo.outputPath(name) });
    } });
  } finally { await app.close().catch(() => undefined); }
} });

async function openSite(site: SiteFixture) {
  await site.page.getByTestId("preview-toggle").click();
  await site.page.getByRole("button", { name: "サイトのフォルダーを開く", exact: true }).click();
  await expect.poll(() => site.guest("document.body.innerText").catch(() => "")).toContain("Choose a direction");
}
async function selectedGuest(site: SiteFixture, script: string): Promise<unknown> {
  const source = await site.page.getByRole("tab", { selected: true }).last().getAttribute("title");
  const id = (await site.snapshot()).targets.find(target => target.source === source)?.id;
  return site.app.evaluate(async ({ webContents }, input) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(`cockpit-preview://${input.id}/`));
    if (!contents) return null;
    return contents.executeJavaScript(input.script);
  }, { id, script });
}

test("a site folder opens all four directions and shared assets inside Cockpit without a server", async ({ site }) => {
  await openSite(site);
  for (const n of [1, 2, 3, 4]) {
    if (n > 1) await site.page.getByRole("tab", { name: "制作 サイト · /", exact: true }).click();
    await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain("Choose a direction");
    await selectedGuest(site, `document.querySelector('a[href="/d${n}${n === 1 ? "" : "/"}"]').click()`);
    await expect(site.page.getByRole("tab", { name: `制作 サイト · /d${n}/`, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain(`Direction ${n} before`);
    await expect.poll(() => selectedGuest(site, "document.querySelector('img')?.naturalWidth")).toBe(200);
    expect(await selectedGuest(site, "typeof window.cockpit")).toBe("undefined");
    expect(await selectedGuest(site, "fetch('/.env.local').then(r=>r.status)")).not.toBe(200);
    await site.capture(`direction-${n}.png`);
  }
  expect((await site.snapshot()).targets).toHaveLength(5);
  await expect.poll(async () => JSON.parse(await readFile(join(site.directory, "preview.json"), "utf8"))[0].targets.every((target: { siteRoot?: string }) => target.siteRoot === site.root)).toBe(true);
  await expect(site.page.getByRole("alert")).toHaveCount(0);
});

for (const delivery of ["site", "index"]) test(`a delivered ${delivery} auto-opens from the owning CLI while a closed Preview stays closed`, async ({ site }) => {
  const launcher = site.page.getByTestId("launcher");
  await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(site.directory);
  await launcher.getByRole("button", { name: /Start Session/u }).click();
  const terminal = site.page.getByTestId(/^terminal-/u); await expect(terminal).toBeVisible();
  const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
  await expect.poll(async () => (await site.page.evaluate(() => window.cockpit!.getBootstrap())).workspace.sessions.some(session => session.id === sessionId)).toBe(true);
  const data = delivery === "site" ? `サイト: "${site.root}"\r\n` : `ファイル: "${join(site.root, "d1/index.html")}"\r\n`;
  await site.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data });
  await expect(site.page.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain(delivery === "site" ? "Choose a direction" : "Direction 1 before");
  if (delivery === "index") await expect.poll(() => selectedGuest(site, "document.querySelector('img')?.naturalWidth")).toBe(200);
  await site.page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await site.app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data: `\r\nサイト: "${site.root}"\r\n` });
  await expect(site.page.getByTestId("preview-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("a saved direction restores the site boundary and shared images after Cockpit restarts", async ({ site }) => {
  await openSite(site); await selectedGuest(site, "document.querySelector('a').click()");
  await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain("Direction 1 before");
  const selected = (await site.snapshot()).targets.find(target => target.name.endsWith("/d1/"))!;
  await expect.poll(async () => JSON.parse(await readFile(join(site.directory, "preview.json"), "utf8"))[0].targets.some((target: { id: string; siteRoot?: string }) => target.id === selected.id && target.siteRoot === site.root)).toBe(true);
  await site.app.close();
  const executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE, entry = join(site.directory, "entry.cjs");
  const restored = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? ["-r", entry] : [entry]), "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], env: { ...process.env, COCKPIT_USER_DATA: site.directory } });
  try {
    const page = await restored.firstWindow();
    await restored.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
      Object.getPrototypeOf(window).showInactive.call(window); window.webContents.setBackgroundThrottling(false); window.show = () => {}; window.showInactive = () => {};
    });
    await expect(page.getByRole("tab", { name: "制作 サイト · /d1/", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => restored.evaluate(async ({ webContents }, id) => {
      const guest = webContents.getAllWebContents().find(item => item.getURL().startsWith(`cockpit-preview://${id}/d1/`));
      return guest ? guest.executeJavaScript("document.querySelector('img')?.naturalWidth") : null;
    }, selected.id)).toBe(200);
  } finally { await restored.close(); }
});

test("editing a direction refreshes that page and retains its own comparison baseline", async ({ site }) => {
  await openSite(site);
  await selectedGuest(site, "document.querySelector('a').click()");
  await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain("Direction 1 before");
  await expect(site.page.getByRole("button", { name: "基準を保存", exact: true })).toBeEnabled();
  await site.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(site.page.getByRole("button", { name: "変更を比較", exact: true })).toBeEnabled();
  const source = join(site.root, "d1/index.html");
  await writeFile(source, (await readFile(source, "utf8")).replace("Direction 1 before", "Direction 1 after"));
  await expect.poll(() => selectedGuest(site, "document.body.innerText"), { timeout: 12000 }).toContain("Direction 1 after");
  expect(await selectedGuest(site, "location.pathname")).toBe("/d1/");
  const target = (await site.snapshot()).targets.find(item => item.name.endsWith("/d1/"))!;
  const comparison = await site.page.evaluate(targetId => window.cockpit!.preview!.request({ action: "capture", tabId: "tab-welcome", targetId, baseline: false }), target.id);
  expect(comparison.ok && comparison.capture?.page?.changedElements).toBe(1);
  await site.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(site.page.getByRole("dialog")).toBeVisible();
});

test("animation phases do not invent differences and live animation state survives comparison", async ({ site }) => {
  await openSite(site); await selectedGuest(site, "document.querySelector('a').click()");
  await expect.poll(() => selectedGuest(site, "document.body.innerText")).toContain("Direction 1 before");
  await selectedGuest(site, `(()=>{
    const style=document.createElement('style');style.textContent='@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.2)}}#pulse,#paused{animation:pulse 1s infinite linear;transform-origin:left}';document.head.append(style);
    for(const id of ['pulse','paused','fade','finished']){const p=document.createElement('p');p.id=id;p.textContent=id;document.body.append(p)}
    const find=id=>document.getElementById(id);
    find('pulse').getAnimations()[0].currentTime=150;
    const paused=find('paused').getAnimations()[0];paused.pause();paused.currentTime=200;
    const fade=find('fade').animate([{opacity:0},{opacity:1}],{duration:60000,fill:'both'});fade.currentTime=1000;
    window.finishEvents=0;fade.onfinish=()=>window.finishEvents++;
    find('finished').animate([{color:'red'},{color:'blue'}],{duration:1,fill:'forwards'}).finish();
  })()`);
  await expect(site.page.getByRole("button", { name: "基準を保存", exact: true })).toBeEnabled();
  await site.page.getByRole("button", { name: "基準を保存", exact: true }).click();
  await expect(site.page.getByText("基準を保存しました", { exact: true })).toBeVisible();
  await selectedGuest(site, "document.getElementById('pulse').getAnimations()[0].currentTime=650");
  const target = (await site.snapshot()).targets.find(item => item.name.endsWith("/d1/"))!;
  const compare = () => site.page.evaluate(targetId => window.cockpit!.preview!.request({ action: "capture", tabId: "tab-welcome", targetId, baseline: false }), target.id);
  const unchanged = await compare();
  expect(unchanged.ok && unchanged.capture?.page?.changedElements).toBe(0);
  expect(unchanged.ok && unchanged.comparison?.before.image).toBe(unchanged.ok && unchanged.comparison?.after.image);
  const state = await selectedGuest(site, `({pulse:document.getElementById('pulse').getAnimations()[0].playState,paused:document.getElementById('paused').getAnimations()[0].currentTime,finished:document.getElementById('finished').getAnimations()[0].playState,finishEvents:window.finishEvents,fade:Number(getComputedStyle(document.getElementById('fade')).opacity)})`) as { pulse: string; paused: number; finished: string; finishEvents: number; fade: number };
  expect(state.pulse).toBe("running"); expect(state.paused).toBe(200); expect(state.finished).toBe("finished"); expect(state.finishEvents).toBe(0); expect(state.fade).toBeLessThan(0.1);
  await selectedGuest(site, "document.getElementById('pulse').textContent='Edited content'");
  const changed = await compare(); expect(changed.ok && changed.capture?.page?.changedElements).toBe(1);
  await site.page.getByRole("button", { name: "変更を比較", exact: true }).click();
  await expect(site.page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => site.app.evaluate(async ({ webContents }) => {
    const pages = webContents.getAllWebContents().filter(item => item.getURL().endsWith(".mhtml"));
    if (pages.length !== 2) return false;
    return (await Promise.all(pages.map(item => item.executeJavaScriptInIsolatedWorld(1004, [{ code: "document.getAnimations().every(animation=>animation.playState!=='running')" }]).catch(() => false)))).every(Boolean);
  })).toBe(true);
});
