import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test as base } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import type { SessionStatus, SpawnSessionRequest } from "../../src/shared/types";

const sessionTitle = "終了確認テスト";
const test = base.extend<{
  cockpit: {
    app: ElectronApplication;
    page: Page;
    kills: () => Promise<string[]>;
    setStatus: (status: SessionStatus) => Promise<void>;
    sessionId: string;
  };
}>({
  cockpit: async ({}, provide, testInfo) => {
    const userDataPath = testInfo.outputPath("user-data");
    const workspace = createDefaultWorkspace();
    // 旧版で確認を無効にしていた利用者も、更新後は保護されること。
    workspace.settings.alwaysConfirmClose = false;
    workspace.settings.notificationsEnabled = false;
    workspace.settings.tourCompleted = true;
    await mkdir(userDataPath, { recursive: true });
    await writeFile(join(userDataPath, "session.json"), JSON.stringify(workspace), "utf8");
    const app = await electron.launch({
      args: ["."],
      cwd: resolve(process.cwd()),
      env: { ...process.env, COCKPIT_USER_DATA: userDataPath },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      // 終了要求を観測し、実際のCLIや利用中のセッションには触れない。
      const killed = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
          session: { ...request, shouldRestore: true, startedAt: Date.now(), status: "idle" },
        }));
        const received: string[] = [];
        ipcMain.removeHandler("cockpit:pty-kill");
        ipcMain.handle("cockpit:pty-kill", (_event, sessionId: string) => {
          received.push(sessionId);
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-status", {
            sessionId, status: "exited", exitCode: 0,
          });
        });
        return received;
      });
      await page.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
      await page.getByLabel("CLI").selectOption("powershell");
      await page.getByLabel("セッション名").fill(sessionTitle);
      await page.getByRole("button", { name: /Start Session/u }).click();
      const row = page.getByTestId(/^session-row-/u);
      await expect(row).toHaveCount(1);
      const sessionId = (await row.getAttribute("data-testid"))!.slice("session-row-".length);
      await provide({
        app, page, sessionId,
        kills: () => killed.jsonValue(),
        setStatus: async (status) => {
          await app.evaluate(({ BrowserWindow }, payload) => {
            BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-status", payload);
          }, { sessionId, status });
          await expect(row.locator("[data-status]")).toHaveAttribute("data-status", status);
        },
      });
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  },
});

for (const status of ["idle", "waiting", "busy"] as const) {
  test(`${status}: 確認・キャンセルでは終了せず、承認後だけ終了する`, async ({ cockpit }) => {
    const { page, setStatus, kills, sessionId } = cockpit;
    await setStatus(status);
    const row = page.getByTestId(`session-row-${sessionId}`);
    const close = row.getByRole("button", { name: "セッションを終了" });
    await row.hover();
    await close.click();
    const dialog = page.getByRole("dialog", { name: "このセッションを終了しますか？" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(sessionTitle);
    await expect(dialog).toContainText("実行中の処理は中断されます。");
    expect(await kills()).toEqual([]);
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
    expect(await kills()).toEqual([]);
    await close.click();
    await dialog.getByRole("button", { name: "終了する" }).click();
    await expect(row).toHaveCount(0);
    expect(await kills()).toEqual([sessionId]);
    await expect(page.getByTestId("launcher")).toBeVisible();
  });
}

for (const status of ["exited", "error"] as const) {
  test(`${status}: 終了済みは確認せず一覧から除去する`, async ({ cockpit }) => {
    const { page, setStatus, kills, sessionId } = cockpit;
    await setStatus(status);
    const row = page.getByTestId(`session-row-${sessionId}`);
    await row.hover();
    await row.getByRole("button", { name: "一覧から除去" }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await kills()).toEqual([]);
  });
}

test("確認中は背面を操作せず、Enter・Escで安全にキャンセルできる", async ({ cockpit }, testInfo) => {
  const { app, page, kills, sessionId } = cockpit;
  const row = page.getByTestId(`session-row-${sessionId}`);
  const close = row.getByRole("button", { name: "セッションを終了" });
  await row.hover();
  await close.click();
  const dialog = page.getByRole("dialog");
  const cancel = dialog.getByRole("button", { name: "キャンセル" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await kills()).toEqual([]);
  await expect(close).toBeFocused();
  await close.click();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "終了する" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  for (const shortcut of ["Control+Shift+W", "Control+Shift+T", "Control+Shift+D", "F1"]) {
    await page.keyboard.press(shortcut);
  }
  await expect(page.locator(".tab-item")).toHaveCount(1);
  await expect(page.locator("[data-pane-id]")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(cancel).toBeFocused();
  for (const [width, height] of [[1280, 800], [820, 680]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(...size);
    }, [width, height] as [number, number]);
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`confirm-${width}.png`) });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(close).toBeFocused();
  expect(await kills()).toEqual([]);
});

test("タブの終了確認もキャンセルと確定が機能する", async ({ cockpit }) => {
  const { page, kills, sessionId } = cockpit;
  await page.locator(".tab-item.is-active .tab-close").click();
  const dialog = page.getByRole("dialog", { name: "タブ内のCLIを終了" });
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await kills()).toEqual([]);
  await page.locator(".tab-item.is-active .tab-close").click();
  await dialog.getByRole("button", { name: "終了する" }).click();
  await expect(page.getByTestId(`session-row-${sessionId}`)).toHaveCount(0);
  expect(await kills()).toEqual([sessionId]);
});
