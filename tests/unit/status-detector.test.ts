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
