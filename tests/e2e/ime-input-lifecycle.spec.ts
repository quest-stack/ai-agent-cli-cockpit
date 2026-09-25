import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test as base, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { CDPSession, Locator, Page } from "@playwright/test";
import type { PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

interface ImeFixture {
  cdp: CDPSession;
  helper: Locator;
  page: Page;
  send: (data: string) => Promise<void>;
  writes: () => Promise<string[]>;
}

const test = base.extend<{ ime: ImeFixture; command: string }>({
  command: ["codex", { option: true }],
  ime: async ({ command }, provide, testInfo) => {
    const directory = testInfo.outputPath("user-data");
    const workspace = createDefaultWorkspace();
    workspace.settings.tourCompleted = true;
    workspace.settings.notificationsEnabled = false;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = join(directory, "hidden-entry.cjs");
    await writeFile(entry, `
      const { app } = require('electron');
      app.on('browser-window-created', (_, win) => { win.show = () => {}; win.showInactive = () => {}; });
      require(${JSON.stringify(resolve("dist/electron/main.js"))});
    `, "utf8");
    const app = await electron.launch({
      args: [entry], env: { ...process.env, COCKPIT_USER_DATA: directory },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      const state = await app.evaluateHandle(({ ipcMain }) => {
        const writes: PtyWriteRequest[] = [];
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
          session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true },
        }));
        ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => writes.push(request));
        return writes;
      });
      await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
      await page.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
      await page.getByLabel("CLI").selectOption(command);
      await page.getByRole("button", { name: /Start Session/u }).click();
      const host = page.getByTestId(/^terminal-/u);
      const helper = host.locator(".xterm-helper-textarea");
      await expect(helper).toBeAttached();
      await helper.focus();
      const sessionId = (await host.getAttribute("data-testid"))!.slice("terminal-".length);
      const writes = () => state.evaluate((values) => values.map((value) => value.data));
      const send = async (data: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { sessionId, data });
      };
      const cdp = await page.context().newCDPSession(page);
      await provide({ cdp, helper, page, send, writes });
      expect(errors).toEqual([]);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible()))).toBe(false);
    } finally {
      await app.close();
    }
  },
});

async function ready(ime: ImeFixture): Promise<void> {
  await ime.send("\x1b[2J\x1b[20;3H\x1b[6n");
  await expect.poll(ime.writes).toContain("\x1b[20;3R");
}

async function compose(ime: ImeFixture, text: string): Promise<void> {
  await ime.cdp.send("Input.imeSetComposition", {
    text, selectionStart: text.length, selectionEnd: text.length,
  });
  await expect(ime.page.locator(".composition-view.active")).toHaveText(text);
  await ime.cdp.send("Input.insertText", { text });
  await expect(ime.page.locator(".composition-view.active")).toHaveCount(0);
}

