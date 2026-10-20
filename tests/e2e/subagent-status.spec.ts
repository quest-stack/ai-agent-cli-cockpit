import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, _electron as electron } from "@playwright/test";

import { createDefaultWorkspace } from "../../src/electron/defaults";

import type { TestInfo } from "@playwright/test";

test.skip(process.platform !== "win32", "Activity hooks currently require PowerShell.");

async function launchFixture(
  command: "claude" | "codex", testInfo: TestInfo, direct = false,
) {
  const userData = testInfo.outputPath("user-data");
  const bin = join(userData, "bin");
  await mkdir(bin, { recursive: true });
  const workspace = createDefaultWorkspace();
  workspace.settings.tourCompleted = true;
  workspace.settings.notificationsEnabled = false;
  await writeFile(join(userData, "session.json"), JSON.stringify(workspace), "utf8");
  const helper = join(bin, "fake-cli.cjs");
  const child = join(bin, "quiet-delegated-cli.cjs");
  await writeFile(child, `
    process.on('message', (code) => process.exit(code));
    process.on('disconnect', () => process.exit(0));
  `, "utf8");
  await writeFile(helper, `
    const fs = require('node:fs');
    const { fork, spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    function hookCommand(event) {
      if (${JSON.stringify(command)} === 'claude') {
        const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
        return settings.hooks[event][0].hooks[0].command;
      }
      const config = args.find((arg) => arg.startsWith('hooks.' + event + '='));
      if (!config) throw new Error('Missing Codex hook: ' + event);
      const match = config.match(/command='([^']+)'/);
      if (!match) throw new Error('Invalid TOML hook command');
      return match[1];
    }
    function send(event, agent, tool) {
      const encoded = hookCommand(event).split(' ').at(-1);
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
      ], { input: JSON.stringify({hook_event_name: event, session_id: 'parent', agent_id: agent, tool_use_id: tool}),
        encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (result.status !== 0 || result.stdout || result.stderr) throw new Error('Hook failed');
    }
    const children = new Map();
    if (${direct}) {
      for (const id of ['a', 'b']) {
        send('PreToolUse', undefined, 'direct-' + id);
        const child = fork(${JSON.stringify(child)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.set(id, child);
        child.on('exit', (code) => {
          const event = code && ${JSON.stringify(command)} === 'claude' ? 'PostToolUseFailure' : 'PostToolUse';
          send(event, undefined, 'direct-' + id);
          children.delete(id);
        });
      }
      console.log('Both direct calls started; terminal now quiet.');
    } else {
      send('SubagentStart', 'a');
      send('SubagentStart', 'b');
      console.log('Both subagents started; terminal now quiet.');
    }
    process.stdin.on('data', (data) => {
      if (${direct} && data.includes(3)) {
        for (const child of children.values()) child.send(0);
        console.log('Direct calls interrupted.');
      }
    });
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const instruction = line.trim();
      if (${direct}) {
        if (instruction === 'finish-a') children.get('a')?.send(0);
        if (instruction === 'finish-b') children.get('b')?.send(0);
        if (instruction === 'fail-b') children.get('b')?.send(1);
        if (instruction === 'probe-b') console.log('Direct b alive: ' + (children.get('b')?.exitCode === null));
        if (instruction === 'queue-tool') {
          send('PreToolUse', undefined, 'queued-direct-call');
          console.log('Queued tool hook saved.');
        }
      } else {
        if (instruction === 'finish-a') send('SubagentStop', 'a');
        if (instruction === 'finish-b') send('SubagentStop', 'b');
      }
      if (instruction === 'approve') console.log('Do you want to proceed? [y/n]');
    });
  `, "utf8");
  await writeFile(join(bin, `${command}.cmd`), `@"${process.execPath}" "${helper}" %*\r\n`, "utf8");
  const entry = join(userData, "hidden-entry.cjs");
  await writeFile(entry, `
    const { app, net } = require('electron');
    app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.showInactive = () => {}; });
    net.fetch = async () => new Response('{}');
    require(${JSON.stringify(resolve("dist/electron/main.js"))});
  `, "utf8");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key.toLowerCase() !== "path") environment[key] = value;
  }
  environment.PATH = `${bin};${process.env.PATH ?? process.env.Path ?? ""}`;
  environment.COCKPIT_USER_DATA = userData;
  environment.USERPROFILE = userData;
  const app = await electron.launch({
    args: process.env.COCKPIT_PACKAGED_EXECUTABLE ? [] : [entry],
    ...(process.env.COCKPIT_PACKAGED_EXECUTABLE
      ? { executablePath: process.env.COCKPIT_PACKAGED_EXECUTABLE } : {}),
    env: environment,
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId("launcher")).toBeVisible();
  // This fixture reads terminal text from the DOM. GPU-capable hosted runners
  // otherwise use canvas, whose output has no textContent to assert against.
  await page.evaluate(() => window.localStorage.setItem("cockpit.disableWebgl", "1"));
  await page.getByRole("combobox", { name: "プロジェクト" }).fill(process.cwd());
  await page.getByTestId(`cli-option-${command}`).check();
  await page.getByLabel("セッション名").fill("Subagent signal test");
  await page.getByRole("button", { name: /Start Session/u }).click();
  const terminal = page.getByTestId(/^terminal-/u);
  await expect(terminal.locator(".xterm-screen")).toContainText(
    direct ? "Both direct calls started" : "Both subagents started", { timeout: 25_000 },
  );
  const id = (await terminal.getAttribute("data-testid"))?.slice("terminal-".length);
  if (!id) throw new Error("Missing terminal session ID");
  const signal = page.getByRole("button", { name: /Subagent signal test/u })
    .locator(".status-dot");
  async function input(value: string) {
    await page.evaluate(({ id, value }) => window.cockpit?.writeSession({ sessionId: id, data: value }),
      { id: id as string, value: `${value}\r` });
  }
  return { app, page, signal, input, terminal };
}

