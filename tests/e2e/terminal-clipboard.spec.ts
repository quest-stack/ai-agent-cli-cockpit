import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test as base, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import { translate } from "../../src/shared/i18n";

import type { ElectronApplication, Page } from "@playwright/test";
import type { ClipboardPasteResult } from "../../src/shared/ipc";
import type { MessageKey } from "../../src/shared/i18n";
import type { PersistedWorkspace, PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

interface ClipboardFixture {
  app: ElectronApplication;
  page: Page;
  start: (command?: string) => Promise<string>;
  clipboard: (value: ClipboardPasteResult, fail?: boolean) => Promise<void>;
  calls: () => Promise<{ copied: string[]; reads: number; written: PtyWriteRequest[] }>;
  send: (id: string, data: string) => Promise<void>;
  saved: () => Promise<PersistedWorkspace>;
}

const language = process.env.COCKPIT_TEST_LANGUAGE === "en" ? "en" : "ja";
const ui = (key: MessageKey): string => translate(language, key);
const buildDirectory = process.env.COCKPIT_TEST_LANGUAGE ? `dist/editions/${language}` : "dist";

const test = base.extend<{ cockpit: ClipboardFixture }>({
  cockpit: async ({}, provide, testInfo) => {
    const directory = testInfo.outputPath("user-data");
    const workspace = createDefaultWorkspace();
    workspace.settings.tourCompleted = true;
    workspace.settings.notificationsEnabled = false;
    workspace.recent = [
      { command: "codex", cwd: "C:/work/project", projectName: "project", title: "Clipboard investigation", lastUsedAt: 2 },
      { command: "claude", cwd: "C:/work/project", projectName: "project", title: "入力操作の改善", lastUsedAt: 1 },
    ];
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = join(directory, "hidden-entry.cjs");
    await writeFile(entry, `
      const { app } = require('electron');
      app.on('browser-window-created', (_event, win) => {
        win.show = () => {};
        win.showInactive = () => {};
      });
      require(${JSON.stringify(resolve(`${buildDirectory}/electron/main.js`))});
    `, "utf8");
    const app = await electron.launch({
      args: [entry], env: { ...process.env, COCKPIT_LANGUAGE: language, COCKPIT_USER_DATA: directory },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      const state = await app.evaluateHandle(({ ipcMain }) => {
        const state = {
          value: { kind: "empty" } as ClipboardPasteResult,
          fail: false,
          copied: [] as string[], reads: 0, written: [] as PtyWriteRequest[],
        };
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
          session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true },
        }));
        ipcMain.removeHandler("cockpit:clipboard-read");
        ipcMain.handle("cockpit:clipboard-read", () => {
          state.reads += 1;
          if (state.fail) throw new Error("Clipboard unavailable");
          return state.value;
        });
        ipcMain.removeHandler("cockpit:clipboard-write-text");
        ipcMain.handle("cockpit:clipboard-write-text", (_event, text: string) => state.copied.push(text));
        ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => state.written.push(request));
        return state;
      });
      const send = async (sessionId: string, data: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { sessionId, data });
      };
      await provide({
        app, page, send,
        clipboard: async (value, fail = false) => { await state.evaluate((state, input) => { state.value = input.value; state.fail = input.fail; }, { value, fail }); },
        calls: () => state.evaluate(({ copied, reads, written }) => ({ copied, reads, written })),
        saved: async () => JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as PersistedWorkspace,
        start: async (command = "codex") => {
          const launcher = page.getByTestId("launcher").filter({ visible: true });
          await launcher.getByRole("combobox", { name: ui("プロジェクト") }).fill(resolve(process.cwd()));
          await launcher.getByLabel("CLI").selectOption(command);
          await launcher.getByLabel(ui("セッション名")).fill("Clipboard test");
          await launcher.getByRole("button", { name: /Start Session/u }).click();
          const terminal = page.getByTestId(/^terminal-/u).filter({ visible: true });
          await expect(terminal.locator(".xterm-helper-textarea")).toBeAttached();
          const id = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
          await send(id, "\x1b[2J\x1b[HCOPY ME\r\n> ");
          await expect(terminal.locator(".xterm-rows")).toContainText("COPY ME");
          await terminal.locator(".xterm-helper-textarea").focus();
          return id;
        },
      });
      expect(errors).toEqual([]);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible()))).toBe(false);
    } finally {
      await app.close();
    }
  },
});

test("Codex image paste sends one path without a native Ctrl+V", async ({ cockpit }) => {
  const id = await cockpit.start();
  const path = "C:/Temp/cockpit-paste-test.png";
  await cockpit.clipboard({ kind: "image", text: path });
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: path }] });
});

test("command paste sends only the command without a Ctrl+V prefix", async ({ cockpit }) => {
  const id = await cockpit.start("powershell");
  const command = "Write-Output 'clipboard-test'";
  await cockpit.clipboard({ kind: "text", text: command });
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: command }] });
});

