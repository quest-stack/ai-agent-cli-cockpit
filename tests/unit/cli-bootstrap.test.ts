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
  for (const command of ["claude --resume", "claude --continue", "codex resume", "codex resume --last"]) {
    assert.ok(createBootstrapCommand(command, false, "win32", hooks).includes(hooks));
  }
});

test("POSIX conversation modes retain cwd and the existing shared connection policy", () => {
  assert.equal(createBootstrapCommand("codex resume", false, "darwin"), 'codex resume --cd "$PWD" -c tui.whimsy=false\r');
  assert.equal(createBootstrapCommand("codex resume --last", false, "darwin"), 'codex resume --last --cd "$PWD" -c tui.whimsy=false\r');
  assert.ok(createBootstrapCommand("codex resume --last", true, "darwin").includes('codex --remote unix:// --cd "$PWD" -c tui.whimsy=false resume --last;'));
  assert.equal(createBootstrapCommand("claude --resume", true, "darwin"), "claude --resume\r");
  assert.equal(createBootstrapCommand("claude -c", true, "darwin"), "claude --continue\r");
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

for (const mode of ["resume", "resume --last"] as const) {
  test(`shared Codex ${mode} keeps the daemon, remote connection and chosen directory`, {
    skip: process.platform !== "win32",
  }, () => {
    withFixture((root) => {
      const { result, calls, cwd } = runBootstrap(root, `codex ${mode}`, true);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(calls, [["app-server", "daemon", "start"],
        ["--remote", "unix://", "--cd", cwd, "-c", "tui.whimsy=false", ...mode.split(" ")]]);
    });
  });

  test(`independent Codex ${mode} keeps the chosen directory`, {
    skip: process.platform !== "win32",
  }, () => {
    withFixture((root) => {
      const { result, calls, cwd } = runBootstrap(root, `codex ${mode}`, false);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(calls, [[...mode.split(" "), "--cd", cwd, "-c", "tui.whimsy=false"]]);
    });
  });
}

for (const option of ["--resume", "--continue"] as const) {
  test(`Claude ${option} reaches the CLI without changing to Codex`, { skip: process.platform !== "win32" }, () => {
    withFixture((root) => {
      const { result, calls } = runBootstrap(root, `claude ${option}`, true);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(calls, [[option]]);
    });
  });
}

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