for (const command of ["claude", "codex"] as const) {
  test(`${command}: quiet direct calls stay busy until both child processes finish`, async ({}, testInfo) => {
    const { app, signal, input, terminal } = await launchFixture(command, testInfo, true);
    try {
      await input("finish-a");
      await input("probe-b");
      await expect(terminal.locator(".xterm-screen")).toContainText("Direct b alive: true");
      const quietSince = Date.now();
      await expect.poll(async () => ({
        quietLongEnough: Date.now() - quietSince > 1_100,
        status: await signal.getAttribute("data-status"),
      })).toEqual({ quietLongEnough: true, status: "busy" });
      await input("fail-b");
      await expect(signal).toHaveAttribute("data-status", "idle");
    } finally { await app.close(); }
  });

  test(`${command}: approval stays red during a direct call`, async ({}, testInfo) => {
    const { app, signal, input } = await launchFixture(command, testInfo, true);
    try {
      await input("approve");
      await expect(signal).toHaveAttribute("data-status", "waiting");
    } finally { await app.close(); }
  });

  test(`${command}: Cancel input releases direct-call observations`, async ({}, testInfo) => {
    const { app, page, signal } = await launchFixture(command, testInfo, true);
    try {
      await expect(signal).toHaveAttribute("data-status", "busy");
      await page.getByRole("button", { name: "入力取消", exact: true }).click();
      await expect(signal).toHaveAttribute("data-status", "idle");
    } finally { await app.close(); }
  });

  test(`${command}: queued tool hooks cannot rearm busy after Cancel input`, async ({}, testInfo) => {
    const { app, page, signal, input, terminal } = await launchFixture(command, testInfo, true);
    try {
      // Hold the file poll, then resume it exactly when the interrupt is written.
      // This reproduces a hook saved before cancellation but observed afterwards.
      await app.evaluate(({ app: electronApp }) => {
        const load = process.mainModule!.require.bind(process.mainModule);
        const root = electronApp.isPackaged ? electronApp.getAppPath() : process.cwd();
        const { CliActivityBridge } = load(`${root}/dist/electron/cli-activity-bridge.js`) as {
          CliActivityBridge: { prototype: { poll(): void } };
        };
        const { PtyManager } = load(`${root}/dist/electron/pty-manager.js`) as {
          PtyManager: { prototype: { write(sessionId: string, data: string): void } };
        };
        let paused = true;
        const poll = CliActivityBridge.prototype.poll;
        CliActivityBridge.prototype.poll = function () { if (!paused) poll.call(this); };
        const write = PtyManager.prototype.write;
        PtyManager.prototype.write = function (sessionId, data) {
          if (data === "\u0003" || data === "\u001b") paused = false;
          write.call(this, sessionId, data);
        };
      });
      await input("queue-tool");
      await expect(terminal.locator(".xterm-screen")).toContainText("Queued tool hook saved.");
      await page.getByTestId("cancel-input").click();
      const quietSince = Date.now();
      await expect.poll(async () => ({
        quietLongEnough: Date.now() - quietSince > 1_100,
        status: await signal.getAttribute("data-status"),
      })).toEqual({ quietLongEnough: true, status: "idle" });
    } finally { await app.close(); }
  });
}

for (const command of ["claude", "codex"] as const) {
  test(`${command}: sidebar signal stays busy for quiet subagents, then returns to idle`, async ({}, testInfo) => {
    const { app, signal, input } = await launchFixture(command, testInfo);
    try {
      await expect(signal).toHaveAttribute("data-status", "busy");
      await input("finish-a");
      // 長い無出力区間を作り、900ms の待機タイマーが経過した後も観測する。
      const quietSince = Date.now();
      await expect.poll(async () => ({
        quietLongEnough: Date.now() - quietSince > 1_100,
        status: await signal.getAttribute("data-status"),
      })).toEqual({ quietLongEnough: true, status: "busy" });
      await input("finish-b");
      await expect(signal).toHaveAttribute("data-status", "idle");
    } finally { await app.close(); }
  });
}

test("approval signal takes priority while subagents are active", async ({}, testInfo) => {
  const { app, signal, input } = await launchFixture("claude", testInfo);
  try {
    await input("approve");
    await expect(signal).toHaveAttribute("data-status", "waiting");
  } finally { await app.close(); }
});
