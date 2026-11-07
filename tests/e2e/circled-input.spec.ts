import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test as base } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Locator, Page } from "@playwright/test";
import type { PtyWriteRequest, SpawnSessionRequest } from "../../src/shared/types";

interface Fixture { app: ElectronApplication; page: Page; terminal: Locator; send: (data: string) => Promise<void>; writes: () => Promise<string[]>; copies: () => Promise<string[]>; columns: () => Promise<number> }
const test = base.extend<{ input: Fixture; renderer: "dom" | "webgl" }>({
  renderer: ["dom", { option: true }],
  input: async ({ renderer }, provide, testInfo) => {
    const directory = testInfo.outputPath("data"); await mkdir(directory, { recursive: true });
    const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = join(directory, "entry.cjs"), executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE;
    await writeFile(entry, `const {app}=require('electron');if(process.env.COCKPIT_TEST_DEVICE_SCALE)app.commandLine.appendSwitch('force-device-scale-factor',process.env.COCKPIT_TEST_DEVICE_SCALE);app.on('browser-window-created',(_,w)=>{w.show=()=>{};w.showInactive=()=>{}});${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}`, "utf8");
    const app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      // Match the existing output-glyph fixture on Intel Mac hosted VMs:
      // exercise actual WebGL through SwiftShader only in this trusted CI app.
      args: [...(renderer === "webgl" && process.platform === "darwin" && process.arch === "x64" && process.env.CI
        ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
      ...(executablePath ? ["-r", entry] : [entry]), "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
      env: { ...process.env, COCKPIT_USER_DATA: directory } });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]; window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
        Object.getPrototypeOf(window).showInactive.call(window); window.show = () => {}; window.showInactive = () => {};
        window.webContents.setBackgroundThrottling(false);
      });
      await expect(page.getByTestId("launcher")).toBeVisible();
      await page.evaluate(mode => { window.localStorage.setItem("cockpit.disableWebgl", mode === "dom" ? "1" : "0"); window.localStorage.setItem("cockpit.forceWebgl", mode === "webgl" ? "1" : "0"); }, renderer);
      const state = await app.evaluateHandle(({ ipcMain }) => {
        const state = { writes: [] as string[], copies: [] as string[], columns: 0 };
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => { state.columns = request.cols; return { session: { ...request, status: "idle", shouldRestore: true, startedAt: Date.now() } }; });
        ipcMain.on("cockpit:pty-write", (_event, request: PtyWriteRequest) => state.writes.push(request.data));
        ipcMain.on("cockpit:pty-resize", (_event, request: { cols: number }) => { state.columns = request.cols; });
        if (process.platform !== "darwin") {
          ipcMain.removeHandler("cockpit:clipboard-write-text"); ipcMain.handle("cockpit:clipboard-write-text", (_event, text: string) => { state.copies.push(text); });
        }
        return state;
      });
      const launcher = page.getByTestId("launcher");
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(directory);
      await launcher.getByTestId("cli-option-codex").focus(); await page.keyboard.press("Space");
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      const terminal = page.getByTestId(/^terminal-/u); await expect(terminal.locator(renderer === "dom" ? ".xterm-rows" : "canvas").first()).toBeAttached();
      const sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length);
      await terminal.locator(".xterm-helper-textarea").focus();
      await provide({ app, page, terminal,
        send: data => app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload), { sessionId, data }),
        writes: () => state.evaluate(state => state.writes),
        copies: () => process.platform === "darwin" ? app.evaluate(({ clipboard }) => [clipboard.readText()]) : state.evaluate(state => state.copies),
        columns: () => state.evaluate(state => state.columns) });
    } finally { await app.close(); }
  },
});

