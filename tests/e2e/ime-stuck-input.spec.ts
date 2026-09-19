import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron, type Page } from "playwright";

/**
 * 0.2.2〜0.2.4 で起きていた「日本語入力中に文字が打てなくなる」の回帰検知。
 *
 * 「Enter で改行する」を有効にしていると、変換中の文字キーが軒並み
 * preventDefault され、IME に何も届かなくなっていた。ユニットテストは
 * terminal-behavior.ts 側にしか無く、バグは terminal-registry.ts の写しに
 * あったため素通りした。ここでは実際にアプリを起動し、キーイベントが
 * 握りつぶされていないことを DOM の上で確かめる。
 */

/** Windows の IME が変換中に出すキーイベントを再現する。 */
async function dispatchComposingKey(
  page: Page,
  code: string,
): Promise<boolean> {
  return page.locator(".xterm-helper-textarea").evaluate((element, keyCode) => {
    // 変換中は Enter に限らず、押されたキーがすべて
    // keyCode 229 / key "Process" で通知される。ここが今回の肝。
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: keyCode,
      key: "Process",
      keyCode: 229,
      which: 229,
    });
    element.dispatchEvent(event);
    // preventDefault されたら IME に届かない＝入力できない状態。
    return event.defaultPrevented;
  }, code);
}

async function setEnterInsertsNewline(page: Page): Promise<void> {
  await page.getByRole("button", { name: "設定" }).click();
  const toggle = page.getByLabel(/Enter/u);
  if (!(await toggle.isChecked())) {
    await toggle.check();
  }
  await expect(toggle).toBeChecked();
  await page.keyboard.press("Escape");
}

test("「Enter で改行」有効でも日本語の変換中に文字キーが握りつぶされない", async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath("user-data");
  const projectRoot = resolve(process.cwd());
  const app = await electron.launch({
    args: ["."],
    cwd: projectRoot,
    env: {
      ...process.env,
      COCKPIT_USER_DATA: userDataPath,
    },
  });

  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await page.evaluate(() => {
      window.localStorage.setItem("cockpit.disableWebgl", "1");
    });
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "スキップ" }).click();
      await expect(tour).toBeHidden();
    }

    await page.getByRole("combobox", { name: "プロジェクト" }).fill(projectRoot);
    await page.getByLabel("CLI").selectOption("powershell");
    await page.getByLabel("セッション名").fill("IME stuck");
    await page.getByRole("button", { name: /Start Session/u }).click();
    await expect(page.locator(".xterm-helper-textarea")).toBeAttached();

    // ここを有効にした状態が、不具合の発生条件だった。
    await setEnterInsertsNewline(page);

    // 「あいさつ」と打つ想定。変換中の文字キーが1つでも握りつぶされたら、
    // 利用者から見れば「入力欄に何も出ない」状態になる。
    for (const code of ["KeyA", "KeyI", "KeyS", "KeyA", "KeyT", "Space"]) {
      const prevented = await dispatchComposingKey(page, code);
      expect(
        prevented,
        `${code} が preventDefault された（IME に文字が届かない）`,
      ).toBe(false);
    }

    // 変換中の Enter は従来どおり横取りしてよい（確定であって改行ではない）。
    const enterPrevented = await page.locator(".xterm-helper-textarea").evaluate(
      (element) => {
        const event = new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "Enter",
          key: "Process",
          keyCode: 229,
          which: 229,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      },
    );
    expect(
      enterPrevented,
      "変換中の Enter は端末へ渡さない（確定だけさせる）",
    ).toBe(false);
  } finally {
    await app.close();
  }
});
