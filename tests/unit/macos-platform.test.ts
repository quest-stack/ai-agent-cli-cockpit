import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { createBootstrapCommand } from "../../src/electron/cli-bootstrap";
import { getShellLaunch } from "../../src/electron/shell-launch";
import { formatClipboardImagePath } from "../../src/shared/clipboard";
import { translate } from "../../src/shared/i18n";
import { formatShortcutLabel, isPrimaryShortcut, normalizeShellCommand } from "../../src/shared/platform";
import { resolveTerminalKeyAction } from "../../src/renderer/terminal-behavior";

test("Mac GUI startup adds common CLI locations and uses an interactive login shell", () => {
  const shell = getShellLaunch("darwin", { PATH: "/usr/bin:/bin" }, "/Users/sample user", "/bin/zsh");
  assert.equal(shell.file, "/bin/zsh");
  assert.deepEqual(shell.args, ["-il"]);
  assert.ok(shell.path.split(":").includes("/Users/sample user/.local/bin"));
  assert.ok(shell.path.split(":").includes("/opt/homebrew/bin"));
});

test("unsupported login shell cannot receive POSIX bootstrap syntax", () => {
  assert.equal(getShellLaunch("darwin", {}, "/Users/tester", "/usr/local/bin/fish").file, "/bin/zsh");
});

test("Mac app shortcuts use Command while Control+C remains a terminal operation", () => {
  const command = { altKey: false, ctrlKey: false, metaKey: true };
  const control = { ...command, ctrlKey: true, metaKey: false };
  assert.equal(isPrimaryShortcut(command, "darwin"), true);
  assert.equal(isPrimaryShortcut(control, "darwin"), false);
  assert.equal(isPrimaryShortcut(control, "win32"), true);
});

test("Mac copy never interrupts a CLI when no text is selected", () => {
  const event = { type: "keydown", key: "c", code: "KeyC", keyCode: 67,
    altKey: false, ctrlKey: false, metaKey: true, shiftKey: false, isComposing: false };
  assert.equal(resolveTerminalKeyAction(event, false, false, "darwin"), "ignore");
  assert.equal(resolveTerminalKeyAction(event, true, false, "darwin"), "copy-selection");
  assert.equal(resolveTerminalKeyAction({ ...event, metaKey: false, ctrlKey: true }, false, false, "darwin"), "passthrough");
});

test("Mac labels keep Control+Tab and Control+C distinct from Command shortcuts", () => {
  assert.equal(formatShortcutLabel("Ctrl + V / Ctrl+Shift+D / Ctrl+Tab / Ctrl+C", "darwin"),
    "⌘ + V / ⌘+Shift+D / Ctrl+Tab / Ctrl+C");
  assert.equal(normalizeShellCommand("powershell", "darwin"), "shell");
  assert.equal(normalizeShellCommand("shell", "win32"), "powershell");
});

test("platform-aware translation does not rewrite user-provided text", () => {
  const title = "Ctrl+Shift+D Windows通知";
  assert.equal(translate("ja", "{value0} · ほか{value1}件", { value0: title, value1: 2 }, "darwin"), `${title} · ほか2件`);
  assert.equal(translate("ja", "検索 (Ctrl+Shift+F)", {}, "darwin"), "検索 (⌘+Shift+F)");
});

test("POSIX image paths reach zsh literally without command expansion", { skip: process.platform !== "darwin" }, () => {
  const filePath = "/tmp/日本語 & apostrophe's $HOME `id` $(id)\\name.png";
  const result = spawnSync("/bin/zsh", ["-f", "-c", `printf '%s' ${formatClipboardImagePath(filePath, "darwin")}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, filePath);
});

for (const daemonExit of [0, 7]) {
  test(`Mac shared Codex startup preserves cwd and daemon failure boundary (${daemonExit})`, { skip: process.platform !== "darwin" }, () => {
    const root = mkdtempSync(join(tmpdir(), "cockpit-mac-bootstrap-"));
    try {
      const bin = join(root, "bin");
      const requestedCwd = join(root, "work & apostrophe's 日本語");
      mkdirSync(bin); mkdirSync(requestedCwd);
      const cwd = realpathSync(requestedCwd);
      const recorder = join(root, "record.cjs");
      const trace = join(root, "calls.jsonl");
      writeFileSync(recorder, 'require("node:fs").appendFileSync(process.env.COCKPIT_TEST_TRACE, JSON.stringify(process.argv.slice(2))+"\\n");', "utf8");
      const stub = join(bin, "codex");
      writeFileSync(stub, '#!/bin/sh\n"$COCKPIT_TEST_NODE" "$COCKPIT_TEST_RECORDER" "$@"\nif [ "$1" = app-server ]; then exit "$COCKPIT_TEST_DAEMON_EXIT"; fi\n', "utf8");
      chmodSync(stub, 0o755);
      const result = spawnSync("/bin/zsh", ["-f", "-c", createBootstrapCommand("codex", true, "darwin").trim()], {
        cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`,
          COCKPIT_TEST_NODE: process.execPath, COCKPIT_TEST_RECORDER: recorder,
          COCKPIT_TEST_TRACE: trace, COCKPIT_TEST_DAEMON_EXIT: String(daemonExit) },
      });
      const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls, daemonExit === 0
        ? [["app-server", "daemon", "start"], ["--remote", "unix://", "--cd", cwd, "-c", "tui.whimsy=false"]]
        : [["app-server", "daemon", "start"]]);
      if (daemonExit !== 0) assert.match(result.stderr, /failed/u);
      else assert.equal(result.status, 0, result.stderr);
    } finally {
      assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}cockpit-mac-bootstrap-`));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
