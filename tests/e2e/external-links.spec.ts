import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import type { ElectronApplication, Page } from "@playwright/test";

// Assertions inspect terminal control bytes, rather than user text.
/* eslint-disable no-control-regex */

interface LinkTestState {
  opened: string[];
  writes: { data: string; sessionId: string }[];
  fail: boolean;
}

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
      const { app, shell, ipcMain } = require('electron');
      globalThis.linkTest = { opened: [], fail: false, writes: [] };
      let press;
      let dragged = false;
      ipcMain.on('cockpit:pty-write', (_, payload) => {
        globalThis.linkTest.writes.push(payload);
        // Simulate Codex's stationary link click, including drag cancellation.
        const mouse = /^\u001b\\[<(\\d+);(\\d+);(\\d+)([mM])$/.exec(payload.data);
        if (mouse) {
          const [, button, x, y, kind] = mouse;
          if (button === '0' && kind === 'M') { press = [x, y]; dragged = false; }
          else if (button === '32') dragged = true;
          else if (button === '0' && kind === 'm') {
            if (press && !dragged && press[0] === x && press[1] === y && y === '1' && Number(x) <= 10) {
              globalThis.linkTest.opened.push(${JSON.stringify(url)});
            }
            press = undefined;
          }
        }
      });
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
      // リンクは確認なしで開く。confirm が呼ばれたら記録して拒否する。
      window.confirm = () => { document.body.dataset.confirmCalled = "1"; return false; };
      window.alert = (message) => { document.body.dataset.linkError = String(message); };
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible()))).toBe(false);
  });

  test.afterAll(async () => { await app?.close(); });

  async function prepareTerminalLink(protocol = ""): Promise<{ x: number; y: number }> {
    await app.evaluate(() => {
      const state = (globalThis as unknown as { linkTest: LinkTestState }).linkTest;
      state.opened = [];
      state.writes = [];
    });
    await app.evaluate(({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", data);
    }, { sessionId, data: `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l${protocol}\x1b[2J\x1b[H\x1b]8;;${url}\x07SLACK DOCS\x1b]8;;\x07` });
    const screen = page.getByTestId(`terminal-${sessionId}`).locator(".xterm-screen");
    await expect(screen).toContainText("SLACK DOCS");
    const box = await screen.locator(".xterm-rows > div").filter({ hasText: "SLACK DOCS" }).boundingBox();
    if (!box) throw new Error("Terminal screen is missing");
    const x = box.x + 20;
    const y = box.y + 8;
    await page.mouse.move(box.x + 200, box.y + 40);
    await page.mouse.move(x, y);
    await expect(screen).toHaveClass(/xterm-cursor-pointer/u);
    return { x, y };
  }

  async function clickTerminalLink(): Promise<void> {
    const { x, y } = await prepareTerminalLink();
    await page.mouse.click(x, y);
  }

  for (const mode of [1000, 1002, 1003]) {
    for (const encoding of ["default", "sgr"]) {
      test(`link click opens once with mouse mode ${mode} and ${encoding} encoding`, async () => {
        const { x, y } = await prepareTerminalLink(`\x1b[?${mode}h${encoding === "sgr" ? "\x1b[?1006h" : ""}`);
        await app.evaluate(() => { (globalThis as unknown as { linkTest: LinkTestState }).linkTest.writes = []; });
        await page.mouse.click(x, y);
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.opened)).toEqual([url]);
        const writes = await app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.writes);
        expect(writes.filter(({ data }) => /^\x1b\[(?:M|<)/u.test(data))).toEqual([]);
      });
    }
  }

  test("ordinary terminal clicks still reach the CLI", async () => {
    const { x, y } = await prepareTerminalLink("\x1b[?1002h\x1b[?1006h");
    await page.mouse.click(x + 200, y + 30);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.writes.map(({ data }) => data).filter((data) => /^\x1b\[<0;/u.test(data)))).toHaveLength(2);
  });

  test("successive intentional link clicks each open once", async () => {
    const { x, y } = await prepareTerminalLink("\x1b[?1002h\x1b[?1006h");
    await page.mouse.click(x, y);
    await page.mouse.click(x, y);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.opened)).toEqual([url, url]);
  });

  test("Shift-drag still selects terminal text with CLI mouse mode enabled", async () => {
    const { x, y } = await prepareTerminalLink("\x1b[?1002h\x1b[?1006h");
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(x + 45, y);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.getByTestId(`terminal-${sessionId}`).locator(".xterm-selection > div").first()).toBeVisible();
    expect(await app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.opened)).toEqual([]);
  });

  test("dragging from a link delivers the press before CLI movement without opening the link", async () => {
    const { x, y } = await prepareTerminalLink("\x1b[?1002h\x1b[?1006h");
    await page.mouse.down();
    await page.mouse.move(x + 30, y);
    // Returning to the start must remain a drag, not activate the link.
    await page.mouse.move(x, y);
    await page.mouse.up();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest.writes.filter(({ data }) => /^\x1b\[</u.test(data)).length)).toBeGreaterThanOrEqual(4);
    const state = await app.evaluate(() => (globalThis as unknown as { linkTest: LinkTestState }).linkTest);
    expect(state.writes.find(({ data }) => /^\x1b\[</u.test(data))?.data).toMatch(/^\x1b\[<0;\d+;\d+M$/u);
    expect(state.opened).toEqual([]);
  });

  test("OSC 8 link reaches the OS opener exactly once without a confirm dialog", async () => {
    await clickTerminalLink();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { linkTest: { opened: string[] } }).linkTest.opened)).toEqual([url]);
    await expect(page.locator("body")).not.toHaveAttribute("data-confirm-called", "1");
  });

  test("preload IPC rejects non-web URLs", async () => {
    const results = await page.evaluate(async () => Promise.all(
      ["file:///C:/Windows/system32/cmd.exe", "javascript:alert(1)", "ms-settings:"].map((value) => window.cockpit?.openExternalWebLink(value)),
    ));
    expect(results).toEqual([false, false, false]);
  });

  test("OS browser-launch failure is shown to the user", async () => {
    await app.evaluate(() => { (globalThis as unknown as { linkTest: { fail: boolean } }).linkTest.fail = true; });
    await clickTerminalLink();
    await expect(page.locator("body")).toHaveAttribute("data-link-error", /ブラウザを開けませんでした/u);
  });
});
