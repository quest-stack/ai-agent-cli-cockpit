import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import type { Page } from "@playwright/test";

async function verifyPowerShellResponse(page: Page): Promise<string> {
  const row = page.getByTestId(/^session-row-/u).filter({ hasText: "P0 PowerShell" });
  const testId = await row.getAttribute("data-testid");
  if (!testId) throw new Error("PowerShell session ID is missing.");
  const sessionId = testId.slice("session-row-".length);
  await page.evaluate((id) => new Promise<void>((resolveResponse) => {
    const api = window.cockpit;
    if (!api) throw new Error("Electron preload API is missing.");
    let output = "";
    const unsubscribe = api.onPtyData((event) => {
      if (event.sessionId !== id) return;
      output = (output + event.data).slice(-8_000);
      if (output.includes("COCKPIT_E2E_READY")) {
        unsubscribe();
        resolveResponse();
      }
    });
    // Split the marker in the command so echoed input cannot satisfy the check.
    api.writeSession({ sessionId: id, data: "[Console]::WriteLine(('COCKPIT_E2E_' + 'READY'))\r" });
  }), sessionId);
  return sessionId;
}

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

  console.info("[PowerShell E2E] Launching application");
  let app = await launch();
  console.info("[PowerShell E2E] Application launched; waiting for first window");
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    console.info("[PowerShell E2E] Launcher visible");
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
    console.info("[PowerShell E2E] PowerShell session created");
    await verifyPowerShellResponse(page);
    console.info("[PowerShell E2E] PowerShell command produced its response");

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
    console.info("[PowerShell E2E] Six panes created");

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
    console.info("[PowerShell E2E] Six panes saved; closing application");
    await app.close();

    console.info("[PowerShell E2E] Application closed; relaunching");
    app = await launch();
    console.info("[PowerShell E2E] Application relaunched");
    page = await app.firstWindow();
    await expect(page.locator("[data-pane-id]")).toHaveCount(6);
    // タブの終了ボタンや各ランチャーの履歴と区別して一覧の行を確認する。
    await expect(
      page.getByTestId(/^session-row-/u).filter({ hasText: "P0 PowerShell" }),
    ).toBeVisible();
    console.info("[PowerShell E2E] Session and six panes restored");
    const restoredSessionId = await verifyPowerShellResponse(page);
    console.info("[PowerShell E2E] Restored PowerShell produced its response");
    // The restored row/layout appear before the asynchronous PTY starts. Verify
    // the real shell, then let it exit before closing the test application;
    // quitting immediately after rendering can strand ConPTY cleanup on CI.
    const exitCode = await page.evaluate((id) => new Promise<number | undefined>((resolveExit) => {
      const api = window.cockpit;
      if (!api) throw new Error("Electron preload API is missing.");
      const unsubscribe = api.onPtyStatus((event) => {
        if (event.sessionId !== id || !["exited", "error"].includes(event.status)) return;
        unsubscribe();
        resolveExit(event.exitCode);
      });
      api.writeSession({ sessionId: id, data: "exit 0\r" });
    }), restoredSessionId);
    expect(exitCode).toBe(0);
    console.info("[PowerShell E2E] Restored PowerShell exited cleanly");
  } finally {
    console.info("[PowerShell E2E] Closing application during cleanup");
    await app.close().catch(() => undefined);
    console.info("[PowerShell E2E] Application cleanup complete");
    await rm(userDataPath, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
});
