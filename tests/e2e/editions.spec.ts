import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import { translate } from "../../src/shared/i18n";

import type { Page, TestInfo } from "@playwright/test";
import type { AppLanguage, MessageKey } from "../../src/shared/i18n";
import type { SpawnSessionRequest } from "../../src/shared/types";

async function launchEdition(language: AppLanguage, testInfo: TestInfo, update = false) {
  const userData = testInfo.outputPath("user-data");
  await mkdir(userData, { recursive: true });
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  await writeFile(join(userData, "session.json"), JSON.stringify(workspace), "utf8");
  const entry = join(userData, "hidden-entry.cjs");
  await writeFile(entry, `
    const { app, dialog, net, shell } = require('electron');
    globalThis.editionCalls = { folderTitles: [], opened: [] };
    app.getVersion = () => '0.2.8';
    app.on('browser-window-created', (_event, win) => {
      win.show = () => {};
      win.showInactive = () => {};
    });
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.editionCalls.folderTitles.push(options.title);
      return { canceled: true, filePaths: [] };
    };
    shell.openExternal = async (url) => { globalThis.editionCalls.opened.push(url); };
    net.fetch = async () => new Response(JSON.stringify({
      version: ${JSON.stringify(update ? "99.0.0" : "0.0.0")},
      notes: '日本語の更新案内', downloadPage: 'https://example.com/releases',
      urls: { arm64: 'https://example.com/ja-arm64.exe', x64: 'https://example.com/ja-x64.exe' },
      editions: { en: { notes: 'English update notes', urls: { arm64: 'https://example.com/en-arm64.exe', x64: 'https://example.com/en-x64.exe' } } }
    }), { status: 200 });
    require(${JSON.stringify(resolve(`dist/editions/${language}/electron/main.js`))});
  `, "utf8");
  const app = await electron.launch({
    args: [entry], env: { ...process.env, COCKPIT_LANGUAGE: language, COCKPIT_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByTestId("launcher")).toBeVisible();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cockpit:pty-spawn");
    ipcMain.handle("cockpit:pty-spawn", (_event, request: SpawnSessionRequest) => ({
      session: { ...request, status: "idle", startedAt: Date.now(), shouldRestore: true },
    }));
  });
  return { app, page, errors, ui: (key: MessageKey) => translate(language, key) };
}

async function assertEnglishUi(page: Page, language: AppLanguage): Promise<void> {
  if (language !== "en") return;
  const text = await page.evaluate(() => [
    document.body.innerText,
    ...Array.from(document.querySelectorAll("[aria-label], [title], [placeholder]"), (element) =>
      ["aria-label", "title", "placeholder"].map((name) => element.getAttribute(name) ?? "").join(" ")),
  ].join(" "));
  expect(text).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/u);
}

