import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { expect, test as base } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import { collectPanes } from "../../src/shared/layout";
import type { PersistedWorkspace, PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

interface Calls {
  spawned: string[];
  killed: string[];
  written: PtyWriteRequest[];
}

interface CockpitFixture {
  app: ElectronApplication;
  page: Page;
  calls: () => Promise<Calls>;
  start: (title: string) => Promise<string>;
  send: (sessionId: string, data: string) => Promise<void>;
  saved: () => Promise<PersistedWorkspace>;
}

const test = base.extend<{ cockpit: CockpitFixture }>({
  cockpit: async ({}, provide, testInfo) => {
    const directory = testInfo.outputPath("user-data");
    const workspace = createDefaultWorkspace();
    workspace.settings.tourCompleted = true;
    workspace.settings.notificationsEnabled = false;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const app = await electron.launch({
      args: ["."], cwd: resolve(process.cwd()),
      env: { ...process.env, COCKPIT_USER_DATA: directory },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
      const recorded = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
        const calls: Calls = { spawned: [], killed: [], written: [] };
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => {
          calls.spawned.push(request.id);
          return { session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } };
        });
        ipcMain.removeHandler("cockpit:pty-kill");
        ipcMain.handle("cockpit:pty-kill", (_event, sessionId: string) => {
          calls.killed.push(sessionId);
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-status", {
            sessionId, status: "exited", exitCode: 0,
          });
        });
        ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => calls.written.push(request));
        return calls;
      });
      const send = async (sessionId: string, data: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { sessionId, data });
      };
      await provide({
        app, page, send,
        calls: () => recorded.jsonValue(),
        saved: async () => JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as PersistedWorkspace,
        start: async (title) => {
          const launcher = page.getByTestId("launcher").filter({ visible: true });
          await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
          await launcher.getByLabel("CLI").selectOption("powershell");
          await launcher.getByLabel("セッション名").fill(title);
          await launcher.getByRole("button", { name: /Start Session/u }).click();
          const row = page.getByTestId(/^session-row-/u).filter({ hasText: title });
          await expect(row).toHaveCount(1);
          const id = (await row.getAttribute("data-testid"))!.slice("session-row-".length);
          await send(id, `Ready: ${title}\r\n> `);
          await expect(page.getByTestId(`terminal-${id}`).locator(".xterm-rows")).toContainText("Ready:");
          return id;
        },
      });
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  },
});

async function makeNestedPanes(cockpit: CockpitFixture): Promise<string[]> {
  const first = await cockpit.start("予算検討");
  await cockpit.page.keyboard.press("Control+Shift+D");
  const second = await cockpit.start("操作性の改善");
  await cockpit.page.keyboard.press("Control+Shift+E");
  const third = await cockpit.start("サイト更新");
  return [first, second, third];
}

test("案件・作業名を一覧・タブ・見出しの先頭に表示し、その場で改名できる", async ({ cockpit }, testInfo) => {
  const { page, start } = cockpit;
  const id = await start("予算検討");
  const folderName = basename(resolve(process.cwd()));
  const row = page.getByTestId(`session-row-${id}`);
  await expect(row.locator(".session-copy strong")).toHaveText("予算検討");
  await expect(row.locator(".session-copy small")).toHaveText(folderName);
  await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName(`予算検討 · ${folderName}`);
  await expect(page.locator(".active-session-summary strong")).toHaveText(`予算検討 · ${folderName}`);
  await expect(page.locator(".pane-identity strong")).toHaveText("予算検討");
  await row.locator(".session-copy strong").dblclick();
  const editor = row.getByRole("textbox");
  await editor.fill("来期の予算検討と経費の見直し");
  await editor.press("Enter");
  await expect(row.locator(".session-copy strong")).toHaveText("来期の予算検討と経費の見直し");
  await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName(`来期の予算検討と経費の見直し · ${folderName}`);
  await expect(row).toHaveAttribute("title", `来期の予算検討と経費の見直し · ${folderName}`);
  await page.screenshot({ path: testInfo.outputPath("labels.png") });
});

