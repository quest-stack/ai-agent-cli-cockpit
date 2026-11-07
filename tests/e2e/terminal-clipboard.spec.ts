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
  spawned: () => Promise<SpawnSessionRequest[]>;
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
      { command: "codex resume", sessionId: "previous-codex", conversation: { cli: "codex", id: "11111111-1111-4111-8111-111111111111" }, cwd: "C:/work/project", projectName: "project", title: "Clipboard investigation", lastUsedAt: 2 },
      { command: "claude --continue", sessionId: "previous-claude", conversation: { cli: "claude", id: "22222222-2222-4222-8222-222222222222" }, cwd: "C:/work/project", projectName: "project", title: "入力操作の改善", lastUsedAt: 1 },
      { command: "codex", sessionId: "older-codex", conversation: { cli: "codex", id: "33333333-3333-4333-8333-333333333333" }, cwd: "C:/work/project", projectName: "project", title: "Older conversation", lastUsedAt: 0 },
      { command: "codex", cwd: "C:/unknown", projectName: "unknown", title: "No recorded identity", lastUsedAt: 0 },
    ];
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = join(directory, "hidden-entry.cjs");
    const packagedExecutable = process.env.COCKPIT_PACKAGED_EXECUTABLE;
    await writeFile(entry, `
      const { app } = require('electron');
      app.on('browser-window-created', (_event, win) => {
        win.show = () => {};
        win.showInactive = () => {};
      });
      ${packagedExecutable ? "" : `require(${JSON.stringify(resolve(`${buildDirectory}/electron/main.js`))});`}
    `, "utf8");
    const app = await electron.launch({
      args: packagedExecutable ? ["-r", entry] : [entry], ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      env: { ...process.env, COCKPIT_LANGUAGE: language, COCKPIT_USER_DATA: directory },
    });
    try {
      await app.evaluate(({ app, BrowserWindow }) => {
        const hide = (window: Electron.BrowserWindow): void => { window.show = () => {}; window.showInactive = () => {}; window.hide(); };
        app.on("browser-window-created", (_event, window) => hide(window));
        for (const window of BrowserWindow.getAllWindows()) hide(window);
      });
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false);
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      // Text/selection assertions below target xterm's DOM renderer. Keep that
      // fixture deterministic on both GPU-capable CI and DOM-fallback devices.
      await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
      const state = await app.evaluateHandle(({ ipcMain }) => {
        const state = {
          value: { kind: "empty" } as ClipboardPasteResult,
          fail: false,
          copied: [] as string[], reads: 0, written: [] as PtyWriteRequest[], spawned: [] as SpawnSessionRequest[],
        };
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => {
          state.spawned.push(request);
          return { session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true } };
        });
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
        spawned: () => state.evaluate((state) => state.spawned),
        start: async (command = "codex") => {
          const launcher = page.getByTestId("launcher").filter({ visible: true });
          await launcher.getByRole("combobox", { name: ui("プロジェクト") }).fill(resolve(process.cwd()));
          await launcher.getByTestId(`cli-option-${command}`).check();
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

for (const method of ["selection", "held-backspace"] as const) {
  test(`clearing the launcher project path with ${method} does not restore a previous directory`, async ({ cockpit }, testInfo) => {
    const width = method === "selection" ? 1280 : 390;
    await cockpit.app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(0, 0);
      window.setSize(width, 760);
    }, width);
    const project = cockpit.page.getByTestId("launcher").getByRole("combobox");
    await expect(project).toHaveValue("C:/work/project");
    await project.focus();
    if (method === "selection") {
      await cockpit.page.keyboard.press("Control+a");
      await cockpit.page.keyboard.press("Backspace");
    } else {
      await cockpit.page.keyboard.press("End");
      const length = (await project.inputValue()).length;
      for (let index = 0; index < length + 5; index++) {
        await cockpit.page.keyboard.down("Backspace");
      }
      await cockpit.page.keyboard.up("Backspace");
    }
    await cockpit.page.getByTestId("cli-option-claude").check();
    await cockpit.page.getByRole("button", { name: ui("プロジェクト候補を再スキャン") }).click();
    await expect(cockpit.page.getByRole("button", { name: /Start Session/u })).toBeDisabled();
    await expect(project).toHaveValue("");
    await cockpit.page.screenshot({ path: testInfo.outputPath(`launcher-empty-${width}.png`) });
  });
}

