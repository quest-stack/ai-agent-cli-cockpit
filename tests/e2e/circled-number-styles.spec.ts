import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { PtyResizeRequest, PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

// The circle alone is blue. Changing SGR between it and its following space
// must not make a readable two-cell heading collapse into a narrow oval.
const examples = [
  { name: "same attributes", text: "\x1b[94m① SAMPLE\x1b[0m", wide: true },
  { name: "color reset before space", text: "\x1b[94m①\x1b[0m SAMPLE", wide: true },
  { name: "bold reset before space", text: "\x1b[94;1m①\x1b[22m SAMPLE\x1b[0m", wide: true },
  { name: "color change before space", text: "\x1b[94m①\x1b[91m SAMPLE\x1b[0m", wide: true },
  { name: "fullwidth space", text: "\x1b[94m①\x1b[0m　SAMPLE", wide: true },
  { name: "no space before Japanese", text: "\x1b[94m①\x1b[0m見出し", wide: false },
  { name: "no space before ASCII", text: "\x1b[94m①\x1b[0mSAMPLE", wide: false },
  { name: "consecutive numbers", text: "\x1b[94m①\x1b[0m②③ SAMPLE", wide: false },
  { name: "number at end of line", text: "\x1b[94m①\x1b[0m", wide: false },
  { name: "ten", text: "\x1b[94m⑩ SAMPLE\x1b[0m", wide: true },
  { name: "twenty", text: "\x1b[94m⑳ SAMPLE\x1b[0m", wide: true },
  { name: "zero", text: "\x1b[94m⓪ SAMPLE\x1b[0m", wide: true },
  { name: "filled eleven", text: "\x1b[94m⓫ SAMPLE\x1b[0m", wide: true },
  { name: "double circle", text: "\x1b[94m⓵ SAMPLE\x1b[0m", wide: true },
  { name: "bold compact twenty", text: "\x1b[94;1m⑳\x1b[0mSAMPLE", wide: false },
  { name: "reported adjacent pair first", text: "\x1b[94m①\x1b[91m②\x1b[0m　これを見れば早いんじゃない？", wide: false },
  { name: "reported adjacent pair second", text: "\x1b[91m①\x1b[94m②\x1b[0m　これを見れば早いんじゃない？", wide: false, cellStart: 1 },
  { name: "reported complete line first", text: "\x1b[94m4. ①②　これを見れば早いんじゃない？\x1b[0m", wide: true, cellStart: 3, runIndex: 0, minWidth: 11 },
  { name: "reported complete line second", text: "\x1b[94m4. ①②　これを見れば早いんじゃない？\x1b[0m", wide: true, cellStart: 3, runIndex: 1, minWidth: 11 },
  { name: "three numbers share three blanks", text: "\x1b[94m①②③   日本語\x1b[0m", wide: true, runIndex: 0, minWidth: 11 },
  { name: "insufficient blanks keep the final number consistent", text: "\x1b[94m①②③　SAMPLE\x1b[0m", wide: false, cellStart: 2 },
] as const;
const expectedColumns = [9, 9, 9, 9, 10, 8, 8, 11, 2, 9, 9, 9, 9, 9, 8, 33, 33, 36, 36, 13, 12];

for (const renderer of ["dom", "webgl"] as const) {
  for (const alternate of [false, true]) {
    test(`${renderer}${alternate ? " alternate" : ""}: styled circled headings preserve their round shape`, async ({}, testInfo) => {
      const directory = testInfo.outputPath("user-data");
      await mkdir(directory, { recursive: true });
      const workspace = createDefaultWorkspace();
      workspace.settings.tourCompleted = true;
      workspace.settings.notificationsEnabled = false;
      await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
      const entry = join(directory, "entry.cjs");
      await writeFile(entry, `
        const {app}=require('electron');
        app.on('browser-window-created',(_,win)=>{win.show=()=>{};win.showInactive=()=>{}});
        ${process.env.COCKPIT_PACKAGED_EXECUTABLE ? "" : `require(${JSON.stringify(resolve(process.env.COCKPIT_TEST_APP_ROOT ?? process.cwd(), "dist/electron/main.js"))});`}
      `, "utf8");
      const app = await electron.launch({
        args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? ["-r", entry] : [entry],
        ...(process.env.COCKPIT_PACKAGED_EXECUTABLE
          ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE } : {}),
        env: { ...process.env, COCKPIT_USER_DATA: directory },
      });
      try {
        if (process.env.COCKPIT_PACKAGED_EXECUTABLE) await app.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
            Object.getPrototypeOf(window).showInactive.call(window);
          }
        });
        const page = await app.firstWindow();
        await expect(page.getByTestId("launcher")).toBeVisible();
        await page.evaluate((mode) => {
          window.localStorage.setItem("cockpit.disableWebgl", mode === "dom" ? "1" : "0");
          window.localStorage.setItem("cockpit.forceWebgl", mode === "webgl" ? "1" : "0");
        }, renderer);
        const state = await app.evaluateHandle(({ ipcMain }) => {
          const state = { written: [] as PtyWriteRequest[], resized: [] as PtyResizeRequest[], copied: [] as string[] };
          ipcMain.removeHandler("cockpit:pty-spawn");
          ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
            session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true },
          }));
          ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => state.written.push(request));
          ipcMain.on("cockpit:pty-resize", (_event, request: PtyResizeRequest) => state.resized.push(request));
          ipcMain.removeHandler("cockpit:clipboard-write-text");
          ipcMain.handle("cockpit:clipboard-write-text", (_event, text: string) => state.copied.push(text));
          return state;
        });
        const launcher = page.getByTestId("launcher").filter({ visible: true });
        await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
        await launcher.getByTestId(`cli-option-${process.platform === "darwin" ? "shell" : "powershell"}`).check();
        await launcher.getByRole("button", { name: /Start Session/u }).click();
        const terminal = page.getByTestId(/^terminal-/u).filter({ visible: true });
        const screen = terminal.locator(".xterm-screen");
        await expect(terminal.locator(renderer === "dom" ? ".xterm-rows" : ".xterm-screen canvas").first()).toBeAttached();
        await expect.poll(() => state.evaluate((value) => value.resized.length)).toBeGreaterThan(0);
        const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
        const text = (alternate ? "\x1b[?1049h" : "") + "\x1b[2J\x1b[H\x1b[?25l" + examples.map((example) => `${example.text}\x1b[6n`).join("\r\n");
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { sessionId, data: text });
        const finalReport = `\x1b[${examples.length};${expectedColumns.at(-1)}R`;
        await expect.poll(() => state.evaluate((value, report) => value.written.some((request) => request.data === report), finalReport)).toBe(true);
        const size = await state.evaluate((value) => value.resized.at(-1)!);
        const bounds = await screen.boundingBox();
        expect(bounds).not.toBeNull();
        await terminal.evaluate(async () => { await document.fonts.ready; });
        const cursorReports = await state.evaluate((value) => value.written.map((request) => request.data).filter((data) => data.startsWith("\x1b[") && data.endsWith("R")));
        expect(cursorReports).toEqual(expectedColumns.map((column, row) => `\x1b[${row + 1};${column}R`));
        await writeFile(testInfo.outputPath(`${renderer}-cursor.json`), JSON.stringify(cursorReports), "utf8");
        // Capture copies in the fixture rather than changing the OS clipboard.
        const cellWidth = bounds!.width / size.cols;
        const cellHeight = bounds!.height / size.rows;
        await page.mouse.move(bounds!.x + 0.5, bounds!.y + cellHeight * 1.5);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + cellWidth * 8 - 0.5, bounds!.y + cellHeight * 1.5);
        await page.mouse.up();
        await page.keyboard.press("Control+Shift+c");
        await expect.poll(() => state.evaluate((value) => value.copied)).toEqual(["① SAMPLE"]);
        await page.mouse.click(bounds!.x + cellWidth * 12, bounds!.y + cellHeight * 1.5);
        await page.mouse.move(bounds!.x + 0.5, bounds!.y + cellHeight * 17.5);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + cellWidth * 35 - 0.5, bounds!.y + cellHeight * 17.5);
        await page.mouse.up();
        await page.keyboard.press("Control+Shift+c");
        await expect.poll(() => state.evaluate((value) => value.copied)).toEqual(["① SAMPLE", "4. ①②　これを見れば早いんじゃない？"]);
        await page.mouse.click(bounds!.x + cellWidth * 40, bounds!.y + cellHeight * 17.5);
        const collectMetrics = async (stage: string): Promise<void> => {
          const size = await state.evaluate((value) => value.resized.at(-1)!);
          const bounds = (await screen.boundingBox())!;
          // This fixture uses the terminal's fixed 13px font, also used by the
          // base circle suite. WebGL has no DOM measurement span to inspect.
          const font = await screen.evaluate((element, fontSize) => {
            const context = element.ownerDocument.createElement("canvas").getContext("2d")!;
            context.font = `${fontSize}px "${window.cockpit?.platform === "darwin" ? "Cockpit Mac Circled Numbers" : "Cockpit Circled Numbers"}"`;
            return { size: fontSize, wideAdvance: context.measureText("①\uFE00").width };
          }, 13);
          const wideAdvance = font.wideAdvance;
          const screenshot = await screen.screenshot({ path: testInfo.outputPath(`${renderer}-${stage}-styles.png`) });
          await page.screenshot({ path: testInfo.outputPath(`${renderer}-${stage}-reported-line.png`), clip: {
            x: bounds.x, y: bounds.y + 17 * bounds.height / size.rows,
            width: Math.min(bounds.width, 520), height: bounds.height / size.rows,
          } });
          const raster = await app.evaluate(({ nativeImage }, input) => {
            const image = nativeImage.createFromBuffer(Buffer.from(input.png, "base64"));
            const imageSize = image.getSize();
            const bitmap = image.toBitmap();
            const scale = imageSize.width / input.width;
            const cellWidth = imageSize.width / input.cols;
            const cellHeight = imageSize.height / input.rows;
            return Array.from({ length: input.count }, (_, row) => {
              let minX = imageSize.width, maxX = -1, minY = imageSize.height, maxY = -1, inkPixels = 0;
              for (let y = Math.floor(row * cellHeight); y < Math.floor((row + 1) * cellHeight); y++) {
                const start = cellWidth * input.starts[row] + input.runIndexes[row] * input.wideAdvance * scale;
                const width = input.runs[row] ? input.wideAdvance * scale : cellWidth * input.cells[row];
                for (let x = Math.floor(start); x < Math.floor(start + width); x++) {
                  const offset = (y * imageSize.width + x) * 4;
                  const blue = bitmap[offset], red = bitmap[offset + 2];
                  if (blue > 100 && blue > red + 40) {
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                    inkPixels += 1;
                  }
                }
              }
              return { width: (maxX - minX + 1) / scale, height: (maxY - minY + 1) / scale, inkPixels };
            });
          }, { png: screenshot.toString("base64"), width: bounds!.width, cols: size.cols, rows: size.rows, count: examples.length,
            cells: examples.map(example => example.wide ? 2 : 1), starts: examples.map(example => "cellStart" in example ? example.cellStart : 0),
            runs: examples.map(example => "runIndex" in example), runIndexes: examples.map(example => "runIndex" in example ? example.runIndex : 0), wideAdvance });
          const metrics = examples.map((example, index) => ({ name: example.name, ...raster[index], ratio: raster[index].width / raster[index].height }));
          await writeFile(testInfo.outputPath(`${renderer}-${stage}-styles.json`), JSON.stringify({ renderer, fontSize: font.size, wideAdvance, metrics }, null, 2), "utf8");
          for (let index = 0; index < examples.length; index += 1) {
            const example = examples[index];
            expect.soft(metrics[index].width, example.name).toBeGreaterThanOrEqual("minWidth" in example ? example.minWidth : example.wide ? 9 : 5);
            expect.soft(metrics[index].ratio, examples[index].name).toBeGreaterThanOrEqual(0.8);
            expect.soft(metrics[index].ratio, examples[index].name).toBeLessThanOrEqual(1.25);
          }
          // Same-size outlines for 1, 10, 20 and 0 must retain distinct digit ink.
          expect(new Set([metrics[0], metrics[9], metrics[10], metrics[11]].map((item) => item.inkPixels)).size).toBeGreaterThanOrEqual(3);
        };
        await collectMetrics("initial");
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
        await expect.poll(() => state.evaluate((value) => value.resized.at(-1)?.cols)).not.toBe(size.cols);
        await collectMetrics("resized");
      } finally {
        await app.close();
      }
    });
  }
}
