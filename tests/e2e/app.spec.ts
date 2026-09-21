import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("PowerShell session, six-pane layout, search and restore work together", async ({
}, testInfo) => {
  const userDataPath = testInfo.outputPath("user-data");
  const projectRoot = resolve(process.cwd());
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: projectRoot,
      env: {
        ...process.env,
        COCKPIT_USER_DATA: userDataPath,
      },
    });

  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await expect(
      page.evaluate(
        () =>
          typeof (window as unknown as { process?: unknown }).process,
      ),
    ).resolves.toBe("undefined");

    // 初回起動のツアーが画面を覆い、Start Session を押せないまま
    // タイムアウトする。他の E2E と同じように閉じてから進める。
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "スキップ" }).click();
      await expect(tour).toBeHidden();
    }

    await page.getByRole("combobox", { name: "プロジェクト" }).fill(projectRoot);
    await page.getByLabel("CLI").selectOption("powershell");
    await page.getByLabel("セッション名").fill("P0 PowerShell");
    await page.getByRole("button", { name: /Start Session/u }).click();
    await expect(
      page.getByTestId(/^session-row-/u).filter({ hasText: "P0 PowerShell" }),
    ).toBeVisible();

    // 1 回ごとにペインが増えたことを確かめてから次を押す。まとめて押すと
    // React の再描画が追いつかず、同じペインに対する分割が重なって取り
    // こぼす（実測で 5 回押しても 1 枚のままになった）。
    const shortcuts = [
      "Control+Shift+D",
      "Control+Shift+E",
      "Control+Shift+D",
      "Control+Shift+E",
      "Control+Shift+D",
    ];
    for (const [index, shortcut] of shortcuts.entries()) {
      await page.keyboard.press(shortcut);
      await expect(page.locator("[data-pane-id]")).toHaveCount(index + 2);
    }
    await expect(page.locator("[data-pane-id]")).toHaveCount(6);

    await page.keyboard.press("Control+Shift+F");
    await expect(page.getByTestId("search-overlay")).toBeVisible();
    await page.getByLabel("検索を閉じる").click();

    await expect
      .poll(async () => {
        try {
          const raw = await readFile(
            join(userDataPath, "session.json"),
            "utf8",
          );
          // タブが保存されただけでは足りない。分割は少し遅れて書かれるため、
          // 枚数まで確かめてから閉じないと、復元の検証が成り立たない。
          const saved = JSON.parse(raw) as {
            tabs?: { root: unknown }[];
          };
          const countPanes = (node: unknown): number => {
            const item = node as {
              children?: [unknown, unknown];
              type?: string;
            };
            return item.type === "pane" || !item.children
              ? 1
              : countPanes(item.children[0]) + countPanes(item.children[1]);
          };
          return Math.max(
            0,
            ...(saved.tabs ?? []).map((tab) => countPanes(tab.root)),
          );
        } catch {
          return 0;
        }
      })
      .toBe(6);
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator("[data-pane-id]")).toHaveCount(6);
    // タブの終了ボタンや各ランチャーの履歴と区別して一覧の行を確認する。
    await expect(
      page.getByTestId(/^session-row-/u).filter({ hasText: "P0 PowerShell" }),
    ).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataPath, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
});
