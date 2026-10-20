import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

const url = process.env.COCKPIT_PREVIEW_URL;
test.skip(!url, "Browser-only UI trial: start scripts/preview-prototype.mjs and set COCKPIT_PREVIEW_URL.");
test.use({ viewport: { width: 1440, height: 900 } });

const names = ["sample.studio", "guide.md", "cover.svg", "overview.pdf", "walkthrough.mp4"];
const activeWork = (page: Page) => page.locator("[data-active-tab-panel]");
const targets = (page: Page) => activeWork(page).getByRole("tablist", { name: "プレビュー対象", exact: true });
const toggle = (page: Page) => activeWork(page).getByTestId("preview-toggle");

async function add(page: Page, name: string): Promise<void> {
  await activeWork(page).getByRole("button", { name: "プレビュー対象を追加", exact: true }).click();
  await activeWork(page).getByRole("dialog", { name: "サンプルを選ぶ" }).getByRole("button", { name: new RegExp(name.replaceAll(".", "\\."), "u") }).click();
  await expect(targets(page).getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto(url!);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("closed by default; opening and closing preserves CLI instances and typed output", async ({ page }) => {
  const instances = await page.evaluateHandle(() => [...document.querySelectorAll(".xterm")]);
  const terminal = page.getByTestId("terminal-session-web");
  await terminal.locator("textarea").focus();
  await page.keyboard.type("draft-keep-this");
  await page.getByRole("button", { name: "全ペイン検索", exact: true }).click();
  // Query the terminal's scrollback through the UI; canvas renderers have no .xterm-rows.
  await expect.poll(async () => {
    const search = page.getByRole("textbox", { name: "全ペインを検索", exact: true });
    await search.fill("");
    await search.fill("draft-keep-this");
    return page.locator(".search-count").textContent();
  }).toBe("1 panes");
  await page.getByRole("button", { name: "検索を閉じる", exact: true }).click();
  await toggle(page).click();
  await expect(activeWork(page).getByRole("heading", { name: "作ったものを、ここで見る。" })).toBeVisible();
  await activeWork(page).getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "全ペイン検索", exact: true }).click();
  await page.getByRole("textbox", { name: "全ペインを検索", exact: true }).fill("draft-keep-this");
  await expect(page.locator(".search-count")).toHaveText("1 panes");
  expect(await instances.evaluate((nodes) => nodes.length === 2 && nodes.every((node) => node.isConnected))).toBe(true);
});

