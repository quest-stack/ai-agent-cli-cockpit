import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import type { ElectronApplication, Page } from "@playwright/test";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { PersistedWorkspace } from "../../src/shared/types";

test.skip(process.env.COCKPIT_ACTUAL_PROVIDERS !== "1" || !process.env.COCKPIT_ACTUAL_LEGACY_EVIDENCE || process.platform !== "win32", "Explicit migration acceptance using only the four owned conversations from a passed actual-provider test.");

test("legacy Claude and Codex tabs choose their history once and then resume the exact conversation automatically", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const evidence = JSON.parse(await readFile(process.env.COCKPIT_ACTUAL_LEGACY_EVIDENCE!, "utf8")) as {
    passed: boolean; packaged: boolean; actualInferenceTurns: number; directory: string; cwd: string;
    executablePath: string; artifactSha256: string; cases: {
      name: string; command: string; sessionId: string; tabId: string; marker: string; conversationId: string;
    }[];
  };
  expect(evidence).toMatchObject({ passed: true, packaged: true, actualInferenceTurns: 8 });
  const temp = await realpath(tmpdir()), cwd = await realpath(evidence.cwd), directory = await realpath(evidence.directory);
  expect(cwd.startsWith(temp + sep) && basename(cwd).startsWith("cockpit-owned-conversation-")).toBe(true);
  expect(directory).toBe(join(cwd, "cockpit-profile"));
  expect(evidence.cases.map(item => item.name)).toEqual(["claude-a", "claude-b", "codex-a", "codex-b"]);
  expect(new Set(evidence.cases.map(item => item.sessionId)).size).toBe(4);
  expect(evidence.cases.every(item => /^(?:qa-(?:claude|codex)-[ab]|session-[0-9a-f-]{36})$/u.test(item.sessionId))).toBe(true);
  const appAsar = join(dirname(evidence.executablePath), "resources", "app.asar");
  expect(createHash("sha256").update(await readFile(appAsar)).digest("hex")).toBe(evidence.artifactSha256);
  const workspacePath = join(directory, "session.json");
  const original = await readFile(workspacePath, "utf8");
  await writeFile(testInfo.outputPath("owned-workspace-before-legacy.json"), original, "utf8");
  const workspace = JSON.parse(original) as PersistedWorkspace;
  const legacy = evidence.cases.filter(item => item.name.endsWith("-a"));
  for (const item of evidence.cases) {
    const session = workspace.sessions.find(session => session.id === item.sessionId)!;
    if (!item.name.endsWith("-a") || session.conversation !== undefined) expect(session.conversation?.id).toBe(item.conversationId);
    expect(session.shouldRestore).toBe(true);
    if (item.name.endsWith("-a")) delete session.conversation;
  }
  workspace.activeTabId = legacy[0].tabId;
  await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
  const start = async (): Promise<ElectronApplication> => {
    const application = await electron.launch({
      executablePath: evidence.executablePath,
      args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
      env: { ...process.env, COCKPIT_USER_DATA: directory },
    });
    await application.evaluate(({ app, BrowserWindow, ipcMain }, input) => {
      const fs = process.getBuiltinModule("fs");
      ipcMain.on("cockpit:pty-write", (_event, input: { sessionId: string; data: string }) => {
        fs.appendFileSync(tracePath, `${JSON.stringify(input)}\n`);
      });
      const tracePath = input.keys;
      const http = process.getBuiltinModule("http");
      const original = http.Server.prototype.emit;
      const active = new Map<number, number>();
      http.Server.prototype.emit = function(this: Server, event: string, ...args: unknown[]): boolean {
        if (event === "upgrade") {
          const request = args[0] as IncomingMessage, socket = args[1] as Duplex;
          const port = request.socket.localPort ?? 0;
          fs.appendFileSync(input.connections, `${JSON.stringify({ time: Date.now(), port,
            activeBefore: active.get(port) ?? 0, hasAuthorization: Boolean(request.headers.authorization),
            hasOrigin: Boolean(request.headers.origin), path: request.url })}\n`);
          active.set(port, (active.get(port) ?? 0) + 1);
          socket.once("close", () => active.set(port, Math.max(0, (active.get(port) ?? 1) - 1)));
        }
        return Reflect.apply(original, this, [event, ...args]) as boolean;
      };
      const hide = (window: Electron.BrowserWindow): void => {
        window.webContents.setBackgroundThrottling(false); window.setOpacity(0);
        window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
        Object.getPrototypeOf(window).showInactive.call(window);
        window.show = () => {}; window.showInactive = () => {};
      };
      app.on("browser-window-created", (_event, window) => hide(window));
      for (const window of BrowserWindow.getAllWindows()) hide(window);
    }, { keys: testInfo.outputPath("owned-key-input.jsonl"), connections: testInfo.outputPath("owned-connection-metadata.jsonl") });
    return application;
  };
  const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(workspacePath, "utf8")) as PersistedWorkspace;
  const text = (page: Page, id: string): Promise<string> => page.getByTestId(`terminal-${id}`).locator(".xterm-rows > div").allTextContents().then(lines => lines.join("\n").replaceAll("\u00a0", " "));
  let app: ElectronApplication | undefined, page: Page | undefined;
  try {
    app = await start(); page = await app.firstWindow();
    for (const item of legacy) {
      await page.getByTestId(`tab-${item.tabId}`).click();
      await expect.poll(() => text(page!, item.sessionId), { timeout: 45_000 }).toMatch(/Resume (?:a previous )?session/iu);
      await writeFile(testInfo.outputPath(`picker-${item.name}.txt`), await text(page, item.sessionId), "utf8");
      await page.getByTestId(`terminal-${item.sessionId}`).screenshot({ path: testInfo.outputPath(`picker-${item.name}.png`) });
      const query = item.marker.split("_").slice(0, 4).join("_");
      if (item.command === "claude") await expect.poll(() => text(page!, item.sessionId)).toContain(query);
      else await expect.poll(() => text(page!, item.sessionId)).toMatch(/\b[12]\s*\/\s*2\b/u);
      // Codex may automatically summarize a conversation's title. The owned
      // fixture has exactly two threads, A older than B; choose the second row
      // in Updated order, then verify its actual UUID and recalled contents.
      const selected = async (): Promise<boolean> => item.command === "codex"
        ? /\b2\s*\/\s*2\b/u.test(await text(page!, item.sessionId))
        : (await text(page!, item.sessionId)).split("\n").some(line => /^[❯›>]/u.test(line.trim()) && line.includes(query));
      await expect.poll(async () => {
        if (await selected()) return true;
        await page!.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("ArrowDown");
        return false;
      }, { intervals: [500, 1000] }).toBe(true);
      await writeFile(testInfo.outputPath(`selected-row-${item.name}.txt`), await text(page, item.sessionId), "utf8");
      await page.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Enter");
      await expect.poll(async () => {
        const id = (await saved()).sessions.find(session => session.id === item.sessionId)?.conversation?.id;
        if (id === undefined && await selected() && /Resume (?:a previous )?session/iu.test(await text(page!, item.sessionId))) {
          await page!.getByTestId(`terminal-${item.sessionId}`).locator(".xterm-helper-textarea").press("Enter");
        }
        return id;
      }, { timeout: 45_000, intervals: [1000] }).toBe(item.conversationId);
      await expect.poll(() => text(page!, item.sessionId)).toContain(item.marker);
      await page.getByTestId(`terminal-${item.sessionId}`).screenshot({ path: testInfo.outputPath(`selected-${item.name}.png`) });
    }
    await app.close(); app = undefined;
    app = await start(); page = await app.firstWindow();
    for (const item of legacy) {
      await page.getByTestId(`tab-${item.tabId}`).click();
      await expect.poll(() => text(page!, item.sessionId), { timeout: 45_000 }).toContain(item.marker);
      expect(await text(page, item.sessionId)).not.toMatch(/resume a previous session/iu);
      await page.getByTestId(`terminal-${item.sessionId}`).screenshot({ path: testInfo.outputPath(`automatic-${item.name}.png`) });
    }
    expect((await saved()).sessions.map(session => session.conversation?.id)).toEqual(evidence.cases.map(item => item.conversationId));
    await writeFile(testInfo.outputPath("legacy-acceptance.json"), JSON.stringify({
      passed: true, packaged: true, artifactSha256: evidence.artifactSha256,
      providers: ["claude", "codex"], selectedOlderConversationRatherThanFolderLatest: true,
      selectedOnceThenRestoredAutomatically: true, extraInferenceTurns: 0, mockProviders: false,
    }, null, 2), "utf8");
  } finally {
    if (app) {
      if (page) await page.screenshot({ path: testInfo.outputPath("last-state.png") }).catch(() => undefined);
      await app.close();
    }
  }
});
