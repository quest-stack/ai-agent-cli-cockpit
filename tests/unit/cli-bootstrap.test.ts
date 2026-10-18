import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import {
  createBootstrapCommand,
  isCodexRemoteControlEnabled,
} from "../../src/electron/cli-bootstrap";

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cockpit-shared-start-"));
  try {
    run(root);
  } finally {
    assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}cockpit-shared-start-`));
    rmSync(root, { recursive: true, force: true });
  }
}

test("shared startup requires the CLI's explicit remote-control opt-in", () => {
  withFixture((root) => {
    assert.equal(isCodexRemoteControlEnabled(root), false);
    const directory = join(root, ".codex", "app-server-daemon");
    mkdirSync(directory, { recursive: true });
    for (const [contents, expected] of [
      ['{"remoteControlEnabled":true,"featureOverrides":{}}', true],
      ['{"remoteControlEnabled":false}', false],
      ['{"remoteControlEnabled":"true"}', false],
      ["{}", false],
      ["invalid json", false],
    ] as const) {
      writeFileSync(join(directory, "settings.json"), contents, "utf8");
      assert.equal(isCodexRemoteControlEnabled(root), expected);
    }
  });
});

test("observational hooks apply only to independent Windows CLI invocations", () => {
  const hooks = " --settings 'test-hooks.json'";
  assert.ok(createBootstrapCommand("claude", false, "win32", hooks).includes(hooks));
  assert.ok(createBootstrapCommand("codex", false, "win32", hooks).includes(hooks));
  assert.ok(!createBootstrapCommand("codex", true, "win32", hooks).includes(hooks));
  assert.ok(!createBootstrapCommand("claude", false, "darwin", hooks).includes(hooks));
});

function runBootstrap(root: string, command: string, shared: boolean, daemonExit = 0) {
  const bin = join(root, "bin");
  const requestedCwd = join(root, "space & apostrophe's work");
  mkdirSync(bin, { recursive: true });
  mkdirSync(requestedCwd, { recursive: true });
  // Hosted Windows runners can expose TEMP as an 8.3 path. PowerShell's
  // Get-Location expands it to the long path, so compare canonical locations.
  const cwd = realpathSync.native(requestedCwd);
  const trace = join(root, "calls.jsonl");
  const recorder = join(root, "record.cjs");
  writeFileSync(recorder,
    'require("node:fs").appendFileSync(process.env.COCKPIT_TEST_TRACE, JSON.stringify(process.argv.slice(2)) + "\\n");',
    "utf8");
  const stub = '@echo off\r\nnode "%COCKPIT_TEST_RECORDER%" %*\r\n'
    + 'if "%1"=="app-server" exit /b %COCKPIT_TEST_DAEMON_EXIT%\r\nexit /b 0\r\n';
  writeFileSync(join(bin, "codex.cmd"), stub, "utf8");
  writeFileSync(join(bin, "claude.cmd"), stub, "utf8");
  const encoded = Buffer.from(createBootstrapCommand(command, shared), "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
  ], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${bin};${process.env.PATH ?? ""}`,
      COCKPIT_TEST_TRACE: trace,
      COCKPIT_TEST_RECORDER: recorder,
      COCKPIT_TEST_DAEMON_EXIT: String(daemonExit),
    },
  });
  const calls = readFileSync(trace, "utf8").trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line) as string[]);
  return { result, calls, cwd };
}

test("shared Codex starts the daemon before attaching with the pane directory", {
  skip: process.platform !== "win32",
}, () => {
  withFixture((root) => {
    const { result, calls, cwd } = runBootstrap(root, "codex", true);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [
      ["app-server", "daemon", "start"],
      ["--remote", "unix://", "--cd", cwd, "-c", "tui.whimsy=false"],
    ]);
  });
});

test("failed daemon startup never opens an independent Codex session", {
  skip: process.platform !== "win32",
}, () => {
  withFixture((root) => {
    const { result, calls } = runBootstrap(root, "codex", true, 7);
    assert.deepEqual(calls, [["app-server", "daemon", "start"]]);
    assert.notEqual(result.stderr, "");
  });
});

test("Codex without remote opt-in keeps its existing terminal arguments", {
  skip: process.platform !== "win32",
}, () => {
  withFixture((root) => {
    const { result, calls } = runBootstrap(root, "codex", false);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [["-c", "tui.whimsy=false"]]);
  });
});

test("Claude startup does not adopt Codex's remote-control preference", {
  skip: process.platform !== "win32",
}, () => {
  withFixture((root) => {
    const { result, calls } = runBootstrap(root, "claude", true);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [[]]);
  });
});
