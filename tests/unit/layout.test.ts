import assert from "node:assert/strict";
import test from "node:test";

import {
  assignSession,
  collectPanes,
  createTab,
  createTabRenderStates,
  findPaneBySession,
  getTabDisplayTitle,
  removePane,
  splitPane,
  updateSplitRatio,
} from "../../src/shared/layout";
import { renameSessionTitle } from "../../src/shared/session-labels";

import type { IdFactory } from "../../src/shared/layout";

function createIdFactory(): IdFactory {
  let count = 0;
  return (prefix) => `${prefix}-${++count}`;
}

test("six panes can be constructed in one tab", () => {
  const idFactory = createIdFactory();
  let tab = createTab(idFactory);

  for (let index = 0; index < 5; index += 1) {
    const result = splitPane(
      tab.root,
      tab.activePaneId,
      index % 2 === 0 ? "row" : "column",
      idFactory,
    );
    tab = {
      ...tab,
      activePaneId: result.activePaneId,
      root: result.root,
    };
  }

  assert.equal(collectPanes(tab.root).length, 6);
  assert.equal(
    new Set(collectPanes(tab.root).map((pane) => pane.id)).size,
    6,
  );
});

test("sessions can be assigned, found, resized and removed", () => {
  const idFactory = createIdFactory();
  const tab = createTab(idFactory);
  const firstPaneId = tab.activePaneId;
  const split = splitPane(tab.root, firstPaneId, "row", idFactory);
  const assigned = assignSession(split.root, split.activePaneId, "session-1");

  assert.equal(findPaneBySession(assigned, "session-1")?.id, split.activePaneId);

  const rootSplit = assigned.type === "split" ? assigned : undefined;
  if (!rootSplit) {
    throw new Error("Expected a split root.");
  }
  const resized = updateSplitRatio(assigned, rootSplit.id, 0.99);
  assert.equal(resized.type === "split" ? resized.ratio : 0, 0.85);

  const remaining = removePane(resized, split.activePaneId);
  if (!remaining) {
    throw new Error("Expected one remaining pane.");
  }
  assert.equal(collectPanes(remaining).length, 1);
  assert.equal(collectPanes(remaining)[0].id, firstPaneId);
});

test("tab switching keeps every split layout in the render set", () => {
  const idFactory = createIdFactory();
  const firstTab = createTab(idFactory, "First");
  const firstSplit = splitPane(
    firstTab.root,
    firstTab.activePaneId,
    "row",
    idFactory,
  );
  const splitTab = {
    ...firstTab,
    activePaneId: firstSplit.activePaneId,
    root: firstSplit.root,
  };
  const secondTab = createTab(idFactory, "Second");
  const tabs = [splitTab, secondTab];

  const secondActive = createTabRenderStates(tabs, secondTab.id);
  const firstRestored = createTabRenderStates(tabs, splitTab.id);

  assert.equal(secondActive.length, 2);
  assert.equal(
    secondActive.find((state) => state.tab.id === splitTab.id)?.active,
    false,
  );
  assert.strictEqual(
    secondActive.find((state) => state.tab.id === splitTab.id)?.tab.root,
    firstSplit.root,
  );
  assert.equal(
    collectPanes(
      firstRestored.find((state) => state.tab.id === splitTab.id)?.tab.root ??
        secondTab.root,
    ).length,
    2,
  );
});

test("multi-session tabs lead with the selected task and count the other sessions", () => {
  const idFactory = createIdFactory();
  const tab = createTab(idFactory);
  const split = splitPane(tab.root, tab.activePaneId, "row", idFactory);
  const withFirstSession = assignSession(
    split.root,
    tab.activePaneId,
    "session-1",
  );
  const withBothSessions = assignSession(
    withFirstSession,
    split.activePaneId,
    "session-2",
  );

  for (const [activePaneId, title] of [
    [tab.activePaneId, "Claude"],
    [split.activePaneId, "Codex"],
  ]) {
    assert.equal(
      getTabDisplayTitle(
        { ...tab, activePaneId, root: withBothSessions },
        [
          {
            id: "session-1",
            projectName: "origin",
            title: "Claude",
          },
          {
            id: "session-2",
            projectName: "corporate-site",
            title: "Codex",
          },
        ],
      ),
      `${title} · ほか1件`,
    );
  }
});

test("renaming a session immediately changes its single-session tab label", () => {
  const idFactory = createIdFactory();
  const tab = createTab(idFactory);
  const assignedTab = {
    ...tab,
    root: assignSession(tab.root, tab.activePaneId, "session-1"),
  };
  const sessions = [
    {
      id: "session-1",
      projectName: "corporate-site",
      title: "Claude",
    },
  ];
  const renamed = renameSessionTitle(
    sessions,
    "session-1",
    "  CV 改善  ",
  );

  assert.equal(renamed[0].title, "CV 改善");
  assert.equal(
    getTabDisplayTitle(assignedTab, renamed),
    "CV 改善 · corporate-site",
  );
  assert.strictEqual(
    renameSessionTitle(renamed, "session-1", "   "),
    renamed,
  );
});