test("five target types, duplicate selection, keyboard navigation and removal", async ({ page }) => {
  await toggle(page).click();
  for (const name of names) await add(page, name);
  await add(page, "guide.md");
  await expect(targets(page).getByRole("tab")).toHaveCount(5);
  await targets(page).getByRole("tab", { name: "guide.md", exact: true }).press("End");
  await expect(targets(page).getByRole("tab", { name: "walkthrough.mp4", exact: true })).toBeFocused();
  await targets(page).getByRole("tab", { name: "walkthrough.mp4", exact: true }).press("ArrowRight");
  await expect(targets(page).getByRole("tab", { name: "sample.studio", exact: true })).toBeFocused();
  await activeWork(page).getByRole("button", { name: "sample.studioを閉じる", exact: true }).click();
  await expect(targets(page).getByRole("tab", { name: "guide.md", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("per-work-tab visibility, target and width survive switching and reload", async ({ page }) => {
  await toggle(page).click();
  await add(page, "guide.md");
  const resize = page.getByRole("separator", { name: "プレビューの幅を変更" });
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", "30");
  await page.getByRole("button", { name: "新規タブ", exact: true }).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("tab-tab-demo").click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(targets(page).getByRole("tab", { name: "guide.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem("cockpit.previewTrial.workspace") ?? "{}").tabs?.length)).toBe(2);
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("separator", { name: "プレビューの幅を変更" })).toHaveAttribute("aria-valuenow", "30");
  await activeWork(page).getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await toggle(page).click();
  await expect(targets(page).getByRole("tab", { name: "guide.md", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("expand and return retain terminals and the original preview width", async ({ page }) => {
  await toggle(page).click();
  await add(page, "sample.studio");
  const instances = await page.evaluateHandle(() => [...document.querySelectorAll(".xterm")]);
  const width = (await page.getByRole("region", { name: "プレビュー", exact: true }).boundingBox())!.width;
  await page.getByRole("button", { name: "プレビューを拡大", exact: true }).click();
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "並べて表示に戻す", exact: true }).click();
  expect((await page.getByRole("region", { name: "プレビュー", exact: true }).boundingBox())!.width).toBeCloseTo(width, 0);
  expect(await instances.evaluate((nodes) => nodes.every((node) => node.isConnected))).toBe(true);
  await expect(page.locator(".terminal-pane:visible")).toHaveCount(2);
});

test("sample saves never steal the selected target; PDF changes wait for explicit apply", async ({ page }) => {
  await toggle(page).click();
  await add(page, "sample.studio");
  await add(page, "overview.pdf");
  const pdf = activeWork(page).locator("iframe");
  await expect(pdf).toHaveAttribute("src", /version=1/u);
  await page.getByRole("button", { name: "更新を試す", exact: true }).click();
  await expect(targets(page).getByRole("tab", { name: /overview.pdf/u })).toHaveAttribute("aria-selected", "true");
  await expect(pdf).toHaveAttribute("src", /version=1/u);
  await page.getByRole("button", { name: "新しい版を表示", exact: true }).click();
  await expect(pdf).toHaveAttribute("src", /version=2/u);
  await targets(page).getByRole("tab", { name: "sample.studio", exact: true }).click();
  await expect(activeWork(page).locator(".preview-location")).toContainText("v2");
});

test("real MP4 playback pauses on target, work-tab and preview visibility changes", async ({ page }) => {
  await toggle(page).click();
  await add(page, "guide.md");
  await add(page, "walkthrough.mp4");
  const video = page.getByTestId("preview-video");
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((node: globalThis.HTMLVideoElement) => node.play());
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0);
  await targets(page).getByRole("tab", { name: "guide.md", exact: true }).click();
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
  await targets(page).getByRole("tab", { name: "walkthrough.mp4", exact: true }).click();
  expect(await video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
  await video.evaluate((node: globalThis.HTMLVideoElement) => node.play());
  await page.getByRole("button", { name: "新規タブ", exact: true }).click();
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
  await page.getByTestId("tab-tab-demo").click();
  await video.evaluate((node: globalThis.HTMLVideoElement) => node.play());
  await activeWork(page).getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
});

test("new MP4 versions apply paused at the retained playback position", async ({ page }) => {
  await toggle(page).click();
  await add(page, "walkthrough.mp4");
  const video = page.getByTestId("preview-video");
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((node: globalThis.HTMLVideoElement) => { node.currentTime = 4; });
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.seeking)).toBe(false);
  await page.getByRole("button", { name: "更新を試す", exact: true }).click();
  await expect(video).toHaveAttribute("src", /version=1/u);
  await page.getByRole("button", { name: "新しい版を表示", exact: true }).click();
  await expect(video).toHaveAttribute("src", /version=2/u);
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => Math.round(node.currentTime))).toBe(4);
  expect(await video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
});

test("390px view uses AI/Preview switching without page overflow and pauses hidden video", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle(page).click();
  await add(page, "walkthrough.mp4");
  const video = page.getByTestId("preview-video");
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((node: globalThis.HTMLVideoElement) => node.play());
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect.poll(() => video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
  await expect(page.getByTestId("terminal-session-web")).toBeVisible();
  await activeWork(page).locator(".preview-view-switch").getByRole("button", { name: "プレビュー", exact: true }).click();
  await expect(video).toBeVisible();
  expect((await page.getByRole("region", { name: "プレビュー", exact: true }).boundingBox())!.width).toBeGreaterThan(300);
  expect(await video.evaluate((node: globalThis.HTMLVideoElement) => node.paused)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("preview-390.png") });
});

test("normal browser entry never enables the trial", async ({ page }) => {
  await page.goto(new URL("/", url!).href);
  await expect(page.locator(".loading-screen")).toHaveCount(0);
  await expect(page.getByTestId("preview-toggle")).toHaveCount(0);
});

test("desktop interaction samples render with no runtime or network errors", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await toggle(page).click();
  for (const name of names) await add(page, name);
  await targets(page).getByRole("tab", { name: "sample.studio", exact: true }).click();
  await page.getByRole("button", { name: "サービスを見る", exact: true }).click();
  await expect(page.getByRole("heading", { name: "次の仕事を、一緒に。" })).toBeVisible();
  await page.getByRole("button", { name: "トップへ戻る", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("preview-1440.png") });
  expect(errors).toEqual([]);
});
