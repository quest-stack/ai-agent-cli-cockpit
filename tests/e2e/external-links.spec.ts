import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import type { ElectronApplication, Page } from "@playwright/test";

// No visible app, real browser launches, clipboard changes, or user sessions.
test.describe.serial("terminal links open through the external-browser IPC", () => {
  let app: ElectronApplication;
  let page: Page;
  let sessionId: string;
  const url = "https://docs.slack.dev/ai/slack-mcp-server/";

  test.beforeAll(async ({}, testInfo) => {
    const userData = testInfo.outputPath("user-data");
    await mkdir(userData, { recursive: true });
    const entry = join(userData, "hidden-entry.cjs");
    await writeFile(entry, `
      const { app, shell } = require('electron');
      globalThis.linkTest = { opened: [], fail: false };
      shell.openExternal = async (url) => {
        if (globalThis.linkTest.fail) throw new Error('Browser unavailable');
        globalThis.linkTest.opened.push(url);
      };
      app.on('browser-window-created', (_event, win) => {
        win.show = () => {};
        win.showInactive = () => {};
      });
      require(${JSON.stringify(resolve("dist/electron/main.js"))});
    `, "utf8");
    app = await electron.launch({
      args: [entry],
      env: { ...process.env, COCKPIT_USER_DATA: userData },
    });
    page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible()) await page.getByRole("button", { name: "スキップ" }).click();
    await page.getByRole("combobox", { name: "プロジェクト" }).fill(process.cwd());
    await page.getByLabel("CLI").selectOption("powershell");
    await page.getByLabel("セッション名").fill("Link regression");
    await page.getByRole("button", { name: /Start Session/u }).click();
    const terminal = page.getByTestId(/^terminal-/u);
    await expect(terminal).toBeVisible();
    sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
    // Wait for bootstrap output to finish before injecting the test link.
    await page.evaluate((id) => window.cockpit?.killSession(id), sessionId);
    await page.evaluate(() => {
      window.confirm = () => true;
      window.alert = (message) => { document.body.dataset.linkError = String(message); };
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible()))).toBe(false);
  });

  test.afterAll(async () => { await app?.close(); });

  async function clickTerminalLink(): Promise<void> {
    await app.evaluate(({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", data);
    }, { sessionId, data: `\x1b[2J\x1b[H\x1b]8;;${url}\x07SLACK DOCS\x1b]8;;\x07` });
    const screen = page.getByTestId(`terminal-${sessionId}`).locator(".xterm-screen");
    await expect(screen).toContainText("SLACK DOCS");
    const box = await screen.locator(".xterm-rows > div").filter({ hasText: "SLACK DOCS" }).boundingBox();
    if (!box) throw new Error("Terminal screen is missing");
    const x = box.x + 20;
    const y = box.y + 8;
    await page.mouse.move(box.x + 200, box.y + 40);
    await page.mouse.move(x, y);
    await expect(screen).toHaveClass(/xterm-cursor-pointer/u);
    await page.mouse.click(x, y);
  }

  test("confirmed OSC 8 link reaches the OS opener exactly once", async () => {
    await clickTerminalLink();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: { opened: string[] } }).linkTest.opened)).toEqual([url]);
  });

  test("cancelled link does not launch a browser", async () => {
    await page.evaluate(() => { window.confirm = () => false; });
    await clickTerminalLink();
    expect(await app.evaluate(() => (globalThis as unknown as { linkTest: { opened: string[] } }).linkTest.opened)).toEqual([url]);
  });

  test("preload IPC rejects non-web URLs", async () => {
    const results = await page.evaluate(async () => Promise.all(
      ["file:///C:/Windows/system32/cmd.exe", "javascript:alert(1)", "ms-settings:"].map((value) => window.cockpit?.openExternalWebLink(value)),
    ));
    expect(results).toEqual([false, false, false]);
  });

  test("OS browser-launch failure is shown to the user", async () => {
    await app.evaluate(() => { (globalThis as unknown as { linkTest: { fail: boolean } }).linkTest.fail = true; });
    await page.evaluate(() => { window.confirm = () => true; });
    await clickTerminalLink();
    await expect(page.locator("body")).toHaveAttribute("data-link-error", /ブラウザを開けませんでした/u);
  });
});
