import { DEFAULT_SIDEBAR_WIDTH } from "../shared/types";

import type { AppSettings, PersistedWorkspace } from "../shared/types";

export function createDefaultSettings(): AppSettings {
  return {
    alwaysConfirmClose: true,
    defaultCommand: "claude",
    // 既定は CLI 本来のまま（Enter で送信）。更新しただけで送信のキーが
    // 変わると、これまでの手が通じなくなるため、切り替えは利用者に委ねる。
    enterInsertsNewline: false,
    notificationsEnabled: true,
    pinned: [],
    // 既定は無効。受付フォルダに書ける主体へ「この PC で作業を走らせる力」を
    // 渡すことになるため、利用者が設定で明示的に有効化してから開く。
    remoteLaunchEnabled: false,
    scanRoots: [],
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    tourCompleted: false,
  };
}

export function createDefaultWorkspace(): PersistedWorkspace {
  return {
    activeTabId: "tab-welcome",
    recent: [],
    savedPresets: [],
    sessions: [],
    settings: createDefaultSettings(),
    tabs: [
      {
        activePaneId: "pane-welcome",
        id: "tab-welcome",
        root: {
          id: "pane-welcome",
          sessionId: null,
          type: "pane",
        },
        title: "New Session",
      },
    ],
    version: 1,
  };
}