test("入れ子のペインを最大化しても端末・出力・保存した分割比率を保持する", async ({ cockpit }) => {
  const { page, calls, saved, send } = cockpit;
  const ids = await makeNestedPanes(cockpit);
  const split = page.locator("[data-active-tab-panel] > .split-layout");
  const bounds = (await split.boundingBox())!;
  const handle = split.locator(":scope > .split-handle");
  const divider = (await handle.boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.37, divider.y + 30);
  await page.mouse.up();
  await expect.poll(async () => {
    const root = (await saved()).tabs[0].root;
    return root.type === "split" && Math.abs(root.ratio - 0.37) < 0.02
      && collectPanes(root).filter((pane) => pane.sessionId).length === 3;
  }).toBe(true);
  const originalRoot = (await saved()).tabs[0].root;
  const instances = await page.evaluateHandle(() => [...document.querySelectorAll(".xterm")]);
  const input = page.getByTestId(`terminal-${ids[2]}`).locator("textarea");
  await input.focus();
  await page.keyboard.press("Control+Shift+Enter");
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
  await expect(page.locator(".split-handle:visible")).toHaveCount(0);
  await expect(page.getByTestId(`terminal-${ids[2]}`)).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName("サイト更新 · ほか2件");
  await expect(page.getByTestId(`terminal-${ids[0]}`)).toBeHidden();
  await send(ids[0], "\r\nBACKGROUND_OUTPUT_CONTINUES");
  await page.getByTestId(`session-row-${ids[0]}`).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName("予算検討 · ほか2件");
  await expect(page.getByTestId(`terminal-${ids[0]}`)).toBeVisible();
  await expect(page.getByTestId(`terminal-${ids[0]}`).locator(".xterm-rows")).toContainText("BACKGROUND_OUTPUT_CONTINUES");
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
  await page.getByRole("button", { name: "分割表示に戻す" }).click();
  await expect(page.getByTestId(`terminal-${ids[0]}`).locator("textarea")).toBeFocused();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(3);
  await expect(page.locator(".split-handle:visible")).toHaveCount(2);
  expect(await instances.evaluate((nodes) => nodes.every((node) => node.isConnected))).toBe(true);
  expect((await saved()).tabs[0].root).toEqual(originalRoot);
  expect((await calls()).spawned).toEqual(ids);
  expect((await calls()).killed).toEqual([]);
  expect((await calls()).written).toEqual([]);
});

test("最大化中のタブ切替・追加分割・空ペインを閉じる操作で表示を失わない", async ({ cockpit }) => {
  const { page } = cockpit;
  await makeNestedPanes(cockpit);
  await page.keyboard.press("Control+Shift+Enter");
  const originalTab = page.getByRole("tab", { selected: true });
  const tabId = (await originalTab.getAttribute("data-testid"))!;
  await page.getByRole("button", { name: "新規タブ" }).click();
  await expect(page.getByTestId("launcher").filter({ visible: true })).toHaveCount(1);
  await page.getByTestId(tabId).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
  await page.getByRole("button", { name: "右に分割" }).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(4);
  const empty = page.locator(".terminal-pane").filter({ has: page.getByTestId("launcher") }).filter({ visible: true });
  await empty.getByRole("button", { name: "ペインを最大化" }).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
  await empty.getByRole("button", { name: "ペインを閉じる" }).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(3);
});

test("最大化中の終了確認でキャンセルなら維持、終了なら残るペインを表示する", async ({ cockpit }) => {
  const { page, calls } = cockpit;
  const ids = await makeNestedPanes(cockpit);
  await page.keyboard.press("Control+Shift+Enter");
  const row = page.getByTestId(`session-row-${ids[2]}`);
  const close = row.getByRole("button", { name: "セッションを終了" });
  await row.hover();
  await close.click();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
  await close.click();
  await page.getByRole("button", { name: "終了する" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(3);
  expect((await calls()).killed).toEqual([ids[2]]);
});

test("最大化と復帰を広い画面・狭い画面で表示できる", async ({ cockpit }, testInfo) => {
  const { app, page } = cockpit;
  await makeNestedPanes(cockpit);
  await page.keyboard.press("Control+Shift+Enter");
  for (const width of [1440, 820, 390]) {
    if (width === 390) {
      await page.getByRole("button", { name: "サイドバーを折りたたむ" }).click();
    }
    await app.evaluate(({ BrowserWindow }, nextWidth) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(390, 600);
      window.setContentSize(nextWidth, 800);
    }, width);
    // WindowsのDPI丸めによる1px差を許容する。対象の幅へ変わったことは待つ。
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.innerWidth) - width)).toBeLessThanOrEqual(1);
    const button = page.getByRole("button", { name: "分割表示に戻す" });
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`zoom-${width}.png`) });
  }
});
