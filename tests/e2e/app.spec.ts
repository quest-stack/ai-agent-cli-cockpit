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

    await page.getByRole("combobox", { name: "プロジェクト" }).fill(projectRoot);
    await page.getByLabel("CLI").selectOption("powershell");
    await page.getByLabel("セッション名").fill("P0 PowerShell");
    await page.getByRole("button", { name: /Start Session/u }).click();
    await expect(
      page.getByRole("button", { name: /cli-cockpit P0 PowerShell/u }),
    ).toBeVisible();

    for (const shortcut of [
      "Control+Shift+D",
      "Control+Shift+E",
      "Control+Shift+D",
      "Control+Shift+E",
      "Control+Shift+D",
    ]) {
      await page.keyboard.press(shortcut);
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
          const saved = JSON.parse(raw) as { tabs?: unknown[] };
          return saved.tabs?.length ?? 0;
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator("[data-pane-id]")).toHaveCount(6);
    await expect(
      page.getByRole("button", { name: /cli-cockpit P0 PowerShell/u }),
    ).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataPath, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
});
