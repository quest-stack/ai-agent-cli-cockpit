import assert from "node:assert/strict";
import test from "node:test";

import { closeSessionAfterHiding } from "../../src/shared/session-lifecycle";

test("manual close hides the terminal before kill and removes it after kill", async () => {
  const events: string[] = [];
  let resolveKill: (() => void) | undefined;
  const closing = closeSessionAfterHiding({
    killSession: (sessionId) => {
      events.push(`kill:${sessionId}`);
      return new Promise<void>((resolve) => {
        resolveKill = resolve;
      });
    },
    onClosingChange: (sessionId, isClosing) => {
      events.push(`closing:${sessionId}:${isClosing}`);
    },
    onRemove: (sessionId) => {
      events.push(`remove:${sessionId}`);
    },
    sessionId: "session-1",
  });

  assert.deepEqual(events, [
    "closing:session-1:true",
    "kill:session-1",
  ]);

  resolveKill?.();
  await closing;
  assert.deepEqual(events, [
    "closing:session-1:true",
    "kill:session-1",
    "remove:session-1",
    "closing:session-1:false",
  ]);
});

test("failed close restores the terminal without removing the session", async () => {
  const events: string[] = [];

  await assert.rejects(
    closeSessionAfterHiding({
      killSession: async () => {
        events.push("kill");
        throw new Error("kill failed");
      },
      onClosingChange: (_sessionId, isClosing) => {
        events.push(`closing:${isClosing}`);
      },
      onRemove: () => {
        events.push("remove");
      },
      sessionId: "session-1",
    }),
    /kill failed/u,
  );

  assert.deepEqual(events, ["closing:true", "kill", "closing:false"]);
});