test("Codex image paste sends one path without a native Ctrl+V", async ({ cockpit }) => {
  const id = await cockpit.start();
  const path = "C:/Temp/cockpit-paste-test.png";
  await cockpit.clipboard({ kind: "image", text: path });
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: path }] });
});

for (const [cli, mode, expectedCommand] of [
  ["claude", "resume", "claude --resume"], ["claude", "continue", "claude --continue"],
  ["codex", "resume", "codex resume"], ["codex", "continue", "codex resume --last"],
] as const) {
  test(`${cli} ${mode} launches its own conversation history`, async ({ cockpit }) => {
    await expect(cockpit.page.getByTestId(`launch-mode-${mode}`)).toHaveAccessibleName(ui(mode === "resume" ? "会話を再開（resume）" : "直近のセッションを再開"));
    await cockpit.page.getByTestId(`launch-mode-${mode}`).check();
    if (mode === "resume") {
      await cockpit.page.getByTestId(`cli-option-${cli}`).check();
      await cockpit.page.getByTestId("launch-history-picker").click();
    } else await cockpit.start(cli);
    await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe(expectedCommand);
    await expect.poll(async () => (await cockpit.saved()).settings.defaultCommand).toBe(cli);
  });
}

test("resumed Codex keeps its newline binding", async ({ cockpit }) => {
  await cockpit.page.getByTestId("launch-mode-resume").check();
  await cockpit.page.getByTestId("cli-option-codex").check();
  await cockpit.page.getByRole("button", { name: /Start Session/u }).click();
  await expect.poll(async () => (await cockpit.spawned()).length).toBe(1);
  const id = (await cockpit.spawned())[0].id;
  await expect(cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-helper-textarea")).toBeAttached();
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-helper-textarea").focus();
  await cockpit.page.keyboard.press("Shift+Enter");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 0, written: [{ sessionId: id, data: "\x1b\r" }] });
});

test("command paste sends only the command without a Ctrl+V prefix", async ({ cockpit }) => {
  const id = await cockpit.start("powershell");
  const command = "Write-Output 'clipboard-test'";
  await cockpit.clipboard({ kind: "text", text: command });
  await cockpit.page.keyboard.press("Control+v");
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: command }] });
});

test("right-click pastes text through the same clipboard path once", async ({ cockpit }) => {
  const id = await cockpit.start("powershell");
  await cockpit.clipboard({ kind: "text", text: "right-click-text" });
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-screen").click({ button: "right", position: { x: 80, y: 40 } });
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "right-click-text" }] });
});

test("right-click pastes an image path once after terminal reattachment", async ({ cockpit }) => {
  const id = await cockpit.start();
  await cockpit.page.keyboard.press("Control+Shift+D");
  await cockpit.clipboard({ kind: "image", text: "C:/Temp/right-click-image.png" });
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-screen").click({ button: "right", position: { x: 80, y: 40 } });
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "C:/Temp/right-click-image.png" }] });
});

test("right-click copies selected text without pasting or interrupting", async ({ cockpit }) => {
  const id = await cockpit.start();
  await selectWord(cockpit.page);
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-screen").click({ button: "right", position: { x: 10, y: 8 } });
  await expect.poll(cockpit.calls).toEqual({ copied: ["COPY"], reads: 0, written: [] });
});

