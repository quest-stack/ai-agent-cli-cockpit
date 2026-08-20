import { DEFAULT_SIDEBAR_WIDTH } from "../shared/types";

import type {
  BootstrapPayload,
  CockpitApi,
  PersistedWorkspace,
  ProjectCandidate,
  PtyDataEvent,
  PtyStatusEvent,
  SessionState,
  SpawnSessionRequest,
} from "../shared/types";

type DataListener = (event: PtyDataEvent) => void;
type StatusListener = (event: PtyStatusEvent) => void;

/**
 * ブラウザでのUI確認用のダミーデータ。preload が読めなかった場合の
 * フォールバックとしても表示されうるため、実在の案件名や個人環境の
 * パスを入れないこと（配布先の画面に出る）。
 */
const demoProjects: ProjectCandidate[] = [
  {
    hasGit: true,
    hasPackageJson: true,
    name: "sample-web",
    path: "C:/work/sample-web",
    source: "pinned",
  },
  {
    hasGit: true,
    hasPackageJson: true,
    name: "sample-api",
    path: "C:/work/sample-api",
    source: "pinned",
  },
  {
    hasGit: true,
    hasPackageJson: true,
    name: "sample-app",
    path: "C:/work/clients/sample-app",
    source: "pinned",
  },
  {
    hasGit: false,
    hasPackageJson: false,
    name: "sample-docs",
    path: "C:/work/sample-docs",
    source: "recent",
  },
  {
    hasGit: true,
    hasPackageJson: false,
    name: "sample-tools",
    path: "C:/work/clients/sample-tools",
    source: "scan",
  },
];

function createDemoWorkspace(): PersistedWorkspace {
  const settings = {
    alwaysConfirmClose: false,
    defaultCommand: "claude" as const,
    notificationsEnabled: true,
    pinned: demoProjects
      .filter((project) => project.source === "pinned")
      .map((project) => project.path),
    // デモでも既定は無効。プレビューを触っただけで受付口が開く印象を
    // 与えないため、本体の既定値と揃える。
    remoteLaunchEnabled: false,
    scanRoots: ["C:/work", "C:/work/clients"],
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    tourCompleted: false,
  };

  if (new URLSearchParams(window.location.search).has("empty")) {
    return {
      activeTabId: "tab-demo",
      recent: [],
      savedPresets: [],
      sessions: [],
      settings,
      tabs: [
        {
          activePaneId: "pane-demo",
          id: "tab-demo",
          root: {
            id: "pane-demo",
            sessionId: null,
            type: "pane",
          },
          title: "New Session",
        },
      ],
      version: 1,
    };
  }

  return {
    activeTabId: "tab-demo",
    recent: [
      {
        command: "claude",
        cwd: demoProjects[0].path,
        lastUsedAt: Date.now(),
        projectName: "sample-web",
        title: "画面調整",
      },
      {
        command: "codex",
        cwd: demoProjects[3].path,
        lastUsedAt: Date.now() - 60_000,
        projectName: "sample-docs",
        title: "資料整理",
      },
    ],
    savedPresets: [],
    sessions: [
      {
        command: "claude",
        cwd: demoProjects[0].path,
        id: "session-web",
        projectName: "sample-web",
        shouldRestore: true,
        title: "画面調整",
      },
      {
        command: "codex",
        cwd: demoProjects[3].path,
        id: "session-docs",
        projectName: "sample-docs",
        shouldRestore: true,
        title: "資料整理",
      },
      {
        command: "claude",
        cwd: demoProjects[2].path,
        id: "session-app",
        projectName: "sample-app",
        shouldRestore: true,
        title: "機能追加",
      },
      {
        command: "powershell",
        cwd: demoProjects[1].path,
        id: "session-build",
        projectName: "sample-api",
        shouldRestore: false,
        title: "build-check",
      },
    ],
    settings,
    tabs: [
      {
        activePaneId: "pane-web",
        id: "tab-demo",
        root: {
          axis: "row",
          children: [
            {
              id: "pane-web",
              sessionId: "session-web",
              type: "pane",
            },
            {
              axis: "column",
              children: [
                {
                  id: "pane-docs",
                  sessionId: "session-docs",
                  type: "pane",
                },
                {
                  id: "pane-app",
                  sessionId: "session-app",
                  type: "pane",
                },
              ],
              id: "split-side",
              ratio: 0.5,
              type: "split",
            },
          ],
          id: "split-root",
          ratio: 0.58,
          type: "split",
        },
        title: "Today",
      },
    ],
    version: 1,
  };
}

