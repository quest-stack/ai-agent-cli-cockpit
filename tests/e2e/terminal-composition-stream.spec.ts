import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import type { SpawnSessionRequest } from "../../src/shared/types";

for (const scenario of ["継続中", "描画途中に開始", "長文の変換"] as const) {
  test(`同期描画でIMEが会話本文へ飛ばない: ${scenario}`, async ({}, testInfo) => {
    const app = await electron.launch({
      args: ["."],
      cwd: resolve(process.cwd()),
      env: { ...process.env, COCKPIT_USER_DATA: testInfo.outputPath("user-data") },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByTestId("launcher")).toBeVisible();
      // CLI を呼び出さず、既知の出力だけを通常の PTY IPC 経由で流す。
      const writes = await app.evaluateHandle(({ ipcMain }) => {
        ipcMain.removeHandler("cockpit:pty-spawn");
        ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
          session: { ...request, shouldRestore: true, startedAt: Date.now(), status: "idle" },
        }));
        const received: string[] = [];
        ipcMain.on("cockpit:pty-write", (_event, request: { data: string }) => {
          received.push(request.data);
        });
        return received;
      });
      await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
      const tour = page.getByTestId("tour-overlay");
      if (await tour.isVisible()) {
        await page.getByRole("button", { name: "スキップ" }).click();
      }
      await page.getByRole("combobox", { name: "プロジェクト" }).fill(resolve(process.cwd()));
      await page.getByLabel("CLI").selectOption("codex");
      await page.getByRole("button", { name: /Start Session/u }).click();
      const helper = page.locator(".xterm-helper-textarea");
      await expect(helper).toBeAttached();
      const host = page.locator(".terminal-host");
      const sessionId = (await host.getAttribute("data-testid"))!.slice("terminal-".length);
      const send = async (data: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send("cockpit:pty-data", payload);
        }, { data, sessionId });
      };
      const position = () => helper.evaluate((element) => ({
        left: element.style.left,
        top: element.style.top,
        viewTop: element.parentElement!.querySelector<HTMLElement>(".composition-view")!.style.top,
        lineHeight: element.parentElement!.querySelector<HTMLElement>(".composition-view")!.style.lineHeight,
      }));
      const compose = async (start: boolean, text: string): Promise<void> => {
        await helper.evaluate((element, input) => {
          if (input.start) {
            element.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
          }
          element.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: input.text }));
        }, { start, text });
      };

      // 最初の画面では入力欄だけ。その後、履歴が増えた2ターン目の画面へ進む。
      await send("\x1b[2J\x1b[HReady\x1b[20;1H> ");
      await expect(page.locator(".xterm-rows")).toContainText("Ready");
      await compose(true, "かくにん");
      await expect(page.locator(".composition-view")).toHaveText("かくにん");
      const initial = await position();
      await helper.dispatchEvent("compositionend", { data: "" });
      await send("\x1b[?2026h\x1b[H" + "Previous answer\r\n".repeat(15) + "\x1b[20;1H> \x1b[?2026l");
      await expect(page.locator(".xterm-rows")).toContainText("Previous answer");
      const preedit = scenario === "長文の変換" ? "にほんご".repeat(70) : "つぎ";
      if (scenario !== "描画途中に開始") {
        await compose(true, preedit);
        expect(await position()).toEqual(initial);
      }

      // 同期出力を分割。本文の描画途中ではカーソルが入力欄を離れる。
      // DSR 応答を待ち、タイマー待ちなしで xterm がこの位置まで解析したと確かめる。
      await send("\x1b[?2026h\x1b[4;12HWorking\x1b[6n");
      await expect.poll(() => writes.evaluate((values) => values.includes("\x1b[4;19R"))).toBe(true);
      await compose(scenario === "描画途中に開始", preedit + "のにゅうりょく");
      const during = await position();
      await page.screenshot({ path: testInfo.outputPath("during-output.png") });
      await send("\x1b[20;3H\x1b[?2026l");
      await expect.poll(position).toEqual(initial);
      expect(during, "本文更新中もIMEは描画済みの入力欄に留まる").toEqual(initial);
      // 完了した次の描画では実際に入力欄が移動する。位置を固定し続けていないこと。
      await send("\x1b[?2026h\x1b[21;3H\x1b[?2026l");
      await expect.poll(async () => (await position()).top).not.toBe(initial.top);
      await expect(page.locator(".composition-view")).toHaveText(preedit + "のにゅうりょく");
      await helper.evaluate((element) => {
        element.value = "入力確定";
        element.dispatchEvent(new window.CompositionEvent("compositionend", {
          bubbles: true,
          data: "入力確定",
        }));
      });
      await expect.poll(() => writes.evaluate((values) =>
        values.filter((value) => value === "入力確定"),
      )).toEqual(["入力確定"]);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
