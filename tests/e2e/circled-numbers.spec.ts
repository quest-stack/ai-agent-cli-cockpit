import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { PtyResizeRequest, PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

for (const renderer of ["dom", "webgl"] as const) {
  test(`${renderer}: circled headings stay readable without changing terminal cells or copied text`, async ({}, testInfo) => {
    const directory = testInfo.outputPath("user-data");
    const workspace = createDefaultWorkspace();
    workspace.settings.tourCompleted = true;
    workspace.settings.notificationsEnabled = false;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = join(directory, "entry.cjs");
    await writeFile(entry, `
      const {app}=require('electron');
      app.on('browser-window-created',(_,win)=>{win.show=()=>{};win.showInactive=()=>{}});
      require(${JSON.stringify(resolve(process.env.COCKPIT_TEST_APP_ROOT ?? process.cwd(), "dist/electron/main.js"))});
    `, "utf8");
    const app = await electron.launch({
      args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? [] : [entry],
      ...(process.env.COCKPIT_PACKAGED_EXECUTABLE
        ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE } : {}),
      env: { ...process.env, COCKPIT_USER_DATA: directory },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      await page.evaluate((mode) => {
        window.localStorage.setItem("cockpit.disableWebgl", mode === "dom" ? "1" : "0");
        window.localStorage.setItem("cockpit.forceWebgl", mode === "webgl" ? "1" : "0");
      }, renderer);
      const state = await app.evaluateHandle(({ ipcMain, clipboard }) => {
        const state = { written: [] as PtyWriteRequest[], copied: [] as string[], resized: [] as PtyResizeRequest[] };
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
          session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true },
        }));
        ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => state.written.push(request));
        ipcMain.on("cockpit:pty-resize", (_event, request: PtyResizeRequest) => state.resized.push(request));
        ipcMain.removeHandler("cockpit:clipboard-write-text");
        ipcMain.handle("cockpit:clipboard-write-text", (_event, text: string) => {
          state.copied.push(text);
          clipboard.writeText(text);
        });
        return state;
      });
      const launcher = page.getByTestId("launcher").filter({ visible: true });
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
      await launcher.getByLabel("CLI").selectOption(process.platform === "darwin" ? "shell" : "powershell");
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      const terminal = page.getByTestId(/^terminal-/u).filter({ visible: true });
      await expect(terminal.locator(".xterm-helper-textarea")).toBeAttached();
      const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
      const send = async (data: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { sessionId, data });
      };
      if (renderer === "webgl") {
        await expect(terminal.locator(".xterm-screen canvas").first()).toBeAttached();
      } else {
        await expect(terminal.locator(".xterm-rows")).toBeAttached();
      }
      await send("\x1b[2J\x1b[H\x1b[?25l\x1b[94;1m① SAMPLE\x1b[6n");
      await expect.poll(() => state.evaluate((state) => state.written.some((request) => request.data === "\x1b[1;9R"))).toBe(true);
      await send("\r\nA SAMPLE\r\n⑳ SAMPLE\r\n①②③SAMPLE\r\n\x1b[0m② normal\r\n③ 見出し\x1b[6n");
      await expect.poll(() => state.evaluate((state) => state.written.some((request) => request.data === "\x1b[6;9R"))).toBe(true);
      if (renderer === "dom") {
        await expect(terminal.locator(".xterm-rows")).toContainText("normal");
      }
      await expect.poll(() => state.evaluate((state) => state.resized.length)).toBeGreaterThan(0);
      const cols = await state.evaluate((state) => state.resized.at(-1)!.cols);
      const metrics = await terminal.evaluate(async (host, cols) => {
        await document.fonts.ready;
        const rows = host.querySelector<HTMLElement>(".xterm-rows");
        const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
        const cellWidth = screen.getBoundingClientRect().width / cols;
        const fontSize = 13;
        const family = rows ? window.getComputedStyle(rows).fontFamily : '"Cockpit Circled Numbers"';
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.font = `bold ${fontSize}px ${family}`;
        const circleWidth = context.measureText("①").width;
        const screenBounds = screen.getBoundingClientRect();
        const fonts = [family, '"HiraginoSans-W3"', '"Hiragino Sans"', '"Apple Symbols"'].map((font) => {
          context.font = `bold ${fontSize}px ${font}`;
          return { font, width: context.measureText("①").width };
        });
        return { cellWidth, circleWidth, fonts, width: screenBounds.width, height: screenBounds.height };
      }, cols);
      console.log(JSON.stringify({ platform: process.platform, renderer, metrics }));
      expect(metrics.circleWidth).toBeGreaterThanOrEqual(10);
      expect(metrics.circleWidth).toBeLessThanOrEqual(metrics.cellWidth * 2);
      if (renderer === "dom") {
        const positions = await terminal.locator(".xterm-rows").evaluate((rows) => {
          const first = rows.children[0] as HTMLElement;
          const control = rows.children[1] as HTMLElement;
          const circle = first.querySelector(".cockpit-spaced-circled")!;
          const compact = rows.children[3].querySelector<HTMLElement>(".cockpit-compact-circled")!;
          const labelRange = (row: HTMLElement) => {
            const walker = document.createTreeWalker(row, window.NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const index = node.textContent!.indexOf("SAMPLE");
              if (index < 0) continue;
              const range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              return range.getBoundingClientRect();
            }
            throw new Error("Sample label missing");
          };
          return {
            circleWidth: circle.getBoundingClientRect().width,
            labelOffset: labelRange(first).left - labelRange(control).left,
            compactWidth: compact.getBoundingClientRect().width,
            compactFont: window.getComputedStyle(compact).fontFamily,
          };
        });
        expect(positions.circleWidth).toBeCloseTo(metrics.cellWidth * 2, 0);
        expect(Math.abs(positions.labelOffset)).toBeLessThan(1);
        expect(positions.compactWidth).toBeCloseTo(metrics.cellWidth * 3, 0);
        expect(positions.compactFont).toContain("Cockpit Symbols");
        await writeFile(testInfo.outputPath("dom-geometry.json"), JSON.stringify({ metrics, positions }), "utf8");
      }
      const screen = terminal.locator(".xterm-screen");
      // Assert actual rasterized width too: merely loading the font did not fix 0.2.12.
      await expect.poll(async () => {
        const screenshot = await screen.screenshot();
        return app.evaluate(({ nativeImage }, input) => {
          const image = nativeImage.createFromBuffer(Buffer.from(input.png, "base64"));
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          const scale = width / input.width;
          let first = width;
          let last = -1;
          for (let y = 0; y < Math.min(height, Math.ceil(17 * scale)); y++) {
            for (let x = 0; x < Math.floor(input.cellWidth * 2 * scale); x++) {
              const offset = (y * width + x) * 4;
              const blue = bitmap[offset];
              const red = bitmap[offset + 2];
              if (blue > 100 && blue > red + 20) {
                first = Math.min(first, x);
                last = Math.max(last, x);
              }
            }
          }
          return (last - first + 1) / scale;
        }, { ...metrics, png: screenshot.toString("base64") });
      }).toBeGreaterThanOrEqual(9);
      await screen.screenshot({ path: testInfo.outputPath(`${renderer}-circles.png`) });
      if (renderer === "dom") {
        const spans = await terminal.locator(".xterm-rows").evaluate((rows) =>
          Array.from(rows.children).slice(0, 6).map((row) =>
            Array.from(row.children).map((span) => ({
              text: span.textContent,
              className: span.className,
              left: span.getBoundingClientRect().left,
              width: span.getBoundingClientRect().width,
            })),
          ),
        );
        await writeFile(testInfo.outputPath("dom-spans.json"), JSON.stringify(spans), "utf8");
        expect(spans[0][1].left - spans[0][0].left).toBeCloseTo(metrics.cellWidth * 2, 0);
      }
      const bounds = (await screen.boundingBox())!;
      await page.mouse.move(bounds.x + 0.5, bounds.y + 8);
      await page.mouse.down();
      await page.mouse.move(bounds.x + metrics.cellWidth * 8 - 0.5, bounds.y + 8);
      await page.mouse.up();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c");
      if (process.platform === "darwin") {
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("① SAMPLE");
      } else await expect.poll(() => state.evaluate((state) => state.copied)).toEqual(["① SAMPLE"]);
      await page.mouse.move(bounds.x + 0.5, bounds.y + 8);
      await page.mouse.down();
      await page.mouse.move(bounds.x + metrics.cellWidth - 0.5, bounds.y + 8);
      await page.mouse.up();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c");
      if (process.platform === "darwin") {
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("①");
      } else await expect.poll(() => state.evaluate((state) => state.copied)).toEqual(["① SAMPLE", "①"]);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
