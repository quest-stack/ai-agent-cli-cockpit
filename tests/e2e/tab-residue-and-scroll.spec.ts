import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

/**
 * タブまわりの 2 つの不具合の回帰検知。
 *
 * 1. 左の一覧からセッションを閉じると「New Session」の空タブが残骸として
 *    積み上がる（分割の構造は壊さず、空になったタブだけ閉じたい）。
 * 2. タブが 5 枚ほどになると、選択中のタブがタブ帯の外に出てしまい、
 *    「アクティブなのに見えない・× を押せない」状態になる。
 */

async function startSession(
  page: Page,
  projectRoot: string,
  name: string,
): Promise<void> {
  // タブが増えると隠れた tabpanel にも同じ入力欄が残るため、
  // 今見えているランチャーに限定して操作する。
  const launcher = page.getByTestId("launcher").filter({ visible: true });
  await launcher
    .getByRole("combobox", { name: "プロジェクト" })
    .fill(projectRoot);
  await launcher.getByLabel("CLI").selectOption("powershell");
  await launcher.getByLabel("セッション名").fill(name);
  await launcher.getByRole("button", { name: /Start Session/u }).click();
}

async function launch(userDataPath: string): Promise<{
  app: ElectronApplication;
  page: Page;
  projectRoot: string;
}> {
  const projectRoot = resolve(process.cwd());
  const app = await electron.launch({
    args: ["."],
    cwd: projectRoot,
    env: { ...process.env, COCKPIT_USER_DATA: userDataPath },
  });
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
  return { app, page, projectRoot };
}

test("左の一覧から閉じても空タブの残骸が積み上がらない", async ({}, testInfo) => {
  const { app, page, projectRoot } = await launch(
    testInfo.outputPath("user-data"),
  );

  try {
    await startSession(page, projectRoot, "残骸テスト");
    const tabs = page.locator(".tab-item");
    await expect(tabs).toHaveCount(1);

    // サイドバーの × で閉じる。
    const row = page.locator(".session-row", { hasText: "残骸テスト" });
    await row.hover();
    await row
      .getByRole("button", { name: /セッションを終了|一覧から除去/u })
      .click();

    // 確認ダイアログが出たら承認する。
    const confirm = page.getByRole("button", { name: "終了する" });
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }

    // 空のタブが 2 枚 3 枚と積み上がらないこと。まっさらな 1 枚だけが残る。
    await expect(tabs).toHaveCount(1);
    await expect(page.getByTestId("launcher")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("タブが増えても選択中のタブはタブ帯の中に見えている", async ({}, testInfo) => {
  const { app, page, projectRoot } = await launch(
    testInfo.outputPath("user-data"),
  );

  try {
    // 実機と同じく、タブ帯に収まりきらない状況を作る。
    // 画面が広いままだと 5 枚でもはみ出さず、検証にならない。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(760, 700);
    });

    await startSession(page, projectRoot, "セッション1");
    for (let index = 2; index <= 5; index += 1) {
      await page.getByRole("button", { name: "新規タブ" }).click();
      await startSession(page, projectRoot, `セッション${index}`);
    }
    await expect(page.locator(".tab-item")).toHaveCount(5);

    // 前提: この幅ではタブ帯からあふれている（あふれていないと検証にならない）。
    const overflowing = await page.evaluate(() => {
      const strip = document.querySelector(".tab-strip");
      if (!strip) throw new Error("タブ帯が無い");
      return strip.scrollWidth > strip.clientWidth + 1;
    });
    expect(overflowing, "テスト条件が成立していない（あふれていない）").toBe(true);

    // スクロールの追随は requestAnimationFrame 経由なので、位置が落ち着く
    // まで待つ。待たずに測ると、修正の有無に関わらず途中の値を拾う。
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const strip = document.querySelector(".tab-strip");
          const active = document.querySelector(".tab-item.is-active");
          if (!strip || !active) return false;
          return (
            active.getBoundingClientRect().right <=
            strip.getBoundingClientRect().right + 1
          );
        }),
      )
      .toBe(true);

    // 最後に開いたタブ（＝選択中）が、タブ帯の見える範囲に収まっていること。
    const visible = await page.evaluate(() => {
      const strip = document.querySelector(".tab-strip");
      const active = document.querySelector(".tab-item.is-active");
      if (!strip || !active) {
        throw new Error("タブ帯が見つからない");
      }
      const s = strip.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      return {
        activeLeft: a.left,
        activeRight: a.right,
        stripLeft: s.left,
        stripRight: s.right,
      };
    });

    expect(
      visible.activeRight,
      "選択中のタブが右にはみ出している（× を押せない）",
    ).toBeLessThanOrEqual(visible.stripRight + 1);
    expect(
      visible.activeLeft,
      "選択中のタブが左にはみ出している",
    ).toBeGreaterThanOrEqual(visible.stripLeft - 1);

    // × が実際に押せる位置にあること。
    await expect(
      page.locator(".tab-item.is-active .tab-close"),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