for (const language of ["ja", "en"] as const) {
  test.describe(`${language} edition`, () => {
    test("launcher, native folder picker, settings, help and tour use the edition language", async ({}, testInfo) => {
      test.setTimeout(60_000);
      const { app, page, ui, errors } = await launchEdition(language, testInfo);
      try {
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.getByRole("heading", { name: ui("作業コンソールを起動") })).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: testInfo.outputPath("launcher.png") });
        await page.getByRole("button", { name: ui("プロジェクトフォルダを参照") }).click();
        expect(await app.evaluate(() => (globalThis as unknown as { editionCalls: { folderTitles: string[] } }).editionCalls.folderTitles))
          .toEqual([ui("フォルダを選択")]);
        await page.getByRole("button", { name: ui("設定"), exact: true }).click();
        await expect(page.getByLabel(ui("Enter で改行する"))).toBeVisible();
        await expect(page.getByText(ui("日本語版"), { exact: false })).toBeVisible();
        await assertEnglishUi(page, language);
        await page.screenshot({ path: testInfo.outputPath("settings.png") });
        await page.getByRole("button", { name: ui("使い方ツアーを見る") }).click();
        const titles: MessageKey[] = ["ようこそ", "セッションを作る", "タブとペインで並べる", "状態をランプで見る", "困ったときは"];
        for (const [index, title] of titles.entries()) {
          await expect(page.getByRole("heading", { name: ui(title), exact: true })).toBeVisible();
          await assertEnglishUi(page, language);
          if (index === 0) await page.screenshot({ path: testInfo.outputPath("tour.png") });
          await page.getByRole("button", { name: ui(index === titles.length - 1 ? "はじめる" : "次へ"), exact: true }).click();
        }
        await page.keyboard.press("F1");
        await expect(page.getByRole("heading", { name: ui("使い方とショートカット") })).toBeVisible();
        await assertEnglishUi(page, language);
        const sample = JSON.parse((await page.locator(".help-code").textContent()) ?? "") as { cwd: string; prompt: string };
        expect(sample.cwd).toBe("C:\\Users\\you\\project");
        expect(sample.prompt).toBe(ui("最初に伝えたいこと"));
        await page.screenshot({ path: testInfo.outputPath("help.png") });
        await page.getByRole("button", { name: ui("閉じる"), exact: true }).click();
        await page.setViewportSize({ width: 760, height: 600 });
        await page.getByRole("button", { name: ui("サイドバーを折りたたむ") }).click();
        await page.screenshot({ path: testInfo.outputPath("launcher-760.png") });
        await page.getByRole("button", { name: ui("設定"), exact: true }).click();
        const settingsBox = await page.locator(".settings-popover").boundingBox();
        expect(settingsBox && settingsBox.y + settingsBox.height).toBeLessThanOrEqual(600);
        await page.getByRole("button", { name: ui("使い方ツアーを見る") }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("settings-760.png") });
        await page.getByRole("button", { name: ui("設定"), exact: true }).click();
        await page.setViewportSize({ width: 390, height: 900 });
        await expect(page.getByTestId("ctrl-c-toggle")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("launcher-390.png") });
        expect(errors).toEqual([]);
      } finally { await app.close(); }
    });

    test("session labels preserve user text and the close dialog stays localized", async ({}, testInfo) => {
      const { app, page, ui, errors } = await launchEdition(language, testInfo);
      try {
        await page.getByRole("combobox", { name: ui("プロジェクト") }).fill("C:/work/project");
        await page.getByLabel("CLI").selectOption("codex");
        await page.getByLabel(ui("セッション名"), { exact: true }).fill("作業名 {value0}");
        await page.getByRole("button", { name: /Start Session/u }).click();
        const row = page.getByTestId(/^session-row-/u);
        await expect(row.locator("strong")).toHaveText("作業名 {value0}");
        await row.getByRole("button", { name: ui("セッションを終了"), exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("heading")).toHaveText(ui("このセッションを終了しますか？"));
        await expect(dialog).toContainText("作業名 {value0}");
        await dialog.getByRole("button", { name: ui("キャンセル"), exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(row).toBeVisible();
        await page.getByRole("button", { name: ui("全ペイン検索"), exact: true }).click();
        await expect(page.getByPlaceholder(ui("全ペインのスクロールバックを検索"))).toBeVisible();
        expect(errors).toEqual([]);
      } finally { await app.close(); }
    });

    test("update notices and downloads retain the edition language", async ({}, testInfo) => {
      const { app, page, ui } = await launchEdition(language, testInfo, true);
      try {
        const banner = page.getByTestId("update-banner");
        await expect(banner).toContainText(language === "en" ? "English update notes" : "日本語の更新案内");
        await banner.getByRole("button", { name: ui("ダウンロード"), exact: true }).click();
        expect(await app.evaluate(() => (globalThis as unknown as { editionCalls: { opened: string[] } }).editionCalls.opened))
          .toEqual([`https://example.com/${language}-${process.arch}.exe`]);
      } finally { await app.close(); }
    });
  });
}