test("multiline paste preserves bracketed paste and normalizes Windows newlines", async ({ cockpit }) => {
  const id = await cockpit.start("claude");
  await cockpit.send(id, "\x1b[?2004hBRACKETED READY");
  await expect(cockpit.page.locator(".xterm-rows")).toContainText("BRACKETED READY");
  await cockpit.clipboard({ kind: "text", text: "first\r\nsecond\n日本語" });
  await cockpit.page.keyboard.press("Control+Shift+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "\x1b[200~first\rsecond\r日本語\x1b[201~" }] });
});

test("empty clipboard sends no control key", async ({ cockpit }) => {
  await cockpit.start();
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [] });
});

test("holding paste does not attach repeated screenshots", async ({ cockpit }) => {
  const id = await cockpit.start();
  await cockpit.clipboard({ kind: "image", text: "C:/Temp/shot.png" });
  await cockpit.page.keyboard.down("Control");
  await cockpit.page.keyboard.down("v");
  await cockpit.page.keyboard.down("v");
  await cockpit.page.keyboard.up("v");
  await cockpit.page.keyboard.up("Control");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "C:/Temp/shot.png" }] });
});

test("paste remains single after a pane split reattaches the terminal", async ({ cockpit }) => {
  const id = await cockpit.start();
  await cockpit.page.keyboard.press("Control+Shift+D");
  const terminal = cockpit.page.getByTestId(`terminal-${id}`);
  await expect(terminal).toBeVisible();
  await terminal.locator(".xterm-helper-textarea").focus();
  await cockpit.clipboard({ kind: "text", text: "after-split" });
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "after-split" }] });
});

test("clipboard read failure is visible and sends nothing to the CLI", async ({ cockpit }) => {
  await cockpit.start();
  await cockpit.clipboard({ kind: "empty" }, true);
  await cockpit.page.keyboard.press("Control+v");
  await expect(cockpit.page.getByRole("status").filter({ hasText: ui("貼り付けできませんでした。コピーし直して、もう一度お試しください。") })).toBeVisible();
  expect((await cockpit.calls()).written).toEqual([]);
});

async function selectWord(page: Page): Promise<void> {
  const box = await page.locator(".xterm-rows > div").filter({ hasText: "COPY ME" }).boundingBox();
  if (!box) throw new Error("Terminal row missing");
  await page.mouse.dblclick(box.x + 10, box.y + box.height / 2);
  await expect(page.locator(".xterm-selection > div")).not.toHaveCount(0);
}

test("copy mode copies the selection without interrupting", async ({ cockpit }) => {
  await cockpit.start();
  await cockpit.page.getByTestId("ctrl-c-toggle").click();
  await selectWord(cockpit.page);
  await cockpit.page.keyboard.press("Control+c");
  await expect.poll(cockpit.calls).toEqual({ copied: ["COPY"], reads: 0, written: [] });
});

test("copy mode prevents unselected Ctrl+C and turning it off restores interrupt", async ({ cockpit }) => {
  const id = await cockpit.start();
  const toggle = cockpit.page.getByTestId("ctrl-c-toggle");
  await toggle.click();
  await cockpit.page.locator(".xterm-helper-textarea").focus();
  await cockpit.page.keyboard.press("Control+c");
  await toggle.click();
  await cockpit.page.locator(".xterm-helper-textarea").focus();
  await cockpit.page.keyboard.press("Control+c");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 0, written: [{ sessionId: id, data: "\x03" }] });
});

test("Ctrl+Shift+C still copies with copy mode disabled", async ({ cockpit }) => {
  await cockpit.start();
  await selectWord(cockpit.page);
  await cockpit.page.keyboard.press("Control+Shift+c");
  await expect.poll(cockpit.calls).toEqual({ copied: ["COPY"], reads: 0, written: [] });
});

test("copy mode persists across reload", async ({ cockpit }) => {
  await cockpit.page.getByTestId("ctrl-c-toggle").click();
  await expect.poll(async () => (await cockpit.saved()).settings.ctrlCCopies).toBe(true);
  await cockpit.page.reload();
  await expect(cockpit.page.getByTestId("ctrl-c-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("recent cards prioritize session names at desktop and narrow widths", async ({ cockpit }, testInfo) => {
  const { page } = cockpit;
  const cards = page.locator(".recent-item");
  await expect(cards.first().locator("span")).toHaveText("Clipboard investigation");
  await expect(cards.first().locator("small")).toHaveText("project");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width === 390) {
      await page.getByRole("button", { name: ui("サイドバーを折りたたむ") }).click();
      await page.getByTestId("ctrl-c-toggle").click();
    }
    await page.getByTestId("ctrl-c-toggle").focus();
    await expect(page.getByTestId("ctrl-c-toggle")).toBeVisible();
    await expect(cards.nth(1).locator("span")).toHaveText("入力操作の改善");
    await page.screenshot({ path: testInfo.outputPath(`launcher-${width}.png`), fullPage: true });
  }
});
