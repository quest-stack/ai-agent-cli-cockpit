import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

interface CompositionMeasurement {
  charsPerLine: number;
  computedWidth: string;
  computedRight: string;
  computedWhiteSpace: string;
  helperLeft: string;
  helperTop: string;
  hostRight: number;
  lineCount: number;
  screenBottom: number;
  screenWidth: number;
  viewBottom: number;
  viewInlineWidth: string;
  viewLeft: string;
  viewRight: number;
  viewTop: string;
  viewWidth: number;
}

async function setWindowSize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("CLI Cockpit window was not found");
      }
      window.setSize(size.width, size.height);
    },
    { height, width },
  );
}

async function measureComposition(page: Page): Promise<CompositionMeasurement> {
  return page.evaluate(() => {
    const helper = document.querySelector<HTMLElement>(
      ".xterm-helper-textarea",
    );
    const host = document.querySelector<HTMLElement>(".terminal-host");
    const screen = document.querySelector<HTMLElement>(".xterm-screen");
    const view = document.querySelector<HTMLElement>(".composition-view");
    if (!helper || !host || !screen || !view) {
      throw new Error("xterm composition DOM was not found");
    }

    const style = window.getComputedStyle(view);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const viewBounds = view.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    const lineCount = Math.max(1, Math.round(viewBounds.height / lineHeight));
    return {
      charsPerLine: (view.textContent?.length ?? 0) / lineCount,
      computedRight: style.right,
      computedWhiteSpace: style.whiteSpace,
      computedWidth: style.width,
      helperLeft: helper.style.left,
      helperTop: helper.style.top,
      hostRight: host.getBoundingClientRect().right,
      lineCount,
      screenBottom: screenBounds.bottom,
      screenWidth: screenBounds.width,
      viewBottom: viewBounds.bottom,
      viewInlineWidth: view.style.width,
      viewLeft: view.style.left,
      viewRight: viewBounds.right,
      viewTop: view.style.top,
      viewWidth: viewBounds.width,
    };
  });
}

async function beginComposition(page: Page, text: string): Promise<void> {
  await page.locator(".xterm-helper-textarea").evaluate(
    (element, compositionText) => {
      element.dispatchEvent(
        new window.CompositionEvent("compositionstart", {
          bubbles: true,
          data: "",
        }),
      );
      element.dispatchEvent(
        new window.CompositionEvent("compositionupdate", {
          bubbles: true,
          data: compositionText,
        }),
      );
    },
    text,
  );
}

async function endComposition(page: Page): Promise<void> {
  await page.locator(".xterm-helper-textarea").evaluate((element) => {
    element.dispatchEvent(
      new window.CompositionEvent("compositionend", {
        bubbles: true,
        data: "",
      }),
    );
  });
}

test("Japanese IME preedit wraps inside wide and narrow terminal panes", async ({
}, testInfo) => {
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
    // 初回起動のツアーが操作を遮るので閉じる。
    const tour = page.getByTestId("tour-overlay");
    if (await tour.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "スキップ" }).click();
      await expect(tour).toBeHidden();
    }
    await page.getByRole("combobox", { name: "プロジェクト" }).fill(projectRoot);
    await page.getByLabel("CLI").selectOption("powershell");
    await page.getByLabel("セッション名").fill("IME wrapping");
    await page.getByRole("button", { name: /Start Session/u }).click();
    const helper = page.locator(".xterm-helper-textarea");
    await expect(helper).toBeAttached();

    await setWindowSize(app, 1_280, 700);
    const longPreedit = "あ".repeat(150);
    await beginComposition(page, longPreedit);
    await expect
      .poll(async () => {
        const measurement = await measureComposition(page);
        return (
          measurement.viewInlineWidth.endsWith("px") &&
          measurement.computedWhiteSpace === "pre-wrap" &&
          measurement.lineCount > 1
        );
      })
      .toBe(true);
    const wide = await measureComposition(page);

    expect(wide.computedWidth).not.toBe("auto");
    // right は検査しない。position: absolute で left と width を決めると、
    // right は指定していなくてもブラウザが差分から計算した値を返す
    // （getComputedStyle は解決済みの値を返すため "auto" にはならない）。
    // 右にはみ出していないことは、下の viewRight の比較で見ている。
    expect(wide.viewWidth).toBeCloseTo(Math.floor(wide.screenWidth), 0);
    expect(wide.viewRight).toBeLessThanOrEqual(wide.hostRight + 0.5);
    expect(wide.viewBottom).toBeLessThanOrEqual(wide.screenBottom + 0.5);
    expect(wide.charsPerLine).toBeGreaterThan(1);
    expect(wide.helperLeft).toBe(wide.viewLeft);
    expect(wide.helperTop).toBe(wide.viewTop);

    await setWindowSize(app, 820, 700);
    await expect
      .poll(async () => (await measureComposition(page)).screenWidth)
      .toBeLessThan(wide.screenWidth - 200);
    await expect
      .poll(async () => (await measureComposition(page)).lineCount)
      .toBeGreaterThan(wide.lineCount);
    const narrow = await measureComposition(page);

    expect(narrow.viewWidth).toBeCloseTo(Math.floor(narrow.screenWidth), 0);
    expect(narrow.viewRight).toBeLessThanOrEqual(narrow.hostRight + 0.5);
    expect(narrow.viewBottom).toBeLessThanOrEqual(narrow.screenBottom + 0.5);
    expect(narrow.charsPerLine).toBeGreaterThan(1);

    await endComposition(page);
    await beginComposition(page, "かな");
    await expect
      .poll(async () => {
        const measurement = await measureComposition(page);
        return measurement.viewWidth < measurement.screenWidth / 2;
      })
      .toBe(true);

    await endComposition(page);
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    await helper.type("x".repeat(240));
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll(".xterm-rows > div")).filter(
              (row) => (row.textContent ?? "").includes("xxxx"),
            ).length,
        ),
      )
      .toBeGreaterThan(1);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataPath, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
});