for (const renderer of ["dom", "webgl"] as const) test.describe(renderer, () => {
  test.use({ renderer });
  test("adjacent draft numbers have ordinary readable circles, including before following text", async ({ input }, testInfo) => {
    await input.send("\x1b[2J\x1b[3;1H\x1b[48;2;40;42;44m› \x1b[94m①② テスト\x1b[K\x1b[0m\x1b[3;5H\x1b[6n");
    await expect.poll(input.writes).toContain("\x1b[3;5R");
    const layer = input.terminal.locator(".cockpit-circled-input"); await expect(layer).toBeVisible();
    await expect(layer.locator(".cockpit-circled-input-symbol")).toHaveCount(2);
    await input.terminal.locator(".xterm-helper-textarea").press("ArrowLeft");
    await expect(layer.locator(".cockpit-circled-input-caret")).toBeVisible();
    await input.send("\x1b[?25l"); await expect(layer.locator(".cockpit-circled-input-caret")).toHaveCount(0);
    await input.send("\x1b[?25h"); await expect(layer.locator(".cockpit-circled-input-caret")).toBeVisible();
    const metrics = await layer.evaluate(layer => {
      const rect = layer.getBoundingClientRect();
      return [...layer.querySelectorAll(".cockpit-circled-input-symbol")].map(span => {
        const box = span.getBoundingClientRect(); return { x: box.x - rect.x, y: box.y - rect.y, width: box.width, height: box.height };
      });
    });
    const screenshot = await layer.screenshot(); await writeFile(testInfo.outputPath("readable-draft.png"), screenshot);
    const dimensions = await layer.boundingBox();
    const ink = await input.app.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data.png, "base64")), size = image.getSize(), pixels = image.toBitmap();
      const scale = size.width / data.width;
      return data.metrics.map(box => {
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (let y = Math.floor(box.y * scale); y < Math.min(size.height, Math.floor((box.y + box.height) * scale)); y++) {
          for (let x = Math.floor(box.x * scale); x < Math.min(size.width, Math.floor((box.x + box.width) * scale)); x++) {
            const offset = (y * size.width + x) * 4;
            if (pixels[offset] > 120 && pixels[offset] > pixels[offset + 2] + 35) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
          }
        }
        return { width: (right - left + 1) / scale, height: (bottom - top + 1) / scale };
      });
    }, { png: screenshot.toString("base64"), width: dimensions!.width, metrics });
    for (const circle of ink) { expect(circle.width).toBeGreaterThanOrEqual(12); expect(circle.height).toBeGreaterThanOrEqual(12); expect(circle.width / circle.height).toBeGreaterThan(0.8); expect(circle.width / circle.height).toBeLessThan(1.25); }
    await input.send("\x1b[0m\x1b[4;1HResult ①②\x1b[6n");
    await expect.poll(input.writes).toContain("\x1b[4;10R"); await expect(layer).toBeHidden();
  });

  test("draft mouse selection, cursor, copy and Japanese composition preserve logical input", async ({ input }) => {
    await input.send("\x1b[2J\x1b[3;1H\x1b[48;2;40;42;44m› ①②\x1b[K\x1b[0m\x1b[6n");
    await expect.poll(input.writes).toContain("\x1b[3;5R");
    const layer = input.terminal.locator(".cockpit-circled-input"); await expect(layer).toBeVisible();
    const symbols = layer.locator(".cockpit-circled-input-symbol");
    const first = (await symbols.nth(0).boundingBox())!, last = (await symbols.nth(1).boundingBox())!;
    await input.send("\x1b[?1000h\x1b[?1006h");
    await input.page.mouse.click(last.x + last.width * 0.75, last.y + last.height / 2);
    await expect.poll(input.writes).toContain("\x1b[<0;4;3M");
    // Xterm's Shift override is Windows/Linux-only. Mac tests normal selection
    // after verifying mouse reports; do not pretend Shift overrides a Mac TUI.
    if (process.platform === "darwin") {
      await input.send("\x1b[?1000l\x1b[?1006l\x1b[5n"); await expect.poll(input.writes).toContain("\x1b[0n");
    } else await input.page.keyboard.down("Shift");
    await input.page.mouse.move(first.x + 0.1, first.y + first.height / 2); await input.page.mouse.down();
    await input.page.mouse.move(last.x + last.width + 0.1, last.y + last.height / 2); await input.page.mouse.up();
    if (process.platform !== "darwin") await input.page.keyboard.up("Shift");
    await input.terminal.locator(".xterm-helper-textarea").press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c"); await expect.poll(input.copies).toContain("①②");
    await input.send("\x1b[?1000l\x1b[?1006l\x1b[3;5H");
    const helper = input.terminal.locator(".xterm-helper-textarea"); await helper.focus();
    const cdp = await input.page.context().newCDPSession(input.page);
    await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
    const composition = input.terminal.locator(".composition-view.active"); await expect(composition).toContainText("日本");
    const box = (await composition.boundingBox())!;
    expect(Math.abs(box.x - (last.x + last.width))).toBeLessThan(3);
    await cdp.send("Input.insertText", { text: "日本" }); await expect.poll(input.writes).toContain("日本");
    expect((await input.writes()).filter(text => text.includes("日本"))).toEqual(["日本"]);
    await cdp.detach();
  });

  test("wrapped draft circles stay readable when the cursor moves to another row", async ({ input }, testInfo) => {
    const columns = await input.columns(); expect(columns).toBeGreaterThan(30);
    await input.send(`\x1b[2J\x1b[3;1H\x1b[48;2;40;42;44m› ①② ${"A".repeat(columns - 5)}\x1b[4;1H  tail\x1b[K\x1b[0m\x1b[4;7H\x1b[6n`);
    await expect.poll(input.writes).toContain("\x1b[4;7R");
    const layer = input.terminal.locator(".cockpit-circled-input"); await expect(layer).toBeVisible();
    const symbols = layer.locator(".cockpit-circled-input-symbol"); await expect(symbols).toHaveCount(2);
    await expect(layer.locator(".cockpit-circled-input-caret")).toHaveCount(0);
    const row = layer.locator(".cockpit-circled-input-row");
    const bounds = (await row.boundingBox())!, last = (await row.locator(".cockpit-circled-input-cell").last().boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    const reportsBefore = (await input.writes()).filter(value => value === "\x1b[4;7R").length;
    await input.send("\x1b[?1000h\x1b[?1006h\x1b[6n");
    // IPC delivery does not mean xterm has parsed the mouse-mode change yet.
    await expect.poll(async () => (await input.writes()).filter(value => value === "\x1b[4;7R").length).toBe(reportsBefore + 1);
    // Read current children after paint, without retaining nodes replaced by render.
    let boxes: { x: number; y: number; width: number; height: number }[] = [];
    await expect.poll(async () => {
      boxes = await input.terminal.evaluate(host => [...host.querySelectorAll(".cockpit-circled-input:not([hidden]) .cockpit-circled-input-symbol")].map(node => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
      }));
      return boxes.length === 2 && boxes.every(box => box.width > 0 && box.height > 0);
    }).toBe(true);
    const [first, second] = boxes;
    await input.page.mouse.click(second.x + second.width * 0.75, second.y + second.height / 2);
    await expect.poll(input.writes).toContain("\x1b[<0;4;3M");
    if (process.platform === "darwin") {
      await input.send("\x1b[?1000l\x1b[?1006l\x1b[5n"); await expect.poll(input.writes).toContain("\x1b[0n");
    } else await input.page.keyboard.down("Shift");
    await input.page.mouse.move(first.x + 0.1, first.y + first.height / 2); await input.page.mouse.down();
    await input.page.mouse.move(second.x + second.width + 0.1, second.y + second.height / 2); await input.page.mouse.up();
    if (process.platform !== "darwin") await input.page.keyboard.up("Shift");
    await input.terminal.locator(".xterm-helper-textarea").press(process.platform === "darwin" ? "Meta+c" : "Control+Shift+c"); await expect.poll(input.copies).toContain("①②");
    await input.send("\x1b[?1000l\x1b[?1006l\x1b[3;5H");
    await expect(layer.locator(".cockpit-circled-input-caret")).toBeVisible();
    const helper = input.terminal.locator(".xterm-helper-textarea"); await helper.focus();
    const cdp = await input.page.context().newCDPSession(input.page);
    await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
    const composition = input.terminal.locator(".composition-view.active"); await expect(composition).toContainText("日本");
    const box = (await composition.boundingBox())!;
    expect(Math.abs(box.x - (second.x + second.width))).toBeLessThan(3);
    await cdp.send("Input.insertText", { text: "日本" }); await expect.poll(input.writes).toContain("日本"); await cdp.detach();
    await layer.screenshot({ path: testInfo.outputPath("wrapped-draft.png") });
  });

  test("the bottom composer remains inside the visible host after renderer metrics settle", async ({ input }, testInfo) => {
    await input.send("\x1b[2J\x1b[999;1H\x1b[48;2;40;42;44m› ①②\x1b[K\x1b[0m");
    const symbols = input.terminal.locator(".cockpit-circled-input:not([hidden]) .cockpit-circled-input-symbol");
    await expect(symbols).toHaveCount(2);
    // Font loading and xterm's fit/render notifications settle asynchronously.
    // Keep the exact containment requirement and wait for the resulting geometry.
    let geometry: unknown;
    try { await expect.poll(async () => {
      const host = (await input.terminal.boundingBox())!;
      const boxes = await Promise.all((await symbols.all()).map(symbol => symbol.boundingBox()));
      geometry = { host, boxes, layout: await input.terminal.evaluate(host => [...host.querySelectorAll('.xterm,.xterm-screen,.xterm-rows,.cockpit-circled-input')].map(element => ({ className: element.className, box: element.getBoundingClientRect().toJSON(), style: window.getComputedStyle(element).cssText }))) };
      return boxes.length === 2 && boxes.every(box => box && box.y >= host.y && box.y + box.height <= host.y + host.height);
    }).toBe(true); } finally { await writeFile(testInfo.outputPath('bottom-geometry.json'), JSON.stringify(geometry, null, 2), 'utf8'); }
  });

  test("unconfirmed IME circles are readable before commit and preserve exact text on commit or cancel", async ({ input }, testInfo) => {
    await input.send("\x1b[2J\x1b[3;1H\x1b[48;2;40;42;44m› \x1b[K\x1b[0m");
    const helper = input.terminal.locator(".xterm-helper-textarea"); await helper.focus();
    const cdp = await input.page.context().newCDPSession(input.page);
    const before = await input.writes();
    await cdp.send("Input.imeSetComposition", { text: "①②", selectionStart: 2, selectionEnd: 2 });
    const view = input.terminal.locator(".composition-view.active"); await expect(view).toHaveText("①②");
    await view.screenshot({ path: testInfo.outputPath("unconfirmed-pair.png") });
    const cellWidth = await input.terminal.locator(".xterm-screen").evaluate((screen, columns) => screen.getBoundingClientRect().width / columns, await input.columns());
    await expect.poll(async () => (await view.boundingBox())!.width).toBeGreaterThanOrEqual(cellWidth * 4 - 1);
    const circles = view.locator(".cockpit-composition-circle"); await expect(circles).toHaveCount(2);
    for (const circle of await circles.all()) {
      const png = await circle.screenshot();
      const cssWidth = (await circle.boundingBox())!.width;
      // Locator screenshots round the clip edges to device pixels. Dividing
      // their rounded width by a fractional CSS width invents a false scale.
      const pixelRatio = await circle.evaluate(() => window.devicePixelRatio);
      const ink = await input.app.evaluate(({ nativeImage }, data) => {
        const image = nativeImage.createFromBuffer(Buffer.from(data.png, "base64")), size = image.getSize(), pixels = image.toBitmap(), scale = data.pixelRatio;
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
          const offset = (y * size.width + x) * 4;
          if (pixels[offset] > 180 && pixels[offset + 1] > 180 && pixels[offset + 2] > 180) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
        return { width: (right - left + 1) / scale, height: (bottom - top + 1) / scale };
      }, { png: png.toString("base64"), pixelRatio });
      console.log(JSON.stringify({ renderer, cssWidth, pixelRatio, ink }));
      expect(ink.width).toBeGreaterThanOrEqual(12); expect(ink.height).toBeGreaterThanOrEqual(12);
      expect(ink.width / ink.height).toBeGreaterThan(0.8); expect(ink.width / ink.height).toBeLessThan(1.25);
    }
    expect(await input.writes()).toEqual(before);
    for (const text of ["項目①②を選択", `①② ${"長い未確定 ".repeat(45)}`]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await expect(view).toHaveText(text); await expect(circles).toHaveCount(2);
      const bounds = (await view.boundingBox())!, host = (await input.terminal.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(host.x); expect(bounds.x + bounds.width).toBeLessThanOrEqual(host.x + host.width + 1);
      expect(bounds.y).toBeGreaterThanOrEqual(host.y); expect(bounds.y + bounds.height).toBeLessThanOrEqual(host.y + host.height + 1);
      expect(await input.writes()).toEqual(before);
    }
    await cdp.send("Input.imeSetComposition", { text: "①②", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "①②" });
    await expect.poll(input.writes).toContain("①②"); expect((await input.writes()).filter(text => text.includes("①"))).toEqual(["①②"]);
    await expect(view).toHaveCount(0);
    await cdp.send("Input.imeSetComposition", { text: "①②", selectionStart: 2, selectionEnd: 2 });
    await expect(view).toHaveText("①②");
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await expect(view).toHaveCount(0);
    expect((await input.writes()).filter(text => text.includes("①"))).toEqual(["①②"]);
    expect((await input.writes()).some(text => text.includes("\uFE00"))).toBe(false);
    await cdp.detach();
  });
});
