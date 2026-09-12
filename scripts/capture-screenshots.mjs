/**
 * README 用のスクリーンショットを撮る。
 *
 * 手作業で撮ると、そのときの画面に写っていたものがそのまま公開される。
 * 実際、最初の overview.png には会社名と契約プラン名が写ったまま公開
 * 手前まで進んだ。撮り直しが何度も要るので、再現できる形にしてある。
 *
 * 撮影は隔離した userData で行う。利用者本人の設定・履歴・案件名は
 * 一切読み込まないため、実在の顧客名が写り込む経路がない。
 *
 * 使い方:
 *   node scripts/capture-screenshots.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "docs", "images");

/**
 * 撮影用の作業場所。利用者の環境と混ざらないよう毎回作り直す。
 *
 * 設定画面は受付フォルダの絶対パスを表示するので、置いた場所がそのまま
 * 画像に写る。リポジトリ配下も OS の一時領域も、途中に利用者名や作業
 * フォルダ名が入るため使えない（実際どちらでも写り込んだ）。誰の環境でも
 * 同じ見た目になるよう、ドライブ直下に固定する。
 */
const stageDirectory = join(parse(process.cwd()).root, "cli-cockpit-demo");
const userDataDirectory = join(stageDirectory, "user-data");
const projectsDirectory = join(stageDirectory, "projects");
/**
 * CLI 用の設定ディレクトリ。
 *
 * 利用者本人の設定を読むと「MCP サーバーの認証が必要」といった環境の
 * 内情が画面に出る。空の設定を向けて、素の状態で起動させる。
 */
const cliConfigDirectory = join(stageDirectory, "cli-config");

/**
 * 画面に出す架空のプロジェクト。
 *
 * 実在の顧客名・案件名は使わない。ここに書いた名前がそのまま公開される。
 */
const DEMO_PROJECTS = [
  {
    name: "sample-web",
    // 起動時の挨拶や環境の警告を画面外へ押し出すだけの分量が要る。
    // 短い返答だと上に残り、そのまま公開されてしまう。
    prompt:
      "架空のフロントエンド改修のタスク一覧を、番号付きで25行、説明なしで出力して",
    title: "画面調整",
  },
  {
    name: "sample-api",
    prompt:
      "架空の REST API のエンドポイント一覧を、1行に1つずつ25行、説明なしで出力して",
    title: "API 修正",
  },
  {
    name: "sample-docs",
    prompt:
      "架空の技術ドキュメントの見出し一覧を、1行に1つずつ25行、説明なしで出力して",
    title: "資料整理",
  },
];

const VIEWPORT = { height: 800, width: 1280 };

function stage() {
  rmSync(stageDirectory, { force: true, recursive: true });
  for (const project of DEMO_PROJECTS) {
    const directory = join(projectsDirectory, project.name);
    mkdirSync(directory, { recursive: true });
    // 空の MCP 設定を置く。これが無いと利用者の設定を拾い、
    // 「N 個のサーバーが認証待ち」という環境の内情が画面に出る。
    writeFileSync(join(directory, ".mcp.json"), '{"mcpServers":{}}', "utf8");
  }
  mkdirSync(userDataDirectory, { recursive: true });
  mkdirSync(cliConfigDirectory, { recursive: true });

  // ツアーは既読にしておく。撮影のたびに前面を覆われる。
  writeFileSync(
    join(userDataDirectory, "session.json"),
    JSON.stringify({
      activeTabId: "tab-1",
      recent: [],
      savedPresets: [],
      sessions: [],
      settings: {
        alwaysConfirmClose: false,
        defaultCommand: "claude",
        notificationsEnabled: true,
        pinned: [],
        remoteLaunchEnabled: true,
        scanRoots: [projectsDirectory],
        sidebarWidth: 232,
        tourCompleted: true,
      },
      tabs: [
        {
          activePaneId: "pane-1",
          id: "tab-1",
          root: { id: "pane-1", sessionId: null, type: "pane" },
          title: "New Session",
        },
      ],
      version: 1,
    }),
    "utf8",
  );
}

/**
 * 複数ペインが動いている全体像を撮る。
 *
 * 本物の claude は起動時に契約プラン名や利用者への挨拶を表示するため、
 * ここでは使えない（最初の overview.png はそれで会社名が写った）。
 * 画面に出る文字をこちらで決められる PowerShell を使う。
 */
async function captureOverview(page) {
  for (const [index, project] of DEMO_PROJECTS.entries()) {
    if (index > 0) {
      // 1 枚に収めるため、2 つ目以降は分割して並べる。
      await page.keyboard.press(index === 1 ? "Control+Shift+D" : "Control+Shift+E");
    }
    await page
      .getByRole("combobox", { name: "プロジェクト" })
      .fill(join(projectsDirectory, project.name));
    await page.getByLabel("CLI").selectOption("claude");
    await page.getByLabel("セッション名").fill(project.title);
    await page.getByRole("button", { name: /Start Session/u }).click();
    await page.waitForTimeout(1_200);
  }

  // 初回は信頼確認で止まる。承認しないと会話が始まらない。
  await page.waitForTimeout(6_000);
  const panes = page.locator("[data-pane-id]");
  for (let index = 0; index < DEMO_PROJECTS.length; index += 1) {
    await panes.nth(index).click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_500);
  }

  // 挨拶とプラン名を画面外へ流す。短い返答では足りないので、
  // 十分な行数が返る依頼を投げる。
  for (let index = 0; index < DEMO_PROJECTS.length; index += 1) {
    await panes.nth(index).click();
    await page.keyboard.type(DEMO_PROJECTS[index].prompt);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_000);
  }
  await page.waitForTimeout(25_000);

  for (let index = 0; index < DEMO_PROJECTS.length; index += 1) {
    console.log(`--- pane ${index} ---
${(await panes.nth(index).innerText()).slice(0, 600)}`);
  }

  await page.screenshot({ path: join(outputDirectory, "overview.png") });
}

async function main() {
  stage();
  execFileSync("npm", ["run", "build"], { cwd: root, shell: true, stdio: "inherit" });

  const app = await electron.launch({
    args: ["."],
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cliConfigDirectory,
      COCKPIT_USER_DATA: userDataDirectory,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize(VIEWPORT);
    await page.getByTestId("launcher").waitFor();

    mkdirSync(outputDirectory, { recursive: true });

    await captureOverview(page);

    // ヘルプは単独で撮れる。CLI を起動しなくても中身が変わらない。
    await page.getByRole("button", { name: "使い方とショートカット" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outputDirectory, "help.png") });
    await page.keyboard.press("Escape");

    // 設定は受付フォルダの案内を見せる。パスは撮影用の場所が写る。
    await page.getByRole("button", { name: "設定" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outputDirectory, "settings.png") });
    await page.keyboard.press("Escape");

    console.log(`撮影しました: ${outputDirectory}`);
  } finally {
    await app.close();
  }
}

await main();