test("right-click preserves a TUI's SGR mouse reporting", async ({ cockpit }) => {
  const id = await cockpit.start();
  await cockpit.send(id, "\x1b[?1006h\x1b[?1000hMOUSE READY");
  await expect(cockpit.page.locator(".xterm-rows")).toContainText("MOUSE READY");
  await cockpit.clipboard({ kind: "text", text: "DO NOT PASTE" });
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-screen").click({ button: "right", position: { x: 80, y: 40 } });
  await expect.poll(async () => (await cockpit.calls()).written.length).toBeGreaterThan(0);
  expect((await cockpit.calls()).reads).toBe(0);
});

test("Shift plus right-click explicitly pastes while TUI mouse reporting is enabled", async ({ cockpit }) => {
  const id = await cockpit.start();
  await cockpit.send(id, "\x1b[?1000hMOUSE READY");
  await expect(cockpit.page.locator(".xterm-rows")).toContainText("MOUSE READY");
  await cockpit.clipboard({ kind: "text", text: "EXPLICIT PASTE" });
  await cockpit.page.getByTestId(`terminal-${id}`).locator(".xterm-screen").click({ button: "right", modifiers: ["Shift"], position: { x: 80, y: 40 } });
  await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 1, written: [{ sessionId: id, data: "EXPLICIT PASTE" }] });
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

async function ctrlCSetting(page: Page) {
  const toggle = page.getByTestId("ctrl-c-toggle");
  if (!(await toggle.isVisible())) {
    await page.getByRole("button", { name: ui("設定"), exact: true }).click();
  }
  return toggle;
}

test("copy mode copies the selection without interrupting", async ({ cockpit }) => {
  await cockpit.start();
  await (await ctrlCSetting(cockpit.page)).check();
  await selectWord(cockpit.page);
  await cockpit.page.keyboard.press("Control+c");
  await expect.poll(cockpit.calls).toEqual({ copied: ["COPY"], reads: 0, written: [] });
});

test("copy mode prevents unselected Ctrl+C and turning it off restores interrupt", async ({ cockpit }) => {
  const id = await cockpit.start();
  await (await ctrlCSetting(cockpit.page)).check();
  await cockpit.page.locator(".xterm-helper-textarea").focus();
  await cockpit.page.keyboard.press("Control+c");
  await (await ctrlCSetting(cockpit.page)).uncheck();
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
  await (await ctrlCSetting(cockpit.page)).check();
  await expect.poll(async () => (await cockpit.saved()).settings.ctrlCCopies).toBe(true);
  await cockpit.page.reload();
  await expect(await ctrlCSetting(cockpit.page)).toBeChecked();
});

for (const command of ["claude", "codex", "powershell"]) {
  test(`explicit cancel sends one Ctrl+C to ${command} while copy mode stays on`, async ({ cockpit }) => {
    const id = await cockpit.start(command);
    await (await ctrlCSetting(cockpit.page)).check();
    const input = cockpit.page.locator(".xterm-helper-textarea");
    await input.focus();
    await cockpit.page.keyboard.press("Control+c");
    await cockpit.page.keyboard.down("Control");
    await cockpit.page.keyboard.down("Shift");
    await cockpit.page.keyboard.down("x");
    await cockpit.page.keyboard.down("x");
    await cockpit.page.keyboard.up("x");
    await cockpit.page.keyboard.up("Shift");
    await cockpit.page.keyboard.up("Control");
    await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 0, written: [{ sessionId: id, data: "\x03" }] });
    await cockpit.page.getByTestId("cancel-input").click();
    await expect(input).toBeFocused();
    await expect.poll(cockpit.calls).toEqual({ copied: [], reads: 0,
      written: [{ sessionId: id, data: "\x03" }, { sessionId: id, data: "\x03" }] });
    await cockpit.page.keyboard.press("Control+c");
    await expect.poll(async () => (await cockpit.saved()).settings.ctrlCCopies).toBe(true);
    expect((await cockpit.calls()).written).toHaveLength(2);
  });
}

