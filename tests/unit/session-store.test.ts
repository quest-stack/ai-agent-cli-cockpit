import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDefaultSettings,
  createDefaultWorkspace,
} from "../../src/electron/defaults";
import { SessionStore } from "../../src/electron/session-store";

import type { PersistedWorkspace } from "../../src/shared/types";

test("fresh defaults do not contain machine-specific projects", () => {
  const settings = createDefaultSettings();

  assert.deepEqual(settings.pinned, []);
  assert.deepEqual(settings.scanRoots, []);
});

test("saved sessions and settings load independently of changed defaults", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cli-cockpit-store-"));
  const savedWorkspace: PersistedWorkspace = {
    ...createDefaultWorkspace(),
    activeTabId: "tab-saved",
    sessions: [
      {
        command: "claude",
        cwd: "C:\\legacy-work\\project-a",
        id: "session-saved",
        projectName: "project-a",
        shouldRestore: true,
        title: "Daily work",
      },
    ],
    settings: {
      ...createDefaultSettings(),
      pinned: ["C:\\legacy-work\\project-a"],
      scanRoots: ["C:\\legacy-work"],
    },
    tabs: [
      {
        activePaneId: "pane-saved",
        id: "tab-saved",
        root: {
          id: "pane-saved",
          sessionId: "session-saved",
          type: "pane",
        },
        title: "Daily work",
      },
    ],
  };

  try {
    await writeFile(
      join(temporaryRoot, "session.json"),
      `${JSON.stringify(savedWorkspace, null, 2)}\n`,
      "utf8",
    );

    const loaded = await new SessionStore(temporaryRoot).load();

    assert.deepEqual(loaded, savedWorkspace);
  } finally {
    const resolvedRoot = resolve(temporaryRoot);
    assert.ok(resolvedRoot.startsWith(resolve(tmpdir())));
    await rm(resolvedRoot, { force: true, recursive: true });
  }
});
