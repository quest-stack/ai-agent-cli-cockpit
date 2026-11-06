import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { _electron as electron, expect, test } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import type { PersistedWorkspace } from "../../src/shared/types";

test.skip(process.platform !== "win32", "Windows inbox and real ConPTY integration.");

async function fixture(info: TestInfo, actual = false, delayBootstrap = false, delayClientReady = false): Promise<{
  app: ElectronApplication; directory: string; inbox: string; result: string; project: string;
}> {
  const directory = info.outputPath("profile"), bin = join(directory, "bin");
  const project = actual ? resolve(process.env.COCKPIT_ACTUAL_REMOTE_CWD ?? process.cwd()) : join(directory, "project with spaces");
  const inbox = join(directory, "inbox"), result = join(directory, "received.json");
  for (const folder of [directory, bin, project, inbox]) await mkdir(folder, { recursive: true });
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  workspace.settings.scanRoots = [];
  workspace.settings.remoteLaunchEnabled = true;
  await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "path") environment[key] = value;
  }
  environment.PATH = process.env.PATH ?? process.env.Path ?? "";
  environment.COCKPIT_USER_DATA = directory;
  if (!actual) {
    const home = join(directory, "home");
    await mkdir(join(home, ".codex", "app-server-daemon"), { recursive: true });
    await writeFile(join(home, ".codex", "app-server-daemon", "settings.json"), JSON.stringify({ remoteControlEnabled: true }), "utf8");
    environment.USERPROFILE = home;
    environment.PATH = `${bin};${environment.PATH}`;
    const recorder = join(bin, "record.cjs");
    await writeFile(recorder, `
      const fs=require('node:fs');
      const cli=process.argv[2],args=process.argv.slice(3);
      if(args[0]==='app-server')process.exit(0);
      process.stdin.setEncoding('utf8');
      if(process.stdin.isTTY)process.stdin.setRawMode(true);
      let ready=${!delayClientReady};
      const renderReady=()=>{console.log('REMOTE_FIXTURE_READY:'+cli);if(cli==='codex')console.log('› Ask Codex to do anything\\nGPT-6.1 · Ready · Context 100% left');};
      if(ready)renderReady();else{console.log('OpenAI Codex loading');setTimeout(()=>{ready=true;renderReady();},3000);}
      let text='';
      process.stdin.on('data',chunk=>{
        text+=chunk;
        const end=text.search(/[\\r\\n]/);
        if(end<0)return;
        fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({cli,args,cwd:process.cwd(),prompt:text.slice(0,end),ready,pid:process.pid,parentPid:process.ppid}));
        console.log('REMOTE_FIXTURE_DONE');process.exit(0);
      });process.stdin.resume();`, "utf8");
    for (const cli of ["claude", "codex"]) {
      await writeFile(join(bin, `${cli}.cmd`), `@"${process.execPath}" "${recorder}" ${cli} %*\r\n`, "utf8");
    }
  }
  const entry = join(directory, "hidden-entry.cjs");
  await writeFile(entry, `const {app,net}=require('electron');
    app.on('browser-window-created',(_e,w)=>{w.show=()=>{};w.showInactive=()=>{};w.webContents.setBackgroundThrottling(false)});
    net.fetch=async()=>new Response('{}');
    require(${JSON.stringify(resolve("dist/electron/main.js"))});`, "utf8");
  const app = await electron.launch({ args: [entry, "--disable-gpu"], env: environment });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
  if (delayBootstrap) {
    await app.evaluate((_electron, requirePath) => {
      const load = process.getBuiltinModule("module").createRequire(requirePath);
      const module = load("./dist/electron/pty-manager.js") as { PtyManager: { prototype: {
        resize: (id: string, cols: number, rows: number, settled?: boolean) => void;
      } } };
      const original = module.PtyManager.prototype.resize;
      // Keep the owned fixture in the pending state until its real 12s fallback.
      module.PtyManager.prototype.resize = function (id, cols, rows): void {
        original.call(this, id, cols, rows, false);
      };
    }, resolve("package.json"));
  }
  return { app, directory, inbox, result, project };
}

async function json(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { return undefined; }
}

function hasExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function exitShell(page: Page, sessionId: string): Promise<void> {
  const status = await page.evaluateHandle((id) => {
    const state = { status: "" };
    const unsubscribe = window.cockpit!.onPtyStatus(event => {
      if (event.sessionId !== id || !["exited", "error"].includes(event.status)) return;
      state.status = event.status;
      unsubscribe();
    });
    window.cockpit!.writeSession({ sessionId: id, data: "exit 0\r" });
    return state;
  }, sessionId);
  try { await expect.poll(() => status.jsonValue()).toEqual({ status: "exited" }); }
  finally { await status.dispose(); }
}

