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

test("Codex child thread activity resumes without agent_id and ignores root tools", () => {
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