test("CLI buttons remember every selection across reload, new tabs and splits", async ({ cockpit }, testInfo) => {
  const { page } = cockpit;
  for (const command of ["powershell", "claude", "codex"]) {
    await page.getByTestId(`cli-option-${command}`).check();
    await expect.poll(async () => (await cockpit.saved()).settings.defaultCommand).toBe(command);
    await page.reload();
    await expect(page.getByTestId(`cli-option-${command}`)).toBeChecked();
  }
  await page.keyboard.press("Control+Shift+t");
  await expect(page.getByTestId("launcher").filter({ visible: true }).getByTestId("cli-option-codex")).toBeChecked();
  await page.keyboard.press("Control+Shift+d");
  const launchers = page.getByTestId("launcher").filter({ visible: true });
  await expect(launchers).toHaveCount(2);
  await expect(launchers.last().getByTestId("cli-option-codex")).toBeChecked();
  await launchers.last().getByTestId("cli-option-claude").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(launchers.last().getByTestId("cli-option-codex")).toBeChecked();
  await page.setViewportSize({ width: 1024, height: 900 });
  for (const launcher of await launchers.all()) {
    expect(await launcher.evaluate((element) => {
      const pane = element.closest(".empty-pane")!;
      return pane.scrollWidth <= pane.clientWidth;
    })).toBe(true);
  }
  const png = await cockpit.app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64"));
  await writeFile(testInfo.outputPath("split-cli-buttons-1024.png"), Buffer.from(png, "base64"));
});

test("reopening a recent CLI makes it the next launch preference", async ({ cockpit }) => {
  await cockpit.page.locator(".recent-item").first().click();
  await expect.poll(async () => (await cockpit.saved()).settings.defaultCommand).toBe("codex");
  await cockpit.page.keyboard.press("Control+Shift+t");
  await expect(cockpit.page.getByTestId("launcher").filter({ visible: true }).getByTestId("cli-option-codex")).toBeChecked();
});

for (const [index, cli, resume] of [[0, "codex", "codex resume 11111111-1111-4111-8111-111111111111"], [1, "claude", "claude --resume 22222222-2222-4222-8222-222222222222"]] as const) {
  test(`${cli}: recent folder new launch does not inherit a saved resume mode`, async ({ cockpit }) => {
    await cockpit.page.locator(".recent-item").nth(index).click();
    await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe(cli);
    expect((await cockpit.spawned()).at(-1)?.cwd).toBe("C:/work/project");
  });

  test(`${cli}: recent resume directly opens its original conversation`, async ({ cockpit }) => {
    await cockpit.page.getByTestId(`recent-resume-${index}`).click();
    await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe(resume);
    expect((await cockpit.spawned()).at(-1)?.cwd).toBe("C:/work/project");
    expect((await cockpit.spawned()).at(-1)).toMatchObject({ restoreConversation: true, conversation: { cli, id: resume.split(" ").at(-1) } });
  });

  test(`${cli}: resume then Start directly opens the selected conversation`, async ({ cockpit }, testInfo) => {
    await cockpit.page.getByTestId(`cli-option-${cli}`).check();
    await cockpit.page.getByTestId("launch-mode-resume").check();
    await expect(cockpit.page.getByTestId("resume-conversation")).toHaveValue(resume.split(" ").at(-1)!);
    await cockpit.page.screenshot({ path: testInfo.outputPath(`direct-resume-${cli}.png`) });
    await cockpit.page.getByRole("button", { name: /Start Session/u }).click();
    await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe(resume);
    expect((await cockpit.spawned()).at(-1)?.restoreConversation).toBe(true);
  });
}

test("resume selects an older same-folder conversation without substituting the latest", async ({ cockpit }) => {
  await cockpit.page.getByTestId("cli-option-codex").check();
  await cockpit.page.getByTestId("launch-mode-resume").check();
  await cockpit.page.getByTestId("resume-conversation").selectOption("33333333-3333-4333-8333-333333333333");
  await cockpit.page.getByRole("button", { name: /Start Session/u }).click();
  await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe("codex resume 33333333-3333-4333-8333-333333333333");
});

