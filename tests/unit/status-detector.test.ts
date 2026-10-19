import assert from "node:assert/strict";
import test from "node:test";

import {
  containsWaitingPrompt,
  StatusDetector,
  stripTerminalSequences,
} from "../../src/electron/status-detector";

import type { SessionStatus } from "../../src/shared/types";

function waitForSettledStatus(
  data: string,
  expected: SessionStatus,
): Promise<SessionStatus[]> {
  return new Promise((resolve, reject) => {
    const statuses: SessionStatus[] = [];
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expected}.`));
    }, 250);
    const detector = new StatusDetector((status) => {
      statuses.push(status);
      if (status === expected) {
        clearTimeout(timeout);
        detector.dispose();
        resolve(statuses);
      }
    }, 5);

    detector.handleData(data);
  });
}

test("ANSI escape sequences are removed before prompt detection", () => {
  const value = "\u001b[34mWaiting for your approval\u001b[0m";
  assert.equal(stripTerminalSequences(value), "Waiting for your approval");
  assert.equal(containsWaitingPrompt(stripTerminalSequences(value)), true);
});

test("approval prompt transitions from busy to waiting", async () => {
  const statuses = await waitForSettledStatus(
    "Do you want to proceed? [y/n]",
    "waiting",
  );
  assert.deepEqual(statuses, ["busy", "waiting"]);
});

test("ordinary output transitions from busy to idle", async () => {
  const statuses = await waitForSettledStatus("Build completed.", "idle");
  assert.deepEqual(statuses, ["busy", "idle"]);
});

test("waiting survives terminal redraw output until real input", async () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status), 5);

  detector.handleData("Do you want to proceed? [y/n]");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(statuses, ["busy", "waiting"]);

  detector.handleData("\r\u001b[2K");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(statuses, ["busy", "waiting"]);

  detector.handleInput();
  detector.handleData("y\r\nContinuing.");
  await new Promise((resolve) => setTimeout(resolve, 15));
  detector.dispose();
  assert.deepEqual(statuses, ["busy", "waiting", "busy", "idle"]);
});

test("non-zero exit is classified as an error", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status), 5);
  detector.handleExit(1);
  assert.deepEqual(statuses, ["error"]);
});

test("quiet subagents keep busy until the last unique agent stops", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleSubagent("a", true);
  detector.handleSubagent("a", true);
  detector.handleSubagent("b", true);
  detector.handleData("Delegated work.");
  context.mock.timers.tick(10_000);
  detector.handleSubagent("unknown", false);
  detector.handleSubagent("a", false);
  assert.deepEqual(statuses, ["busy"]);
  detector.handleSubagent("b", false);
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("approval overrides active subagents and survives their completion", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleSubagent("a", true);
  detector.handleData("Do you want to proceed? [y/n]");
  context.mock.timers.tick(1_000);
  detector.handleSubagent("b", true);
  detector.handleSubagent("a", false);
  detector.handleSubagent("b", false);
  assert.deepEqual(statuses, ["busy", "waiting"]);
  detector.handleInput();
  detector.handleData("Continuing.");
  context.mock.timers.tick(1_000);
  assert.deepEqual(statuses, ["busy", "waiting", "busy", "idle"]);
  detector.dispose();
});

test("subagent completion does not erase the parent's terminal activity", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleSubagent("a", true);
  detector.handleData("Parent is integrating results.");
  detector.handleSubagent("a", false);
  assert.deepEqual(statuses, ["busy"]);
  context.mock.timers.tick(1_000);
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("compaction preserves activity, reused agents restart, and session end clears it", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "SubagentStart", sessionId: "parent", agentId: "a" });
  detector.handleActivityEvent({ event: "SessionStart", sessionId: "parent", source: "compact" });
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "SubagentStop", sessionId: "parent", agentId: "a" });
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", agentId: "a" });
  detector.handleActivityEvent({ event: "SessionEnd", sessionId: "parent" });
  assert.deepEqual(statuses, ["busy", "idle", "busy", "idle"]);
  detector.dispose();
});

test("a late hook cannot reactivate an exited or disposed session", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleSubagent("a", true);
  detector.handleExit(0);
  detector.handleSubagent("b", true);
  detector.handleData("Late output");
  assert.deepEqual(statuses, ["busy", "exited"]);
});

test("Codex child activity resumes without agent_id and ignores tools without IDs", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "SubagentStart", sessionId: "child", agentId: "child" });
  detector.handleActivityEvent({ event: "SubagentStop", sessionId: "child", agentId: "child" });
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent" });
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "child" });
  assert.deepEqual(statuses, ["busy", "idle", "busy"]);
  detector.dispose();
});

test("child lifecycle events leave sibling subagents busy", () => {
  for (const event of ["SessionStart", "SessionEnd", "Interrupt", "SubagentStop"] as const) {
    const statuses: SessionStatus[] = [];
    const detector = new StatusDetector((status) => statuses.push(status));
    detector.handleSubagent("a", true);
    detector.handleSubagent("b", true);
    detector.handleActivityEvent({ event, sessionId: "a", source: "startup" });
    assert.deepEqual(statuses, ["busy"]);
    if (event === "SessionStart") detector.handleSubagent("a", false);
    detector.handleSubagent("b", false);
    assert.deepEqual(statuses, ["busy", "idle"]);
    detector.dispose();
  }
});

test("direct CLI calls stay busy without output until the last unique tool completes", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  const call = { sessionId: "parent", toolUseId: "direct-a" };
  detector.handleActivityEvent({ event: "PreToolUse", ...call });
  detector.handleActivityEvent({ event: "PreToolUse", ...call });
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct-b" });
  detector.handleData("Calling the other CLI directly.");
  context.mock.timers.tick(60_000);
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "unknown" });
  detector.handleActivityEvent({ event: "PostToolUse", ...call });
  detector.handleActivityEvent({ event: "PostToolUse", ...call });
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "direct-b" });
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("tool IDs are scoped to their session and agent", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "same" });
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", agentId: "a", toolUseId: "same" });
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "other", toolUseId: "same" });
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", agentId: "b", toolUseId: "same" });
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "same" });
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", agentId: "a", toolUseId: "same" });
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "SubagentStop", sessionId: "parent", agentId: "a" });
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("tool failure releases only that call and keeps active subagents", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleSubagent("a", true);
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleActivityEvent({ event: "PostToolUseFailure", sessionId: "parent", toolUseId: "direct" });
  assert.deepEqual(statuses, ["busy"]);
  detector.handleSubagent("a", false);
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("approval stays red when a directly called CLI finishes", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleData("Do you want to proceed? [y/n]");
  context.mock.timers.tick(1_000);
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "direct" });
  assert.deepEqual(statuses, ["busy", "waiting"]);
  detector.dispose();
});

test("child completion cannot clear the parent's tools or sibling work", () => {
  for (const event of ["Stop", "StopFailure", "SubagentStop", "SessionEnd", "Interrupt"] as const) {
    const statuses: SessionStatus[] = [];
    const detector = new StatusDetector((status) => statuses.push(status));
    detector.handleSubagent("a", true);
    detector.handleSubagent("b", true);
    detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "root" });
    detector.handleActivityEvent({ event: "PreToolUse", sessionId: "a", toolUseId: "child" });
    detector.handleActivityEvent({ event, sessionId: "a" });
    detector.handleSubagent("a", false);
    detector.handleSubagent("b", false);
    assert.deepEqual(statuses, ["busy"]);
    detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "root" });
    assert.deepEqual(statuses, ["busy", "idle"]);
    detector.dispose();
  }
});

test("turn completion and a new prompt recover missing tool endings", () => {
  for (const event of ["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt", "SessionStart"] as const) {
    const statuses: SessionStatus[] = [];
    const detector = new StatusDetector((status) => statuses.push(status));
    detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
    detector.handleActivityEvent({ event, sessionId: "parent", source: "startup" });
    assert.deepEqual(statuses, ["busy", "idle"]);
    detector.dispose();
  }
});

test("compaction, ordinary input and arrow keys do not discard direct work", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleActivityEvent({ event: "SessionStart", sessionId: "parent", source: "compact" });
  detector.handleInput("x");
  detector.handleInput("\u001b[A");
  assert.deepEqual(statuses, ["busy"]);
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "direct" });
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});

test("explicit interrupt releases tool observations and returns to output detection", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const input of ["\u0003", "\u001b"]) {
    const statuses: SessionStatus[] = [];
    const detector = new StatusDetector((status) => statuses.push(status));
    detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
    detector.handleInput(input);
    assert.deepEqual(statuses, ["busy", "idle"]);
    detector.handleData("CLI is still producing output.");
    context.mock.timers.tick(1_000);
    assert.deepEqual(statuses, ["busy", "idle", "busy", "idle"]);
    detector.dispose();
  }
});

test("late tool hooks cannot revive an exited session", () => {
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleExit(0);
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "late" });
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleInput("\u0003");
  assert.deepEqual(statuses, ["busy", "exited"]);
});

test("a tool ending does not erase fresh terminal output", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SessionStatus[] = [];
  const detector = new StatusDetector((status) => statuses.push(status));
  detector.handleActivityEvent({ event: "PreToolUse", sessionId: "parent", toolUseId: "direct" });
  detector.handleData("The caller is combining results.");
  detector.handleActivityEvent({ event: "PostToolUse", sessionId: "parent", toolUseId: "direct" });
  assert.deepEqual(statuses, ["busy"]);
  context.mock.timers.tick(1_000);
  assert.deepEqual(statuses, ["busy", "idle"]);
  detector.dispose();
});
