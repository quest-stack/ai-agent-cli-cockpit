import assert from "node:assert/strict";
import test from "node:test";

import {
  closeTabAfterTerminatingSessions,
  getRunningSessionIdsInTab,
} from "../../src/shared/tab-lifecycle";

import type {
  SessionState,
  TabState,
} from "../../src/shared/types";

function createSession(
  id: string,
  status: SessionState["status"],
): SessionState {
  return {
    command: "claude",
    cwd: "C:/work",
    id,
    projectName: "project",
    shouldRestore: status !== "exited" && status !== "error",
    startedAt: 1,
    status,
    title: id,
  };
}

const tab: TabState = {
  activePaneId: "pane-busy",
  id: "tab-work",
  root: {
    axis: "row",
    children: [
      {
        id: "pane-busy",
        sessionId: "session-busy",
        type: "pane",
      },
      {
        axis: "column",
        children: [
          {
            id: "pane-idle",
            sessionId: "session-idle",
            type: "pane",
          },
          {
            id: "pane-exited",
            sessionId: "session-exited",
            type: "pane",
          },
        ],
        id: "split-secondary",
        ratio: 0.5,
        type: "split",
      },
    ],
    id: "split-root",
    ratio: 0.5,
    type: "split",
  },
  title: "Work",
};

test("closing a tab kills every running session before removing it", async () => {
  const sessions = [
    createSession("session-busy", "busy"),
    createSession("session-idle", "idle"),
    createSession("session-exited", "exited"),
  ];
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
  let closed = false;

  const closing = closeTabAfterTerminatingSessions({
    killSession: (sessionId) => {
      started.push(sessionId);
      return new Promise<void>((resolve) => {
        resolvers.set(sessionId, resolve);
      });
    },
    onClose: () => {
      closed = true;
    },
    sessions,
    tab,
  });

  assert.deepEqual(started, ["session-busy", "session-idle"]);
  assert.equal(closed, false);

  resolvers.get("session-busy")?.();
  await Promise.resolve();
  assert.equal(closed, false);

  resolvers.get("session-idle")?.();
  await closing;
  assert.equal(closed, true);
});

test("a tab without a running session closes without a kill", async () => {
  const sessions = [createSession("session-exited", "exited")];
  const killed: string[] = [];
  let closed = false;

  assert.deepEqual(getRunningSessionIdsInTab(tab, sessions), []);

  await closeTabAfterTerminatingSessions({
    killSession: async (sessionId) => {
      killed.push(sessionId);
    },
    onClose: () => {
      closed = true;
    },
    sessions,
    tab,
  });

  assert.deepEqual(killed, []);
  assert.equal(closed, true);
});