function createDemoApi(): CockpitApi {
  const dataListeners = new Set<DataListener>();
  const statusListeners = new Set<StatusListener>();
  let workspace = createDemoWorkspace();

  const emitData = (event: PtyDataEvent): void => {
    for (const listener of dataListeners) {
      listener(event);
    }
  };

  const emitStatus = (event: PtyStatusEvent): void => {
    for (const listener of statusListeners) {
      listener(event);
    }
  };

  const welcome = (request: SpawnSessionRequest): void => {
    const commandLabel =
      request.command === "powershell" ? "PowerShell" : request.command;
    window.setTimeout(() => {
      emitData({
        data:
          `\u001b[38;2;245;166;35mCLI Cockpit\u001b[0m · ${commandLabel}\r\n` +
          `Working directory: ${request.cwd}\r\n\r\n` +
          (request.command === "powershell"
            ? `PS ${request.cwd}> `
            : "● Ready. What would you like to do?\r\n❯ "),
        sessionId: request.id,
      });
    }, 80);
  };

  const api: CockpitApi = {
    diagnosticLog: () => undefined,
    getAppVersion: async () => "0.1.7",
    getBootstrap: async (): Promise<BootstrapPayload> => ({
      projects: demoProjects,
      workspace,
    }),
    getPathForFile: () => "",
    killSession: async (sessionId) => {
      emitStatus({ sessionId, status: "exited", exitCode: 0 });
    },
    onGpuRecovered: () => () => undefined,
    onPtyData: (listener) => {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onPtyStatus: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    // デモには受付フォルダが無いので、何も届かないまま解除だけできる形にする。
    onRemoteLaunch: () => () => undefined,
    onUpdateAvailable: (listener) => {
      const preview = new URLSearchParams(window.location.search).get(
        "update",
      );
      if (preview === null) {
        return () => undefined;
      }

      const timer = window.setTimeout(() => {
        listener({
          downloadAvailable: preview !== "no-link",
          notes: "表示崩れを自動で直すようになりました",
          version: "0.1.8",
        });
      }, 120);
      return () => window.clearTimeout(timer);
    },
    openUpdateDownload: async () => true,
    pickProjectDirectory: async () => null,
    readClipboardForPaste: async () => ({
      kind: "empty",
    }),
    rescanProjects: async () => demoProjects,
    resizeSession: () => undefined,
    saveWorkspace: async (nextWorkspace) => {
      workspace = nextWorkspace;
    },
    showWaitingNotification: async () => undefined,
    spawnSession: async (request) => {
      const session: SessionState = {
        ...request,
        shouldRestore: true,
        startedAt: Date.now(),
        status: "idle",
      };
      welcome(request);
      return { session };
    },
    writeClipboardText: async () => undefined,
    writeSession: ({ data, sessionId }) => {
      if (data === "\r") {
        emitData({ data: "\r\n❯ ", sessionId });
        emitStatus({ sessionId, status: "idle" });
      } else {
        emitData({ data, sessionId });
      }
    },
  };

  for (const persisted of workspace.sessions.filter(
    (session) => session.shouldRestore,
  )) {
    welcome({
      ...persisted,
      cols: 100,
      rows: 30,
    });
  }

  window.setTimeout(() => {
    emitStatus({
      sessionId: "session-web",
      status: "busy",
    });
    emitStatus({
      sessionId: "session-docs",
      status: "waiting",
    });
    emitStatus({
      sessionId: "session-app",
      status: "idle",
    });
  }, 350);

  return api;
}

export const cockpitApi: CockpitApi = window.cockpit ?? createDemoApi();