for (const cli of [undefined, "claude", "codex"] as const) {
  test(`inbox ${cli ?? "legacy default"} starts the requested CLI and delivers the exact prompt`, async ({}, info) => {
    test.setTimeout(60_000);
    const { app, directory, inbox, result, project } = await fixture(info, false, cli === "codex");
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId("launcher")).toBeVisible();
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await expect(page.getByText(/inbox フォルダに置かれた依頼から Claude Code または Codex/u)).toBeVisible();
      await page.screenshot({ path: info.outputPath("remote-launch-settings.png") });
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await expect(page.getByText(/inbox フォルダに置かれた依頼から Claude Code または Codex/u)).toHaveCount(0);
      const prompt = "①②の変更を確認して、結果だけ教えてください。";
      await writeFile(join(inbox, "request.json"), JSON.stringify({ cli, cwd: project, title: "Owned remote launch", prompt }), "utf8");
      await expect.poll(() => json(result), { timeout: 35_000 }).toMatchObject({ cli: cli ?? "claude", prompt, cwd: project });
      const recorded = await json(result) as { args: string[]; pid: number; parentPid: number };
      if (cli === "codex") {
        expect(recorded.args).toContain("--remote");
        expect(recorded.args).toContain("--cd");
        expect(await readFile(join(directory, "diagnostic.log"), "utf8")).toContain('"reason":"settle-timeout"');
      }
      await expect.poll(async () => {
        const saved = await json(join(directory, "session.json")) as PersistedWorkspace | undefined;
        return saved?.sessions[0]?.command;
      }).toBe(cli ?? "claude");
      const session = page.getByTestId(/^session-row-/u);
      const sessionId = (await session.getAttribute("data-testid"))!.slice("session-row-".length);
      await expect(page.getByTestId(`terminal-${sessionId}`)).toBeVisible();
      await expect.poll(() => hasExited(recorded.pid) && hasExited(recorded.parentPid)).toBe(true);
      await exitShell(page, sessionId);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible()))).toBe(false);
    } finally { await app.close(); }
  });
}

test("Codex inbox waits through a quiet loading screen before delivering the initial prompt", async ({}, info) => {
  test.setTimeout(45_000);
  const { app, inbox, result, project } = await fixture(info, false, false, true);
  try {
    const page = await app.firstWindow(); await expect(page.getByTestId("launcher")).toBeVisible();
    const prompt = "DELAYED_STARTUP_ACCEPTANCE";
    await writeFile(join(inbox, "delayed.json"), JSON.stringify({ cli: "codex", cwd: project, prompt }), "utf8");
    await expect.poll(() => json(result), { timeout: 20_000 }).toMatchObject({ cli: "codex", prompt, ready: true });
    const row = page.getByTestId(/^session-row-/u), id = (await row.getAttribute("data-testid"))!.slice("session-row-".length);
    await exitShell(page, id);
  } finally { await app.close(); }
});

test("invalid inbox CLI selectors cannot create a tab or process", async ({}, info) => {
  const { app, directory, inbox, project } = await fixture(info);
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    for (const [index, cli] of ["powershell", "codex --yolo", "claude; whoami"].entries()) {
      await writeFile(join(inbox, `${index}.json`), JSON.stringify({ cli, cwd: project, prompt: "MUST_NOT_RUN" }), "utf8");
    }
    await expect.poll(async () => (await readFile(join(directory, "diagnostic.log"), "utf8")).match(/"event":"rejected"/gu)?.length ?? 0)
      .toBe(3);
    await expect(page.getByTestId(/^session-row-/u)).toHaveCount(0);
    expect((await json(join(directory, "session.json")) as PersistedWorkspace).sessions).toHaveLength(0);
  } finally { await app.close(); }
});

test("actual Codex receives an inbox request and runs its initial status command", async ({}, info) => {
  test.skip(process.env.COCKPIT_ACTUAL_REMOTE !== "1", "Explicit real CLI acceptance; no inference or customer task.");
  test.setTimeout(120_000);
  const { app, directory, inbox, project } = await fixture(info, true);
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("launcher")).toBeVisible();
    await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
    const output = await page.evaluateHandle(() => {
      const state = { text: "" };
      window.cockpit!.onPtyData(event => { state.text = (state.text + event.data).slice(-64_000); });
      return state;
    });
    await writeFile(join(inbox, "actual-codex.json"), JSON.stringify({ cli: "codex", cwd: project, title: "Owned inbox acceptance", prompt: "/status" }), "utf8");
    const plain = async (): Promise<string> => stripVTControlCharacters((await output.jsonValue()).text);
    await expect.poll(plain, { timeout: 90_000 }).toMatch(/Session:\s*[a-f\d-]{36}/iu);
    const saved = await json(join(directory, "session.json")) as PersistedWorkspace;
    const session = saved.sessions[0];
    expect(session.command).toBe("codex");
    expect(session.conversation?.cli).toBe("codex");
    expect(await plain()).toContain(session.conversation!.id);
    await page.getByTestId(`terminal-${session.id}`).screenshot({ path: info.outputPath("actual-codex-status.png") });
    await writeFile(info.outputPath("actual-codex-result.json"), JSON.stringify({ conversation: session.conversation, initialCommand: "/status", inferenceTurns: 0, sourceConversationTouched: false }), "utf8");
    await page.evaluate(async (id) => {
      await window.cockpit!.writeSession({ sessionId: id, data: "/quit" });
      // Codex treats a simultaneous text+Enter write as a paste, so submit separately.
      await new Promise(resolve => window.setTimeout(resolve, 200));
      await window.cockpit!.writeSession({ sessionId: id, data: "\r" });
    }, session.id);
    await expect.poll(plain, { timeout: 15_000 }).toContain(`resume ${session.conversation!.id}`);
    const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    await expect.poll(plain).toMatch(new RegExp(`PS ${escapedProject}>\\s*$`, "u"));
    await exitShell(page, session.id);
  } finally { await app.close(); }
});
