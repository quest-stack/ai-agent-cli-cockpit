import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

import { CliActivityBridge } from "../../src/electron/cli-activity-bridge";

import type { CliActivityEvent } from "../../src/electron/cli-activity-bridge";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "cockpit-activity-test-"));
  const events: CliActivityEvent[] = [];
  const bridge = new CliActivityBridge(base, "test-session", (event) => events.push(event));
  return { base, bridge, events, dispose: () => {
    bridge.dispose();
    // base はこのテストで mkdtemp が生成した絶対パスのみ。
    assert.ok(base.startsWith(`${resolve(tmpdir())}${sep}cockpit-activity-test-`));
    rmSync(base, { recursive: true, force: true });
  } };
}

test("actual PowerShell hook saves only lifecycle metadata with no output", { skip: process.platform !== "win32" }, () => {
  const { bridge, events, dispose } = fixture();
  try {
    const encoded = bridge.command.split(" ").at(-1);
    assert.ok(encoded);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
    ], { input: JSON.stringify({
      hook_event_name: "SubagentStart", session_id: "parent", agent_id: "agent-1",
      cwd: "private-folder", transcript_path: "private-transcript",
      prompt: "private-prompt", last_assistant_message: "private-answer",
    }), encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { ...process.env, ...bridge.environment } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    bridge.poll();
    assert.deepEqual(events, [{ event: "SubagentStart", sessionId: "parent", agentId: "agent-1" }]);
    assert.equal(readdirSync(bridge.directory).filter((name) => /^\d/u.test(name)).length, 0);
  } finally { dispose(); }
});

test("invalid events cannot poison the queue or include arbitrary fields", () => {
  const { bridge, events, dispose } = fixture();
  try {
    writeFileSync(join(bridge.directory, `063900000000000000-${"0".repeat(32)}.json`), "broken");
    writeFileSync(join(bridge.directory, `063900000000000001-${"0".repeat(32)}.json`), JSON.stringify({
      event: "SubagentStart", sessionId: "parent", agentId: "a", prompt: "private",
    }));
    bridge.poll();
    assert.deepEqual(events, [{ event: "SubagentStart", sessionId: "parent", agentId: "a" }]);
  } finally { dispose(); }
});

test("CLI arguments add hooks only to this invocation and preserve trust gates", () => {
  const { bridge, dispose } = fixture();
  try {
    assert.match(bridge.argumentsFor("claude"), /^ --settings '/u);
    const codex = bridge.argumentsFor("codex");
    assert.match(codex, /hooks\.SubagentStart/u);
    assert.match(codex, /hooks\.SubagentStop/u);
    assert.match(codex, /hooks\.PostToolUse=/u);
    assert.match(codex, /hooks\.Stop=/u);
    assert.doesNotMatch(codex, /PostToolUseFailure|StopFailure/u);
    const settings = JSON.parse(readFileSync(join(bridge.directory, "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    assert.ok(settings.hooks.PostToolUse);
    assert.ok(settings.hooks.PostToolUseFailure);
    assert.ok(settings.hooks.Stop);
    assert.ok(settings.hooks.StopFailure);
    assert.equal(settings.hooks.Interrupt, undefined);
    assert.doesNotMatch(codex, /bypass-hook-trust|features\.hooks|approval|sandbox/u);
    assert.equal(bridge.argumentsFor("powershell"), "");
  } finally { dispose(); }
});

test("actual tool hooks preserve only validated IDs, never commands or results", { skip: process.platform !== "win32" }, () => {
  const { bridge, events, dispose } = fixture();
  try {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Interrupt"]) {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", bridge.command.split(" ").at(-1) as string,
      ], { input: JSON.stringify({
        hook_event_name: event, session_id: "parent", tool_use_id: "call_123-abc",
        tool_name: "Bash", tool_input: { command: "private-command" },
        tool_response: "private-result", error: "private-error", prompt: "private-prompt",
      }), encoding: "utf8", timeout: 5_000, windowsHide: true,
        env: { ...process.env, ...bridge.environment } });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    bridge.poll();
    assert.deepEqual(events.map((event) => ({ ...event, event: "event" })),
      Array.from({ length: 6 }, () => ({ event: "event", sessionId: "parent", toolUseId: "call_123-abc" })));
  } finally { dispose(); }
});

test("activity from another Cockpit session stays isolated", () => {
  const { base, bridge, events, dispose } = fixture();
  const other = new CliActivityBridge(base, "other-session", () => {});
  try {
    writeFileSync(join(other.directory, `063900000000000000-${"0".repeat(32)}.json`), JSON.stringify({
      event: "SubagentStart", sessionId: "other", agentId: "a",
    }));
    bridge.poll();
    assert.deepEqual(events, []);
  } finally { other.dispose(); dispose(); }
});

test("hook launch arguments stay bounded with long paths and quoting characters", { skip: process.platform !== "win32" }, () => {
  const { base, dispose } = fixture();
  const events: CliActivityEvent[] = [];
  const storage = join(base, "long-path-".repeat(4), "日本語 user's directory");
  const bridge = new CliActivityBridge(storage, "long-path-session", (event) => events.push(event));
  try {
    assert.ok(bridge.argumentsFor("codex").length < 6_000);
    assert.ok(bridge.command.length < 500);
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", bridge.command.split(" ").at(-1) as string,
    ], { input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "parent", tool_use_id: "direct",
    }), encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { ...process.env, ...bridge.environment } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    bridge.poll();
    assert.deepEqual(events, [{ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" }]);
  } finally { bridge.dispose(); dispose(); }
});

test("an occupied activity directory cannot mix app instances, and restart keeps command stable", () => {
  const { base, bridge, dispose } = fixture();
  try {
    assert.throws(() => new CliActivityBridge(base, "test-session", () => {}), /in use/u);
    const command = bridge.command;
    bridge.dispose();
    const replacement = new CliActivityBridge(base, "test-session", () => {});
    try { assert.equal(replacement.command, command); } finally { replacement.dispose(); }
  } finally { dispose(); }
});
