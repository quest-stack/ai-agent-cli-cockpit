import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { isCliInitialPromptReady } from "../../src/renderer/terminal-behavior";

/**
 * Codex ペインで Shift+Enter が改行になることを実機で確かめる。
 *
 * Codex は CSI-u (ESC [ 13 ; 2 u) では改行にならない。xterm.js 6.0.0 が
 * kitty keyboard protocol を実装しておらず、Codex 側も有効化要求を送って
 * こないため、この組み合わせでは CSI-u 経路が成立しないことを実測で確認した。
 * 改行になるのは ESC+CR（Alt+Enter として解釈される）だけ。
 *
 * 本番の設定・セッションに触れないよう COCKPIT_USER_DATA を隔離する。
 */
test("Codex ペインの Shift+Enter で入力欄が改行される", async ({}, testInfo) => {
  test.setTimeout(180_000);

  const userDataPath = testInfo.outputPath("user-data");
  const appRoot = resolve(process.cwd());
  const projectRoot = testInfo.outputPath("project");
  await mkdir(projectRoot, { recursive: true });

  const app = await electron.launch({
    args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? [] : ["."],
    ...(process.env.COCKPIT_PACKAGED_EXECUTABLE
      ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE } : {}),
    cwd: appRoot,
    env: {
      ...process.env,
      COCKPIT_USER_DATA: userDataPath,
    },
  });

  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    // This test reads DOM rows. Keep its renderer stable for the whole CLI run.
    await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));

    // 初回起動のツアーが操作を遮るので閉じる。
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "スキップ" }).click();
      await expect(tour).toBeHidden();
    }

    // Codex セッションを起動する。
    await page
      .getByRole("combobox", { name: "プロジェクト" })
      .fill(projectRoot);
    await page.getByTestId(`cli-option-${"codex"}`).check();
    await page.getByLabel("セッション名").fill("改行検証");
    await page.getByRole("button", { name: /Start Session/u }).click();

    // Codex の入力欄が出るまで待つ。信頼ダイアログが挟まることがある。
    const terminal = page.locator(".xterm-screen").first();
    await expect(terminal).toBeVisible({ timeout: 30_000 });
    const helper = page.locator(".xterm-helper-textarea").first();
    await helper.focus();

    const readScreen = async (): Promise<string> =>
      page.evaluate(() => {
        const rows = document.querySelector(".xterm-rows");
        return rows?.textContent ?? "";
      });

    // A composer placeholder may paint before the startup trust screen.
    // Handle prompts as they arrive and wait for the actual idle composer.
    const trustPrompt = /trust (?:the contents|this folder)/iu;
    let skippedUpdate = false, trusted = false;
    await expect.poll(async () => {
      const text = await readScreen();
      if (/Update available/iu.test(text) && !skippedUpdate) {
        skippedUpdate = true; await helper.press("Escape"); return false;
      }
      if (trustPrompt.test(text) && !trusted) {
        trusted = true; await helper.press("Enter"); return false;
      }
      return isCliInitialPromptReady("codex", await page.locator(".xterm-rows > div").allTextContents());
    }, { timeout: 90_000 }).toBe(true);

    await terminal.click();
    await page.locator(".xterm-helper-textarea").first().focus();

    // 目印 → Shift+Enter → 目印。改行されていれば別の行に分かれる。
    await page.keyboard.type("AAA");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("BBB");

    // 行ごとの文字列を取り、AAA と BBB が同じ行に無いことを確かめる。
    const sameRow = async (): Promise<boolean> =>
      page.evaluate(() => {
        const rows = document.querySelectorAll(".xterm-rows > div");
        for (const row of rows) {
          const text = row.textContent ?? "";
          if (text.includes("AAA") && text.includes("BBB")) {
            return true;
          }
        }
        return false;
      });

    const bothPresent = async (): Promise<boolean> =>
      page.evaluate(() => {
        const text = document.querySelector(".xterm-rows")?.textContent ?? "";
        return text.includes("AAA") && text.includes("BBB");
      });

    await expect.poll(bothPresent, { timeout: 20_000 }).toBe(true);
    // 同じ行に並んでいたら改行されていない＝不具合の再現。
    expect(await sameRow()).toBe(false);
  } finally {
    const page = await app.firstWindow();
    await writeFile(testInfo.outputPath("terminal-screen.txt"), await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "No DOM rows"), "utf8");
    await app.close();
  }
});
