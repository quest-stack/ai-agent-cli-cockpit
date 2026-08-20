import assert from "node:assert/strict";
import test from "node:test";

import { persistedWorkspaceSchema } from "../../src/shared/schema";
import {
  getDefaultSessionTitle,
  resolveInitialLauncherCwd,
  sortPinnedFirst,
  normalizeLegacySessionTitle,
} from "../../src/shared/session-labels";
import { DEFAULT_SIDEBAR_WIDTH } from "../../src/shared/types";

test("legacy workspaces restore the default sidebar width", () => {
  const parsed = persistedWorkspaceSchema.parse({
    activeTabId: "tab-legacy",
    recent: [],
    savedPresets: [],
    sessions: [],
    settings: {
      alwaysConfirmClose: false,
      defaultCommand: "claude",
      notificationsEnabled: true,
      pinned: [],
      scanRoots: ["C:/work"],
    },
    tabs: [
      {
        activePaneId: "pane-legacy",
        id: "tab-legacy",
        root: {
          id: "pane-legacy",
          sessionId: null,
          type: "pane",
        },
        title: "New Session",
      },
    ],
    version: 1,
  });

  assert.equal(parsed.settings.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
  assert.equal(parsed.settings.tourCompleted, false);
});

test("legacy generated counters become flat CLI labels", () => {
  assert.equal(getDefaultSessionTitle("claude"), "Claude");
  assert.equal(
    normalizeLegacySessionTitle({
      command: "claude",
      projectName: "origin",
      title: "origin #2",
    }).title,
    "Claude",
  );
  assert.equal(
    normalizeLegacySessionTitle({
      command: "codex",
      projectName: "origin",
      title: "release #2",
    }).title,
    "release #2",
  );
});

test("workspace settings allow an empty scan root list", () => {
  const parsed = persistedWorkspaceSchema.parse({
    activeTabId: "tab-empty-roots",
    recent: [],
    savedPresets: [],
    sessions: [],
    settings: {
      alwaysConfirmClose: false,
      defaultCommand: "claude",
      notificationsEnabled: true,
      pinned: [],
      scanRoots: [],
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    },
    tabs: [
      {
        activePaneId: "pane-empty-roots",
        id: "tab-empty-roots",
        root: {
          id: "pane-empty-roots",
          sessionId: null,
          type: "pane",
        },
        title: "New Session",
      },
    ],
    version: 1,
  });

  assert.deepEqual(parsed.settings.scanRoots, []);
});

test("ランチャーの初期フォルダは、最後に使った場所になる", () => {
  // 以前はピン留めの先頭を無条件に入れていたため、いつも使う場所と
  // 違うフォルダが毎回入り、利用者が毎回打ち直していた。しかも打ち直しは
  // どこにも残らず、次の起動でまた戻っていた。
  const recent = [
    { cwd: "C:/work/my-project" },
    { cwd: "C:/work/other" },
  ];
  const projects = [
    { path: "C:/work/tools/cockpit" },
    { path: "C:/work/my-project" },
  ];

  assert.equal(
    resolveInitialLauncherCwd(recent, projects),
    "C:/work/my-project",
  );
});

test("履歴が無い初回は、候補の先頭を使う", () => {
  assert.equal(
    resolveInitialLauncherCwd([], [{ path: "C:/work/first" }]),
    "C:/work/first",
  );
});

test("履歴も候補も無ければ空欄のままにする", () => {
  assert.equal(resolveInitialLauncherCwd([], []), "");
});

test("ピン留めした場所は候補の先頭側へ移動する", () => {
  // 実際に起きた不具合: source を書き換えるだけで並べ替えていなかったため、
  // 一覧の途中にいた場所をピン留めしても、そこに居座ったままだった。
  // ランチャーの初期値が先頭を見ていたので「何回ピン留めしても効かない」
  // という形で現れていた。
  const projects = [
    { path: "C:/work/other", source: "pinned" },
    { path: "C:/work/scanned", source: "scan" },
    // 利用者がここをピン留めした（source は既に pinned へ変わっている）
    { path: "C:/work/my-project", source: "pinned" },
  ];

  const sorted = sortPinnedFirst(projects);

  assert.deepEqual(
    sorted.map((project) => project.path),
    ["C:/work/other", "C:/work/my-project", "C:/work/scanned"],
  );
});

test("ピン留め同士の順番は保たれる", () => {
  // 留めるたびに並びが変わると、どれが先頭か予測できなくなる。
  const projects = [
    { path: "C:/a", source: "pinned" },
    { path: "C:/b", source: "pinned" },
    { path: "C:/c", source: "pinned" },
  ];

  assert.deepEqual(
    sortPinnedFirst(projects).map((project) => project.path),
    ["C:/a", "C:/b", "C:/c"],
  );
});
