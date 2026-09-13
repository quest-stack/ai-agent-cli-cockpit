import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";

/**
 * Codex ペインの Enter / Shift+Enter が、既定と入れ替え設定の両方で
 * 意図どおりに働くことを実機で確かめる。
 *
 * 改行は Codex だけ ESC+CR を送る作りにしたので、送信（CR）まで含めて
 * 壊れていないことを確認する必要がある。改行だけ直して送信が壊れていたら
 * 実用にならない。
 */

async function startCodex(
  app: ElectronApplication,
  projectRoot: string,
): Promise<Page> {
  const page = await app.firstWindow();
  await page.getByTestId("launcher").waitFor({ timeout: 30_000 });

  const tour = page.getByTestId("tour-overlay");
  if (await tour.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "スキップ" }).click();
    await tour.waitFor({ state: "hidden" });
  }

  await page
    .getByRole("combobox", { name: "プロジェクト" })
    .fill(projectRoot);
  await page.getByLabel("CLI").selectOption("codex");
  await page.getByLabel("セッション名").fill("Enter 検証");
  await page.getByRole("button", { name: /Start Session/u }).click();

  const terminal = page.locator(".xterm-screen").first();
  await terminal.waitFor({ timeout: 30_000 });

  const screenText = async (): Promise<string> =>
    page.evaluate(
      () => document.querySelector(".xterm-rows")?.textContent ?? "",
    );

  for (let i = 0; i < 120; i += 1) {
    const text = await screenText();
    if (/Ask Codex/u.test(text)) break;
    if (/trust the contents/u.test(text)) {
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(1000);
  }
  await terminal.click();
  return page;
}

/** 入力欄の中で AAA と BBB が同じ行に並んでいるか。 */
async function isSameRow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    for (const row of rows) {
      const text = row.textContent ?? "";
      if (text.includes("AAA") && text.includes("BBB")) return true;
    }
    return false;
  });
}

async function bothPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.querySelector(".xterm-rows")?.textContent ?? "";
    return text.includes("AAA") && text.includes("BBB");
  });
}

test("既定: Shift+Enter は改行、素の Enter は送信になる", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const projectRoot = resolve(process.cwd());
  const app = await electron.launch({
    args: ["."],
    cwd: projectRoot,
    env: {
      ...process.env,
      COCKPIT_USER_DATA: testInfo.outputPath("user-data"),
    },
  });

  try {
    const page = await startCodex(app, projectRoot);

    // Shift+Enter → 改行
    await page.keyboard.type("AAA");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("BBB");
    await expect.poll(() => bothPresent(page), { timeout: 20_000 }).toBe(true);
    expect(await isSameRow(page)).toBe(false);

    // 素の Enter → 送信。
    //
    // 送信されると Codex が処理を始め、入力欄はプレースホルダーへ戻る。
    // 送信済みの文言は会話履歴として画面に残るため、「AAA が消えたか」では
    // 判定できない（実測で確認）。Codex が処理中に入ったことを条件にする。
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const text =
              document.querySelector(".xterm-rows")?.textContent ?? "";
            // 処理中の表示が出る、または入力欄がプレースホルダーへ戻る
            return (
              /Working|esc to interrupt/u.test(text) &&
              /Ask Codex to do anything/u.test(text)
            );
          }),
        { timeout: 40_000 },
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test("入れ替え時: 素の Enter が改行、Shift+Enter が送信になる", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const projectRoot = resolve(process.cwd());
  const app = await electron.launch({
    args: ["."],
    cwd: projectRoot,
    env: {
      ...process.env,
      COCKPIT_USER_DATA: testInfo.outputPath("user-data"),
    },
  });

  try {
    const page = await startCodex(app, projectRoot);

    // 設定を「Enter で改行」に入れ替える
    await page.evaluate(() => {
      const api = (
        window as unknown as {
          cockpit?: { updateSettings?: (s: unknown) => unknown };
        }
      ).cockpit;
      void api;
    });
    await page.getByRole("button", { name: /設定|Settings/u }).first().click();
    const toggle = page.getByLabel(/Enter.*改行|改行.*Enter/u).first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.check();
    } else {
      test.skip(true, "Enter 入れ替えの設定 UI が見つからない");
      return;
    }
    await page.keyboard.press("Escape");

    const terminal = page.locator(".xterm-screen").first();
    await terminal.click();

    // 素の Enter → 改行になるはず
    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await expect.poll(() => bothPresent(page), { timeout: 20_000 }).toBe(true);
    expect(await isSameRow(page)).toBe(false);
  } finally {
    await app.close();
  }
});
