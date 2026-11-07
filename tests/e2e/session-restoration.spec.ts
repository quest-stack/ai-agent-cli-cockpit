import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

test.skip(process.platform !== "win32", "Uses Windows launch commands through a real ConPTY, with owned CLI recorders.");
const conversationId = "11111111-1111-4111-8111-111111111111";
for (const cli of ["codex", "claude"] as const) for (const restart of [false, true]) for (const hasId of [false, true]) {
  test(`${cli} ${restart ? "restart" : "startup"} ${hasId ? "keeps the exact conversation" : "uses history when the saved identity is null"}`, async ({}, testInfo) => {
    const directory = testInfo.outputPath("profile"), home = testInfo.outputPath("home"), bin = testInfo.outputPath("bin"), project = testInfo.outputPath("project");
    for (const folder of [directory, home, bin, project]) await mkdir(folder, { recursive: true });
    const result = testInfo.outputPath("launch.json"), recorder = join(bin, "record.cjs");
    await writeFile(recorder, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(process.argv.slice(2)));console.log('OWNED_RESTORE_STARTED');`, "utf8");
    await writeFile(join(bin, `${cli}.cmd`), `@"${process.execPath}" "${recorder}" %*\r\n`, "utf8");
    const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false;
    workspace.sessions = [{ id: "restore-probe", command: cli, conversation: hasId ? { cli, id: conversationId } : null, cwd: project, projectName: "Restore QA", title: "Restore QA", shouldRestore: !restart }];
    workspace.tabs = [{ id: "restore-tab", activePaneId: "restore-pane", title: "Restore QA", root: { id: "restore-pane", sessionId: "restore-probe", type: "pane" } }]; workspace.activeTabId = "restore-tab";
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const entry = testInfo.outputPath("entry.cjs"), executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE;
    await writeFile(entry, `const {app}=require('electron');app.on('browser-window-created',(_,w)=>{w.show=()=>{};w.showInactive=()=>{}});${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}`, "utf8");
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key.toLowerCase() !== "path") environment[key] = value;
    Object.assign(environment, { PATH: `${bin};${process.env.PATH ?? process.env.Path ?? ""}`, USERPROFILE: home, COCKPIT_USER_DATA: directory });
    const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? ["-r", entry] : [entry], env: environment });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) {
        window.setOpacity(0); window.setSkipTaskbar(true); window.setPosition(-30000, -30000); Object.getPrototypeOf(window).showInactive.call(window);
        window.webContents.setBackgroundThrottling(false); window.show = () => {}; window.showInactive = () => {};
      } });
      if (restart) await page.getByRole("button", { name: "同じ設定で再起動", exact: true }).click();
      await expect.poll(async () => { try { return JSON.parse(await readFile(result, "utf8")) as string[]; } catch { return []; } }, { timeout: 20_000 })
        .toEqual(expect.arrayContaining([cli === "codex" ? "resume" : "--resume", ...(hasId ? [conversationId] : [])]));
      const args = JSON.parse(await readFile(result, "utf8")) as string[];
      expect(args[0]).toBe(cli === "codex" ? "resume" : "--resume");
      if (!hasId) expect(args).not.toContain(conversationId);
    } finally { await app.close(); }
  });
}