test("unknown conversation never silently opens a new session or the history picker", async ({ cockpit }) => {
  await expect(cockpit.page.getByTestId("recent-resume-3")).toBeDisabled();
  await cockpit.page.getByRole("combobox", { name: ui("プロジェクト") }).fill("C:/unknown");
  await cockpit.page.getByTestId("cli-option-codex").check();
  await cockpit.page.getByTestId("launch-mode-resume").check();
  await expect(cockpit.page.getByRole("button", { name: /Start Session/u })).toBeDisabled();
  expect(await cockpit.spawned()).toEqual([]);
  await cockpit.page.getByTestId("launch-history-picker").click();
  await expect.poll(async () => (await cockpit.spawned()).at(-1)?.command).toBe("codex resume");
});

test("resuming an open conversation reuses its tab and preserves unsent input", async ({ cockpit }) => {
  await cockpit.page.getByTestId("recent-resume-0").click();
  await expect.poll(async () => (await cockpit.spawned()).length).toBe(1);
  const id = (await cockpit.spawned())[0].id;
  await cockpit.send(id, "\x1b[2J\x1b[HUNSENT_DRAFT > keep this input");
  await expect(cockpit.page.getByTestId(`terminal-${id}`)).toContainText("UNSENT_DRAFT");
  await cockpit.page.getByRole("button", { name: ui("新規タブ"), exact: true }).click();
  await cockpit.page.getByTestId("recent-resume-0").click();
  await expect(cockpit.page.getByTestId(`terminal-${id}`)).toBeVisible();
  await expect(cockpit.page.getByTestId(`terminal-${id}`)).toContainText("keep this input");
  expect((await cockpit.spawned()).length).toBe(1);
  expect((await cockpit.calls()).written).toEqual([]);
});

test("direct resume controls fit desktop and narrow windows", async ({ cockpit }, testInfo) => {
  await cockpit.page.getByTestId("cli-option-codex").check();
  await cockpit.page.getByTestId("launch-mode-resume").check();
  for (const width of [1440, 390]) {
    await cockpit.app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(0, 0); window.setContentSize(width, 1000);
    }, width);
    if (width === 390) await cockpit.page.getByRole("button", { name: ui("サイドバーを折りたたむ") }).click();
    await cockpit.page.getByTestId("resume-conversation").scrollIntoViewIfNeeded();
    await expect(cockpit.page.getByTestId("resume-conversation")).toBeVisible();
    expect(await cockpit.page.locator(".launcher-card").evaluate(card => card.scrollWidth <= card.clientWidth)).toBe(true);
    const png = await cockpit.app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath(`resume-controls-${width}.png`), Buffer.from(png, "base64"));
  }
});

test("recent cards prioritize session names at desktop and narrow widths", async ({ cockpit }, testInfo) => {
  const { page } = cockpit;
  const cards = page.locator(".recent-item");
  await expect(cards.first().locator("span")).toHaveText("Clipboard investigation");
  await expect(cards.first().locator("small")).toHaveText("project");
  for (const width of [1440, 390]) {
    await cockpit.app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      // Only this QA instance bypasses the production 760px minimum.
      window.setMinimumSize(0, 0);
      window.setContentSize(width, 1000);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    if (width === 390) {
      await page.getByRole("button", { name: ui("サイドバーを折りたたむ") }).click();
    }
    await expect(page.getByRole("button", { name: ui("設定"), exact: true })).toBeVisible();
    await expect(await ctrlCSetting(page)).toBeVisible();
    await page.getByRole("button", { name: ui("設定"), exact: true }).click();
    await expect(cards.nth(1).locator("span")).toHaveText("入力操作の改善");
    await page.getByTestId("cli-option-codex").check();
    await expect(page.getByTestId("cli-option-codex")).toBeChecked();
    expect(await page.locator(".empty-pane").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Native capture can paint a resized hidden Electron window without
    // presenting it. The app scrolls inside the pane, so capture its viewport.
    const png = await cockpit.app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath(`launcher-${width}.png`), Buffer.from(png, "base64"));
  }
});
