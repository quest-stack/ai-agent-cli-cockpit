import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { PersistedWorkspace } from "../../src/shared/types";

test.skip(process.env.COCKPIT_ACTUAL_PROVIDERS !== "1" || !process.env.COCKPIT_ACTUAL_LEGACY_EVIDENCE || process.platform !== "win32", "Explicit actual-CLI continuation of owned acceptance conversations.");

test("actual claude -c and Codex resume --last continue their own latest conversation in the selected folder", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const evidence = JSON.parse(await readFile(process.env.COCKPIT_ACTUAL_LEGACY_EVIDENCE!, "utf8")) as {
    passed: boolean; packaged: boolean; cwd: string; executablePath: string; artifactSha256: string;
    cases: { name: string; marker: string; conversationId: string }[];
  };
  expect(evidence).toMatchObject({ passed: true, packaged: true });
  const temp = await realpath(tmpdir()), cwd = await realpath(evidence.cwd);
  expect(cwd.startsWith(temp + sep) && basename(cwd).startsWith("cockpit-owned-conversation-")).toBe(true);
  expect(createHash("sha256").update(await readFile(join(dirname(evidence.executablePath), "resources/app.asar"))).digest("hex")).toBe(evidence.artifactSha256);
  const directory = await mkdtemp(join(cwd, "continue-profile-"));
  const cases = ["claude", "codex"].map(cli => ({
    cli, command: cli === "claude" ? "claude -c" : "codex resume --last",
    id: `qa-continue-${cli}`, tab: `qa-continue-tab-${cli}`, pane: `qa-continue-pane-${cli}`,
    expected: evidence.cases.find(item => item.name === `${cli}-b`)!,
  }));
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
  const workspacePath = join(directory, "session.json");
  await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
  const app = await electron.launch({ executablePath: evidence.executablePath,
    args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
    env: { ...process.env, COCKPIT_USER_DATA: directory },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow }) => {
      const hide = (window: Electron.BrowserWindow): void => {
        window.webContents.setBackgroundThrottling(false); window.setOpacity(0);
        window.setSkipTaskbar(true); window.setPosition(-30000, -30000);
        Object.getPrototypeOf(window).showInactive.call(window);
        window.show = () => {}; window.showInactive = () => {};
      };
      app.on("browser-window-created", (_event, window) => hide(window));
      for (const window of BrowserWindow.getAllWindows()) hide(window);
    });
    const saved = async (): Promise<PersistedWorkspace> => JSON.parse(await readFile(workspacePath, "utf8")) as PersistedWorkspace;
    for (const item of cases) {
      if (item !== cases[0]) await page.getByRole("button", { name: "新規タブ", exact: true }).click();
      const launcher = page.getByTestId("launcher").filter({ visible: true });
      await launcher.getByRole("combobox", { name: "プロジェクト" }).fill(cwd);
      await launcher.getByTestId(`cli-option-${item.cli}`).check(); await launcher.getByTestId("launch-mode-continue").check();
      await launcher.getByLabel("セッション名", { exact: true }).fill(item.cli);
      await launcher.getByRole("button", { name: /Start Session/u }).click();
      await expect.poll(async () => (await saved()).sessions.find(session => session.title === item.cli)?.id).toBeTruthy();
      const current = await saved(); item.id = current.sessions.find(session => session.title === item.cli)!.id;
      const tab = current.tabs.find(tab => tab.root.type === "pane" && tab.root.sessionId === item.id)!;
      item.tab = tab.id; item.pane = tab.activePaneId;
      await page.getByTestId(`tab-${item.tab}`).click();
      const terminal = page.getByTestId(`terminal-${item.id}`);
      const lines = (): Promise<string[]> => terminal.locator(".xterm-rows > div").allTextContents().then(lines => lines.map(line => line.replaceAll("\u00a0", " ")));
      await expect.poll(async () => (await saved()).sessions.find(session => session.id === item.id)?.conversation?.id, { timeout: 45_000 }).toBe(item.expected.conversationId);
      await expect.poll(async () => (await lines()).join("\n"), { timeout: 45_000 }).toContain(item.expected.marker);
      const nonce = `VERIFY_${randomUUID().slice(0, 8)}`;
      const prompt = `What marker did I ask you to remember? Reply with that marker followed by a space and ${nonce}. Do not use tools.`;
      await page.evaluate(({ sessionId, prompt }) => window.cockpit!.writeSession({ sessionId, data: `\x1b[200~${prompt}\x1b[201~` }), { sessionId: item.id, prompt });
      await expect.poll(async () => (await lines()).join("\n")).toContain(nonce);
      await terminal.locator(".xterm-helper-textarea").press("Enter");
      await expect.poll(async () => (await lines()).some(line => line.trim().replace(/^[●•]\s*/u, "") === `${item.expected.marker} ${nonce}`), { timeout: 60_000 }).toBe(true);
      await terminal.screenshot({ path: testInfo.outputPath(`continued-${item.cli}.png`) });
    }
    await writeFile(testInfo.outputPath("continue-acceptance.json"), JSON.stringify({
      passed: true, packaged: true, artifactSha256: evidence.artifactSha256, actualInferenceTurns: 2,
      commands: cases.map(item => item.command), latestOwnedConversationIdsMatched: true,
      previousMarkersRecalled: true, mockProviders: false,
    }, null, 2), "utf8");
  } finally { await app.close(); }
});
