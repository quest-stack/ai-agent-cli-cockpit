import assert from "node:assert/strict";
import test from "node:test";

import { createCliLaunchCommand, getCliInvocation, getCliKind } from "../../src/shared/cli-launch";
import { getDefaultSessionTitle } from "../../src/shared/session-labels";
import { getNewlineSequenceForCommand, TERMINAL_CODEX_NEWLINE_SEQUENCE } from "../../src/renderer/terminal-behavior";

test("new, picker and latest modes use each CLI's own conversation history", () => {
  for (const [cli, mode, command] of [
    ["claude", "new", "claude"], ["claude", "resume", "claude --resume"], ["claude", "continue", "claude --continue"],
    ["codex", "new", "codex"], ["codex", "resume", "codex resume"], ["codex", "continue", "codex resume --last"],
  ] as const) {
    assert.equal(createCliLaunchCommand(cli, mode), command);
    assert.deepEqual(getCliInvocation(command), { cli, mode });
  }
});

test("resumed commands retain CLI labels and Codex newline behavior", () => {
  assert.equal(getDefaultSessionTitle("claude --resume"), "Claude");
  for (const command of ["codex resume", "codex resume --last"]) {
    assert.equal(getCliKind(command), "codex");
    assert.equal(getDefaultSessionTitle(command), "Codex");
    assert.equal(getNewlineSequenceForCommand(command), TERMINAL_CODEX_NEWLINE_SEQUENCE);
  }
  assert.deepEqual(getCliInvocation("claude -c"), { cli: "claude", mode: "continue" });
});

test("shell commands do not acquire conversation modes and custom commands remain unclassified", () => {
  assert.equal(createCliLaunchCommand("powershell", "resume"), "powershell");
  assert.equal(createCliLaunchCommand("shell", "continue"), "shell");
  assert.equal(createCliLaunchCommand("custom-tool", "resume"), "custom-tool");
  for (const command of ["__proto__", "claude; other-command", "codex resume --last; other-command", undefined]) {
    assert.equal(getCliKind(command), undefined);
  }
});
