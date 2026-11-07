import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

test.skip(process.platform !== "win32", "Verifies Windows PowerShell and ConPTY inheritance.");

for (const [mode, option] of [["resume", "--resume"], ["continue", "--continue"]] as const) {
  test(`Claude ${mode} uses the selected config/history directory through the real PTY`, async ({}, testInfo) => {
    const directory = testInfo.outputPath("data"), config = join(directory, "custom config"), bin = join(directory, "bin");
    for (const folder of [directory, config, bin]) await mkdir(folder, { recursive: true });
    await writeFile(join(config, "history-fixture.json"), JSON.stringify({ marker: "OWNED_CONFIG_HISTORY" }), "utf8");
    const workspace = createDefaultWorkspace(); workspace.settings.tourCompleted = true; workspace.settings.notificationsEnabled = false; workspace.settings.scanRoots = [];
    await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
    const result = join(directory, "result.json"), stub = join(bin, "claude-fixture.cjs");
    await writeFile(stub, `const fs=require('node:fs'),path=require('node:path');const dir=process.env.CLAUDE_CONFIG_DIR;
      let history;try{history=JSON.parse(fs.readFileSync(path.join(dir,'history-fixture.json'),'utf8')).marker}catch{}
      fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({args:process.argv.slice(2),directory:dir,history,
        parentSessionDefined:!!process.env.CLAUDE_CODE_SESSION_ID,parentCredentialDefined:!!process.env.ANTHROPIC_API_KEY}));
      console.log('CONFIG_FIXTURE_DONE');`, "utf8");
    await writeFile(join(bin, "claude.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`, "utf8");
    const entry = join(directory, "hidden-entry.cjs"), executablePath = process.env.COCKPIT_PACKAGED_EXECUTABLE;
    await writeFile(entry, `const {app,net}=require('electron');app.on('browser-window-created',(_e,w)=>{w.show=()=>{};w.showInactive=()=>{}});net.fetch=async()=>new Response('{}');
      ${executablePath ? "" : `require(${JSON.stringify(resolve("dist/electron/main.js"))});`}`, "utf8");
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key.toLowerCase() !== "path") environment[key] = value;
    Object.assign(environment, { PATH: `${bin};${process.env.PATH ?? process.env.Path ?? ""}`, COCKPIT_USER_DATA: directory,
      CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "owned-parent-session", ANTHROPIC_API_KEY: "owned-non-secret-parent-fixture" });
    const app = await electron.launch({ args: executablePath ? ["-r", entry] : [entry], ...(executablePath ? { executablePath } : {}), env: environment });
    try {
      await app.evaluate(({ app, BrowserWindow }) => {
        const hide = (window: Electron.BrowserWindow): void => { window.show = () => {}; window.showInactive = () => {}; window.hide(); };
        app.on("browser-window-created", (_event, window) => hide(window));
        for (const window of BrowserWindow.getAllWindows()) hide(window);
      });
      const page = await app.firstWindow();
      await expect(page.getByTestId("launcher")).toBeVisible();
      await page.getByRole("combobox", { name: "プロジェクト" }).fill(directory);
      await page.getByTestId("cli-option-claude").check();
      await page.getByTestId(`launch-mode-${mode}`).check();
      await page.getByRole("button", { name: /Start Session/u }).click();
      await expect.poll(async () => { try { return JSON.parse(await readFile(result, "utf8")) as unknown; } catch { return undefined; } }, { timeout: 20_000 })
        .toMatchObject({ directory: config, history: "OWNED_CONFIG_HISTORY", parentSessionDefined: false, parentCredentialDefined: false });
      const recorded = JSON.parse(await readFile(result, "utf8")) as { args: string[] };
      expect(recorded.args[0]).toBe(option);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
    } finally { await app.close(); }
  });
}