for (const command of ["codex", "claude"]) {
  test.describe(command, () => {
    test.use({ command });

    test("first synchronized output keeps an on-screen nonzero IME input target", async ({ ime }) => {
      await ime.send("\x1b[?2026h\x1b[10;10H\x1b[6n");
      await expect.poll(ime.writes).toContain("\x1b[10;10R");
      const geometry = await ime.helper.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const host = element.closest(".terminal-host")!.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, within: bounds.x >= host.x && bounds.y >= host.y && bounds.right <= host.right && bounds.bottom <= host.bottom };
      });
      expect(geometry.within).toBe(true);
      expect(geometry.width).toBeGreaterThanOrEqual(1);
      expect(geometry.height).toBeGreaterThanOrEqual(1);
    });

    test("successive Chromium composition commits deliver the new text exactly once", async ({ ime }) => {
      await ready(ime);
      const before = (await ime.writes()).length;
      for (const text of ["最初の変換", "次", "最後の日本語"]) {
        await compose(ime, text);
      }
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["最初の変換", "次", "最後の日本語"]);
    });

    test("replacing stale textarea content does not swallow the committed Japanese", async ({ ime }) => {
      await ready(ime);
      await ime.page.keyboard.type("   ");
      await expect(ime.helper).toHaveValue("   ");
      const before = (await ime.writes()).length;
      // TSF can replace the entire helper value, including text already sent to the PTY.
      await ime.cdp.send("Input.imeSetComposition", {
        text: "あ", selectionStart: 1, selectionEnd: 1,
        replacementStart: 0, replacementEnd: 3,
      });
      await ime.cdp.send("Input.insertText", { text: "あ" });
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["あ"]);
    });

    test("cancelled composition sends no Japanese or stale text", async ({ ime }) => {
      await ready(ime);
      await compose(ime, "確定済み");
      await expect.poll(ime.writes).toContain("確定済み");
      const before = (await ime.writes()).length;
      await ime.cdp.send("Input.imeSetComposition", { text: "取消", selectionStart: 2, selectionEnd: 2 });
      await ime.cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
      await expect(ime.page.locator(".composition-view.active")).toHaveCount(0);
      // A PTY round trip also lets the composition's deferred work finish.
      await ime.send("\x1b[6n");
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["\x1b[20;3R"]);
    });

    test("IME Shift+Enter commits once without submitting, then ordinary keys work", async ({ ime }) => {
      await ready(ime);
      const before = (await ime.writes()).length;
      await ime.cdp.send("Input.imeSetComposition", { text: "確定", selectionStart: 2, selectionEnd: 2 });
      const prevented = await ime.helper.evaluate((element) => {
        const event = new window.KeyboardEvent("keydown", {
          bubbles: true, cancelable: true, code: "Enter", key: "Process",
          keyCode: 229, isComposing: true, shiftKey: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(false);
      await ime.cdp.send("Input.insertText", { text: "確定" });
      // The second keydown belongs to the same physical Shift+Enter press.
      await ime.helper.dispatchEvent("keydown", {
        bubbles: true, cancelable: true, code: "Enter", key: "Enter",
        keyCode: 13, shiftKey: true,
      });
      await ime.page.keyboard.press("Space");
      await ime.page.keyboard.press("a");
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["確定", " ", "a"]);
    });

    test("keydown finalization followed by compositionend does not duplicate a commit", async ({ ime }) => {
      await ready(ime);
      const before = (await ime.writes()).length;
      await ime.cdp.send("Input.imeSetComposition", { text: "先行確定", selectionStart: 4, selectionEnd: 4 });
      await expect(ime.page.locator(".composition-view.active")).toHaveText("先行確定");
      // Some input methods deliver a normal key before compositionend.
      await ime.helper.dispatchEvent("keydown", {
        bubbles: true, cancelable: true, code: "KeyX", key: "x", keyCode: 88,
      });
      await ime.cdp.send("Input.insertText", { text: "先行確定" });
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["先行確定", "x"]);
    });

    test("Japanese input survives tab changes and terminal reattachment after splitting", async ({ ime }) => {
      await ready(ime);
      await compose(ime, "切替前");
      await ime.page.keyboard.press("Control+Shift+t");
      await expect(ime.page.getByTestId("launcher").filter({ visible: true })).toBeVisible();
      await ime.page.keyboard.press("Control+Shift+Tab");
      await expect(ime.helper).toBeFocused();
      await ime.page.keyboard.press("Control+Shift+d");
      const original = ime.page.getByTestId(/^terminal-/u);
      await original.locator(".xterm-screen").click();
      await expect(ime.helper).toBeFocused();
      const before = (await ime.writes()).length;
      await compose(ime, "切替後");
      await expect.poll(async () => (await ime.writes()).slice(before)).toEqual(["切替後"]);
    });

    test("a full-width character continuation cell cannot leave a zero-width IME target", async ({ ime }) => {
      await ready(ime);
      await ime.send("\x1b[20;3Hあ\x1b[20;4H\x1b[6n");
      await expect.poll(ime.writes).toContain("\x1b[20;4R");
      expect(await ime.helper.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1);
    });
  });
}
