import {
  Bell,
  BellOff,
  CircleHelp,
  Download,
  Search,
  Settings,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assignSession,
  collectPanes,
  createTab,
  createTabRenderStates,
  findPane,
  findPaneBySession,
  getTabDisplayTitle,
  removePane,
  replaceSessionEverywhere,
  splitPane,
  updateSplitRatio,
} from "../shared/layout";
import {
  getDefaultSessionTitle,
  getProjectNameFromPath,
  normalizeWorkspaceSessionTitles,
  renameSessionTitle,
  sortPinnedFirst,
} from "../shared/session-labels";
import { closeSessionAfterHiding } from "../shared/session-lifecycle";
import {
  closeTabAfterTerminatingSessions,
  getRunningSessionIdsInTab,
} from "../shared/tab-lifecycle";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "../shared/types";

import { cockpitApi } from "./bridge";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HelpPanel } from "./components/HelpPanel";
import { LogoMark } from "./components/LogoMark";
import { PaneGrid } from "./components/PaneGrid";
import { SearchOverlay } from "./components/SearchOverlay";
import { Sidebar } from "./components/Sidebar";
import { StatusDot } from "./components/StatusDot";
import { TabBar } from "./components/TabBar";
import { TourOverlay } from "./components/TourOverlay";
import { terminalRegistry } from "./terminal-registry";

import type { LaunchInput } from "./components/Launcher";
import type {
  PersistedSession,
  PersistedWorkspace,
  ProjectCandidate,
  RemoteLaunchRequest,
  SessionState,
  SplitAxis,
  TabState,
  UpdateNotice,
} from "../shared/types";

function createId(prefix: "pane" | "session" | "split" | "tab"): string {
  return `${prefix}-${window.crypto.randomUUID()}`;
}

const DISMISSED_UPDATE_VERSION_STORAGE_KEY =
  "cockpit.dismissedUpdateVersion";
/** 出力がこの時間止まったら、CLI が入力待ちになったとみなす。 */
const REMOTE_PROMPT_QUIET_MS = 1_200;
/** 準備完了を待つ上限。起動に失敗した時に待ち続けないため。 */
const REMOTE_PROMPT_TIMEOUT_MS = 60_000;
/** 本文を送ってから改行を送るまでの間。 */
const REMOTE_PROMPT_SUBMIT_DELAY_MS = 150;

function toPersistedSession(session: SessionState): PersistedSession {
  return {
    command: session.command,
    cwd: session.cwd,
    id: session.id,
    projectName: session.projectName,
    shouldRestore:
      session.status !== "exited" && session.status !== "error",
    title: session.title,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "予期しないエラーが発生しました。";
}

function upsertSessions(
  current: SessionState[],
  additions: SessionState[],
): SessionState[] {
  const next = new Map(current.map((session) => [session.id, session]));
  for (const session of additions) {
    next.set(session.id, session);
  }
  return [...next.values()];
}

export function App() {
  const [appVersion, setAppVersion] = useState<string>();
  const [remoteLaunchInbox, setRemoteLaunchInbox] = useState<string>();
  const [availableUpdate, setAvailableUpdate] = useState<UpdateNotice>();
  const [confirmingSession, setConfirmingSession] =
    useState<SessionState | null>(null);
  const [confirmingTab, setConfirmingTab] = useState<{
    runningSessionCount: number;
    tabId: string;
  } | null>(null);
  const [closingSessionIds, setClosingSessionIds] = useState(
    () => new Set<string>(),
  );
  const [hydrated, setHydrated] = useState(false);
  const [launcherError, setLauncherError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [projects, setProjects] = useState<ProjectCandidate[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.innerWidth < 900,
  );
  const [tourOpen, setTourOpen] = useState(false);
  const [workspace, setWorkspace] = useState<PersistedWorkspace>();
  const notifiedWaiting = useRef(new Set<string>());
  const removedSessionIds = useRef(new Set<string>());
  const remoteLaunchHandlerRef = useRef<
    ((request: RemoteLaunchRequest) => Promise<void>) | undefined
  >(undefined);
  const sessionsRef = useRef<SessionState[]>([]);
  const workspaceRef = useRef<PersistedWorkspace | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const removeUpdateListener = cockpitApi.onUpdateAvailable((update) => {
      if (cancelled) {
        return;
      }

      let dismissedVersion: string | null = null;
      try {
        dismissedVersion = window.localStorage.getItem(
          DISMISSED_UPDATE_VERSION_STORAGE_KEY,
        );
      } catch {
        // 保存領域が使えない環境でも、更新のお知らせ自体は表示する。
      }

      if (dismissedVersion !== update.version) {
        setAvailableUpdate(update);
      }
    });

    void cockpitApi
      .getAppVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        // app.getVersion() の取得失敗だけでアプリ全体を止めない。
      });

    void cockpitApi
      .getRemoteLaunchInbox()
      .then((directory) => {
        if (!cancelled) {
          setRemoteLaunchInbox(directory);
        }
      })
      .catch(() => {
        // 取得できなくても設定画面は開ける。案内が出ないだけ。
      });

    return () => {
      cancelled = true;
      removeUpdateListener();
    };
  }, []);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Enter の割り当てをターミナル側へ伝える。開いているペインにも即座に効く。
  useEffect(() => {
    terminalRegistry.setEnterRole(
      workspace?.settings.enterInsertsNewline ? "newline" : "submit",
    );
  }, [workspace?.settings.enterInsertsNewline]);

  useEffect(() => {
    let cancelled = false;

    const removeDataListener = cockpitApi.onPtyData((event) => {
      if (removedSessionIds.current.has(event.sessionId)) {
        return;
      }
      terminalRegistry.write(event.sessionId, event.data);
    });
    // redrawAll 自体が「間を置いてもう一度」まで面倒を見るので、
    // ここでは呼ぶだけでよい（手動の Ctrl+Shift+R と同じ経路）。
    const removeGpuRecoveredListener = cockpitApi.onGpuRecovered(() => {
      terminalRegistry.redrawAll();
    });
    const removeStatusListener = cockpitApi.onPtyStatus((event) => {
      if (removedSessionIds.current.has(event.sessionId)) {
        return;
      }
      setSessions((current) =>
        current.map((session) =>
          session.id === event.sessionId
            ? {
                ...session,
                exitCode: event.exitCode ?? session.exitCode,
                shouldRestore:
                  event.status !== "exited" && event.status !== "error",
                status: event.status,
              }
            : session,
        ),
      );

      if (event.status === "waiting") {
        if (!notifiedWaiting.current.has(event.sessionId)) {
          notifiedWaiting.current.add(event.sessionId);
          const currentWorkspace = workspaceRef.current;
          const session = sessionsRef.current.find(
            (item) => item.id === event.sessionId,
          );
          if (currentWorkspace?.settings.notificationsEnabled && session) {
            void cockpitApi.showWaitingNotification(
              session.id,
              `${session.projectName} · ${session.title}`,
            );
          }
        }
      } else {
        notifiedWaiting.current.delete(event.sessionId);
      }
    });

    // 受付フォルダに置かれた依頼。ここで直接 launchFromRemoteRequest を
    // 呼ぶと、購読した時点の古い state を掴んだままになるため、ref 越しに
    // 最新の実装を呼ぶ。
    const removeRemoteLaunchListener = cockpitApi.onRemoteLaunch((request) => {
      void remoteLaunchHandlerRef.current?.(request);
    });

    void cockpitApi
      .getBootstrap()
      .then(async (payload) => {
        if (cancelled) {
          return;
        }

        const loadedWorkspace = normalizeWorkspaceSessionTitles(
          payload.workspace,
        );
        setProjects(payload.projects);
        setWorkspace(loadedWorkspace);
        workspaceRef.current = loadedWorkspace;
        setTourOpen(!loadedWorkspace.settings.tourCompleted);

        const initialSessions: SessionState[] = loadedWorkspace.sessions.map(
          (session) => ({
            ...session,
            startedAt: Date.now(),
            status: session.shouldRestore ? "idle" : "exited",
          }),
        );
        setSessions(initialSessions);
        for (const session of initialSessions) {
          terminalRegistry.ensure(session.id);
        }
        setHydrated(true);

        const restored: SessionState[] = [];
        for (const session of loadedWorkspace.sessions.filter(
          (item) => item.shouldRestore,
        )) {
          try {
            const result = await cockpitApi.spawnSession({
              ...session,
              cols: 100,
              rows: 30,
            });
            restored.push(result.session);
          } catch (error: unknown) {
            restored.push({
              ...session,
              shouldRestore: false,
              startedAt: Date.now(),
              status: "error",
            });
            setNotice(
              `${session.title} を復元できませんでした: ${getErrorMessage(error)}`,
            );
          }
        }

        if (!cancelled && restored.length > 0) {
          setSessions((current) => upsertSessions(current, restored));
        }
      })
      .catch((error: unknown) => {
        setLauncherError(getErrorMessage(error));
        setHydrated(true);
      });

    return () => {
      cancelled = true;
      removeDataListener();
      removeGpuRecoveredListener();
      removeStatusListener();
      removeRemoteLaunchListener();
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !workspace) {
      return;
    }

    const timer = window.setTimeout(() => {
      void cockpitApi
        .saveWorkspace({
          ...workspace,
          sessions: sessions.map(toPersistedSession),
        })
        .catch((error: unknown) => {
          setNotice(`状態を保存できませんでした: ${getErrorMessage(error)}`);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [hydrated, sessions, workspace]);

  useEffect(() => {
    const liveIds = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      terminalRegistry.ensure(session.id);
    }

    return () => {
      if (workspaceRef.current === undefined) {
        for (const id of liveIds) {
          terminalRegistry.remove(id);
        }
      }
    };
  }, [sessions]);

  const activeTab = useMemo(
    () => workspace?.tabs.find((tab) => tab.id === workspace.activeTabId),
    [workspace],
  );
  const activePane = activeTab
    ? findPane(activeTab.root, activeTab.activePaneId)
    : undefined;
  const activeSession =
    sessions.find((session) => session.id === activePane?.sessionId) ?? null;
  const tabRenderStates = useMemo(
    () =>
      workspace
        ? createTabRenderStates(workspace.tabs, workspace.activeTabId)
        : [],
    [workspace],
  );
  const displayTabs = useMemo(
    () =>
      workspace?.tabs.map((tab) => ({
        ...tab,
        title: getTabDisplayTitle(tab, sessions),
      })) ?? [],
    [sessions, workspace],
  );
  const pinnedProjects = projects.filter(
    (project) => project.source === "pinned",
  );

  const updateTab = (
    tabId: string,
    updater: (tab: TabState) => TabState,
  ): void => {
    setWorkspace((current) =>
      current
        ? {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === tabId ? updater(tab) : tab,
            ),
          }
        : current,
    );
  };

  const newTab = (): void => {
    const tab = createTab(
      (prefix) => createId(prefix),
      "New Session",
    );
    setWorkspace((current) =>
      current
        ? {
            ...current,
            activeTabId: tab.id,
            tabs: [...current.tabs, tab],
          }
        : current,
    );
    setLauncherError(undefined);
  };

  const removeTab = (tabId: string): void => {
    setWorkspace((current) => {
      if (!current) {
        return current;
      }

      const closingIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      const remaining = current.tabs.filter((tab) => tab.id !== tabId);
      if (remaining.length === 0) {
        const replacement = createTab((prefix) => createId(prefix));
        return {
          ...current,
          activeTabId: replacement.id,
          tabs: [replacement],
        };
      }

      const nextActive =
        current.activeTabId === tabId
          ? remaining[Math.max(0, closingIndex - 1)]?.id ?? remaining[0].id
          : current.activeTabId;
      return {
        ...current,
        activeTabId: nextActive,
        tabs: remaining,
      };
    });
  };

  const closeTab = async (tabId: string): Promise<void> => {
    setConfirmingTab(null);
    const currentWorkspace = workspaceRef.current;
    const tab = currentWorkspace?.tabs.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    try {
      await closeTabAfterTerminatingSessions({
        killSession: cockpitApi.killSession,
        onClose: (terminatedSessionIds) => {
          // タブ×で閉じたら、中の全セッションを kill した上でサイドバーの
          // 一覧からも完全に除去する（terminalRegistry・sessions・ペインすべて）。
          // exited として残すと「消したのに残る」違和感＋残骸をクリックできても
          // ペインが無いので選択できない不具合になるため、残骸を残さない。
          for (const sessionId of terminatedSessionIds) {
            removeSession(sessionId);
          }
          removeTab(tabId);
        },
        sessions: sessionsRef.current,
        tab,
      });
    } catch (error: unknown) {
      setNotice(`タブを閉じられませんでした: ${getErrorMessage(error)}`);
    }
  };

  const requestCloseTab = (tabId: string): void => {
    const currentWorkspace = workspaceRef.current;
    const tab = currentWorkspace?.tabs.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    const runningSessionCount = getRunningSessionIdsInTab(
      tab,
      sessionsRef.current,
    ).length;
    if (runningSessionCount > 0) {
      setConfirmingTab({
        runningSessionCount,
        tabId,
      });
      return;
    }

    void closeTab(tabId);
  };

  const selectSession = (sessionId: string): void => {
    setWorkspace((current) => {
      if (!current) {
        return current;
      }

      for (const tab of current.tabs) {
        const pane = findPaneBySession(tab.root, sessionId);
        if (pane) {
          return {
            ...current,
            activeTabId: tab.id,
            tabs: current.tabs.map((candidate) =>
              candidate.id === tab.id
                ? { ...candidate, activePaneId: pane.id }
                : candidate,
            ),
          };
        }
      }

      return {
        ...current,
        tabs: current.tabs.map((tab) => {
          if (tab.id !== current.activeTabId) {
            return tab;
          }
          const withoutDuplicate = replaceSessionEverywhere(tab.root, sessionId);
          return {
            ...tab,
            root: assignSession(
              withoutDuplicate,
              tab.activePaneId,
              sessionId,
            ),
          };
        }),
      };
    });
  };

  /**
   * セッションを起動し、そのセッション ID を返す。
   *
   * ID を返すのは、起動直後に続けて操作したい呼び出し元（受付フォルダ
   * 経由の起動など）のため。state の反映を待って探し直すと、まだ
   * 書き込まれていないタイミングで空振りする。
   */
  const startSession = async (
    tabId: string,
    paneId: string,
    input: LaunchInput,
  ): Promise<string | undefined> => {
    if (!workspaceRef.current) {
      return undefined;
    }

    const title = input.title || getDefaultSessionTitle(input.command);
    const request = {
      cols: 100,
      command: input.command,
      cwd: input.cwd,
      id: createId("session"),
      projectName: input.projectName,
      rows: 30,
      title,
    };

    setLauncherError(undefined);
    try {
      const result = await cockpitApi.spawnSession(request);
      terminalRegistry.ensure(result.session.id);
      setSessions((current) => upsertSessions(current, [result.session]));
      setWorkspace((current) => {
        if (!current) {
          return current;
        }

        const recent = [
          {
            command: result.session.command,
            cwd: result.session.cwd,
            lastUsedAt: Date.now(),
            projectName: result.session.projectName,
            title: result.session.title,
          },
          ...current.recent.filter(
            (item) =>
              !(
                item.cwd.toLocaleLowerCase("en-US") ===
                  result.session.cwd.toLocaleLowerCase("en-US") &&
                item.command === result.session.command &&
                item.title === result.session.title
              ),
          ),
        ].slice(0, 20);

        return {
          ...current,
          recent,
          tabs: current.tabs.map((tab) => {
            if (tab.id !== tabId) {
              return tab;
            }
            const updatedRoot = assignSession(
              tab.root,
              paneId,
              result.session.id,
            );
            return {
              ...tab,
              activePaneId: paneId,
              root: updatedRoot,
              title:
                collectPanes(updatedRoot).length === 1
                  ? result.session.title
                  : tab.title,
            };
          }),
        };
      });

      setProjects((current) => {
        const existing = current.find(
          (project) =>
            project.path.toLocaleLowerCase("en-US") ===
            input.cwd.toLocaleLowerCase("en-US"),
        );
        if (existing) {
          return current;
        }
        return [
          {
            hasGit: false,
            hasPackageJson: false,
            name: input.projectName,
            path: input.cwd,
            source: "recent",
          },
          ...current,
        ];
      });

      return result.session.id;
    } catch (error: unknown) {
      setLauncherError(getErrorMessage(error));
      return undefined;
    }
  };

  /**
   * 受付フォルダに置かれた依頼から、新しいタブでセッションを起動する。
   *
   * 外出先から「この案件で作業を始めておいて」を受け取るための入口。
   * Remote Control が有効なら起動した時点でスマホ／ブラウザ側に現れ、
   * 帰宅後は Cockpit のペインとしてそのまま続きを触れる。
   *
   * 起動するコマンドは依頼では指定させず、常に `claude` を使う。
   * 受付フォルダに書けることが任意コマンド実行と同義になるのを避ける。
   */
  const launchFromRemoteRequest = async (
    request: RemoteLaunchRequest,
  ): Promise<void> => {
    const projectName = getProjectNameFromPath(request.cwd);
    const tab = createTab(
      (prefix) => createId(prefix),
      request.title || projectName,
    );

    setWorkspace((current) =>
      current
        ? {
            ...current,
            activeTabId: tab.id,
            tabs: [...current.tabs, tab],
          }
        : current,
    );

    const sessionId = await startSession(tab.id, tab.activePaneId, {
      command: "claude",
      cwd: request.cwd,
      projectName,
      title: request.title || projectName,
    });

    if (!sessionId) {
      setNotice("受け取った依頼を起動できませんでした");
      return;
    }

    setNotice(
      `受け取った依頼から「${request.title || projectName}」を起動しました`,
    );

    if (request.prompt !== undefined) {
      await deliverRemotePrompt(sessionId, request.prompt);
    }
  };

  /**
   * 起動した CLI へ最初の指示を流し込む。
   *
   * spawn 直後に書くと、シェルの初期化や CLI 本体の起動が終わる前に
   * 送られて捨てられる。CLI が入力を受け付けられる状態になるのを、
   * 出力が落ち着いたかどうかで判断する。「起動したはずなのに指示だけ
   * 消えている」が最も分かりにくい失敗なので、諦めるまでの上限も置く。
   */
  const deliverRemotePrompt = async (
    sessionId: string,
    prompt: string,
  ): Promise<void> => {
    const ready = await terminalRegistry.waitForOutputToSettle(sessionId, {
      quietMs: REMOTE_PROMPT_QUIET_MS,
      timeoutMs: REMOTE_PROMPT_TIMEOUT_MS,
    });
    if (!ready) {
      setNotice(
        "起動しましたが、CLI の準備が確認できなかったため指示は送っていません",
      );
      return;
    }

    // 本文と改行を分けて送る。まとめて送ると、CLI 側が本文を受け取り
    // きる前に改行を処理して、途中までの文字列で送信されることがある。
    cockpitApi.writeSession({ data: prompt, sessionId });
    window.setTimeout(() => {
      cockpitApi.writeSession({ data: "\r", sessionId });
    }, REMOTE_PROMPT_SUBMIT_DELAY_MS);
  };

  // 購読は初回だけ行うため、実体は ref 越しに最新へ差し替える。
  // レンダー中に書くと React の規約に反するので effect で更新する。
  useEffect(() => {
    remoteLaunchHandlerRef.current = launchFromRemoteRequest;
  });

  const restartSession = async (session: SessionState): Promise<void> => {
    try {
      const result = await cockpitApi.spawnSession({
        cols: 100,
        command: session.command,
        cwd: session.cwd,
        id: session.id,
        projectName: session.projectName,
        rows: 30,
        title: session.title,
      });
      setSessions((current) => upsertSessions(current, [result.session]));
      selectSession(session.id);
    } catch (error: unknown) {
      setNotice(`再起動できませんでした: ${getErrorMessage(error)}`);
    }
  };

  const renameSession = (sessionId: string, title: string): void => {
    setSessions((current) =>
      renameSessionTitle(current, sessionId, title),
    );
  };

  const killSession = async (session: SessionState): Promise<void> => {
    setConfirmingSession(null);
    try {
      await closeSessionAfterHiding({
        killSession: cockpitApi.killSession,
        onClosingChange: (sessionId, closing) => {
          terminalRegistry.setVisible(sessionId, !closing);
          setClosingSessionIds((current) => {
            const next = new Set(current);
            if (closing) {
              next.add(sessionId);
            } else {
              next.delete(sessionId);
            }
            return next;
          });
        },
        onRemove: removeSession,
        sessionId: session.id,
      });
    } catch (error: unknown) {
      setNotice(`終了できませんでした: ${getErrorMessage(error)}`);
    }
  };

  const requestCloseSession = (session: SessionState): void => {
    if (
      session.status === "busy" ||
      workspace?.settings.alwaysConfirmClose
    ) {
      setConfirmingSession(session);
      return;
    }
    void killSession(session);
  };

  const removeSession = (sessionId: string): void => {
    removedSessionIds.current.add(sessionId);
    terminalRegistry.remove(sessionId);
    setSessions((current) =>
      current.filter((session) => session.id !== sessionId),
    );
    setWorkspace((current) => {
      if (!current) {
        return current;
      }

      // 閉じたセッションが入っていたタブだけを対象にする。これを見ずに
      // 「空のタブ」を一律で消すと、利用者が + で開いたばかりの起動前の
      // タブまで巻き込んで消してしまう。
      const affectedTabIds = new Set(
        current.tabs
          .filter((tab) => findPaneBySession(tab.root, sessionId))
          .map((tab) => tab.id),
      );

      // ペインの構造はそのまま残す。分割して使っている最中に片方を閉じても
      // 配置が勝手に変わらないようにするため（空いたペインには、そのまま
      // 次のセッションを入れられる）。
      const cleared = current.tabs.map((tab) => ({
        ...tab,
        root: replaceSessionEverywhere(tab.root, sessionId),
      }));

      // ただし、中身が 1 つも無くなったタブは閉じる。残しておくと
      // 「New Session」の空タブが溜まり、タブ帯を埋めてしまう。
      const isEmpty = (tab: TabState): boolean =>
        affectedTabIds.has(tab.id) &&
        collectPanes(tab.root).every((pane) => pane.sessionId === null);
      const remaining = cleared.filter((tab) => !isEmpty(tab));

      // 全部空になったら、まっさらな 1 枚だけを残す（タブ 0 枚にはしない）。
      if (remaining.length === 0) {
        const replacement = createTab((prefix) => createId(prefix));
        return {
          ...current,
          activeTabId: replacement.id,
          tabs: [replacement],
        };
      }

      // 閉じたのが選択中のタブだったときは、その手前へ移る。
      const closingIndex = cleared.findIndex((tab) => isEmpty(tab));
      const activeTabId = remaining.some((tab) => tab.id === current.activeTabId)
        ? current.activeTabId
        : remaining[Math.max(0, closingIndex - 1)]?.id ?? remaining[0].id;

      return { ...current, activeTabId, tabs: remaining };
    });
  };

  const launchPinned = async (): Promise<void> => {
    if (!workspace) {
      return;
    }

    const launched: SessionState[] = [];
    const tabs: TabState[] = [];
    const errors: string[] = [];

    for (const project of pinnedProjects) {
      const sessionId = createId("session");
      const tab = createTab((prefix) => createId(prefix), project.name);
      const request = {
        cols: 100,
        command: workspace.settings.defaultCommand,
        cwd: project.path,
        id: sessionId,
        projectName: project.name,
        rows: 30,
        title: getDefaultSessionTitle(workspace.settings.defaultCommand),
      };

      try {
        const result = await cockpitApi.spawnSession(request);
        launched.push(result.session);
        tabs.push({
          ...tab,
          root: assignSession(tab.root, tab.activePaneId, sessionId),
        });
      } catch (error: unknown) {
        errors.push(`${project.name}: ${getErrorMessage(error)}`);
      }
    }

    if (launched.length > 0) {
      setSessions((current) => upsertSessions(current, launched));
      setWorkspace((current) =>
        current
          ? {
              ...current,
              activeTabId: tabs[0].id,
              recent: [
                ...launched.map((session) => ({
                  command: session.command,
                  cwd: session.cwd,
                  lastUsedAt: Date.now(),
                  projectName: session.projectName,
                  title: session.title,
                })),
                ...current.recent,
              ].slice(0, 20),
              tabs: [...current.tabs, ...tabs],
            }
          : current,
      );
    }
    if (errors.length > 0) {
      setNotice(`一部を起動できませんでした: ${errors.join(" / ")}`);
    }
  };

  const togglePin = (path: string): void => {
    if (!path) {
      return;
    }

    setWorkspace((current) => {
      if (!current) {
        return current;
      }
      const normalized = path.toLocaleLowerCase("en-US");
      const exists = current.settings.pinned.some(
        (item) => item.toLocaleLowerCase("en-US") === normalized,
      );
      return {
        ...current,
        settings: {
          ...current.settings,
          // 新しいピン留めは末尾に足す。先頭に足すと、留めるたびに並びが
          // 入れ替わり、「留めたはずの場所が先頭から消える」ことになる。
          // 利用者からは保存されていないように見えてしまう。
          pinned: exists
            ? current.settings.pinned.filter(
                (item) => item.toLocaleLowerCase("en-US") !== normalized,
              )
            : [...current.settings.pinned, path],
        },
      };
    });

    setProjects((current) => {
      const normalized = path.toLocaleLowerCase("en-US");
      const exists = current.find(
        (project) =>
          project.path.toLocaleLowerCase("en-US") === normalized,
      );
      if (!exists) {
        const cleanPath = path.replaceAll("\\", "/").replace(/\/+$/u, "");
        const added = {
          hasGit: false,
          hasPackageJson: false,
          name: cleanPath.split("/").at(-1) || "Pinned folder",
          path,
          source: "pinned" as const,
        };
        // 先頭ではなくピン留め群の末尾に置く。先頭に入れると、留めるたびに
        // 既存のピン留めが押し下げられて並びが安定しない。
        return sortPinnedFirst([...current, added]);
      }

      // source を書き換えるだけでは並びが変わらない。ピン留めしたのに
      // 一覧の途中に居座ったままになり、「留めたのに効かない」と映る。
      // 実際に留めた項目をピン留め群の末尾へ動かし、解除したものは
      // ピン留め群の外へ出す。
      const updated: ProjectCandidate[] = current.map((project) =>
        project.path.toLocaleLowerCase("en-US") === normalized
          ? {
              ...project,
              source:
                project.source === "pinned"
                  ? ("scan" as const)
                  : ("pinned" as const),
            }
          : project,
      );
      return sortPinnedFirst(updated);
    });
  };

  const rescan = async (): Promise<void> => {
    try {
      const currentWorkspace = workspaceRef.current;
      if (currentWorkspace) {
        await cockpitApi.saveWorkspace({
          ...currentWorkspace,
          sessions: sessionsRef.current.map(toPersistedSession),
        });
      }
      setProjects(await cockpitApi.rescanProjects());
    } catch (error: unknown) {
      setNotice(`再スキャンできませんでした: ${getErrorMessage(error)}`);
    }
  };

  const resizeSidebar = (width: number): void => {
    const nextWidth = Math.round(
      Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)),
    );
    setWorkspace((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              sidebarWidth: nextWidth,
            },
          }
        : current,
    );
  };

  const completeTour = useCallback((): void => {
    setTourOpen(false);
    setWorkspace((current) =>
      current
        ? {
            ...current,
            settings: {
              ...current.settings,
              tourCompleted: true,
            },
          }
        : current,
    );
  }, []);

  const showTour = (): void => {
    setSearchOpen(false);
    setSettingsOpen(false);
    setTourOpen(true);
  };

  const dismissUpdate = (): void => {
    if (!availableUpdate) {
      return;
    }

    try {
      window.localStorage.setItem(
        DISMISSED_UPDATE_VERSION_STORAGE_KEY,
        availableUpdate.version,
      );
    } catch {
      // 保存できなくても、この起動中は閉じられるよう表示状態を先に進める。
    }
    setAvailableUpdate(undefined);
  };

  const openUpdateDownload = async (): Promise<void> => {
    let opened = false;
    try {
      opened = await cockpitApi.openUpdateDownload();
    } catch {
      // OS 側で開けなかった場合も、作業中の CLI には影響させない。
    }
    if (!opened) {
      setNotice(
        "ダウンロード先を開けませんでした。Google Drive の「CLI Cockpit」配布フォルダを確認してください。",
      );
    }
  };

  const focusPaneDirection = (
    direction: "left" | "right" | "up" | "down",
  ): void => {
    if (!activeTab) {
      return;
    }

    const activePanel = document.querySelector<HTMLElement>(
      '[data-active-tab-panel="true"]',
    );
    const elements = activePanel
      ? [...activePanel.querySelectorAll<HTMLElement>("[data-pane-id]")]
      : [];
    const current = elements.find(
      (element) => element.dataset.paneId === activeTab.activePaneId,
    );
    if (!current) {
      return;
    }

    const currentRect = current.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + currentRect.width / 2,
      y: currentRect.top + currentRect.height / 2,
    };

    const candidates = elements
      .filter((element) => element !== current)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const center = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        const inDirection =
          direction === "left"
            ? center.x < currentCenter.x
            : direction === "right"
              ? center.x > currentCenter.x
              : direction === "up"
                ? center.y < currentCenter.y
                : center.y > currentCenter.y;
        const primary =
          direction === "left" || direction === "right"
            ? Math.abs(center.x - currentCenter.x)
            : Math.abs(center.y - currentCenter.y);
        const secondary =
          direction === "left" || direction === "right"
            ? Math.abs(center.y - currentCenter.y)
            : Math.abs(center.x - currentCenter.x);
        return {
          element,
          inDirection,
          score: primary + secondary * 0.4,
        };
      })
      .filter((candidate) => candidate.inDirection)
      .sort((left, right) => left.score - right.score);

    const paneId = candidates[0]?.element.dataset.paneId;
    if (paneId) {
      updateTab(activeTab.id, (tab) => ({ ...tab, activePaneId: paneId }));
    }
  };

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent): void => {
      if (tourOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          completeTour();
          return;
        }

        const target = event.target;
        if (
          !(
            target instanceof window.HTMLElement &&
            target.closest(".tour-overlay")
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      // ヘルプはワークスペースの状態に関係なく開けるようにする。
      // 表示が崩れて操作に迷っているときこそ開きたいため。
      if (event.key === "F1") {
        event.preventDefault();
        setHelpOpen((value) => !value);
        return;
      }
      if (event.key === "Escape" && helpOpen) {
        event.preventDefault();
        setHelpOpen(false);
        return;
      }

      if (!workspace || !activeTab) {
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        newTab();
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        requestCloseTab(workspace.activeTabId);
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const result = splitPane(
          activeTab.root,
          activeTab.activePaneId,
          "row",
          (prefix) => createId(prefix),
        );
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          activePaneId: result.activePaneId,
          root: result.root,
        }));
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        const result = splitPane(
          activeTab.root,
          activeTab.activePaneId,
          "column",
          (prefix) => createId(prefix),
        );
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          activePaneId: result.activePaneId,
          root: result.root,
        }));
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      // 表示が壊れた（文字が出ない・欠ける）時の手動回復。グリフの
      // テクスチャアトラスを作り直して全ペインを描き直す。CLI へ入力は
      // 送らないので、実行中の作業を邪魔しない。
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        terminalRegistry.redrawAll();
        return;
      }
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        const index = workspace.tabs.findIndex(
          (tab) => tab.id === workspace.activeTabId,
        );
        const offset = event.shiftKey ? -1 : 1;
        const nextIndex =
          (index + offset + workspace.tabs.length) % workspace.tabs.length;
        setWorkspace((current) =>
          current
            ? { ...current, activeTabId: current.tabs[nextIndex].id }
            : current,
        );
        return;
      }
      if (event.altKey && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const direction = event.key.replace("Arrow", "").toLowerCase();
        if (
          direction === "left" ||
          direction === "right" ||
          direction === "up" ||
          direction === "down"
        ) {
          focusPaneDirection(direction);
        }
      }
    };

    window.addEventListener("keydown", handleKeyboard, true);
    return () => window.removeEventListener("keydown", handleKeyboard, true);
  }, [activeTab, completeTour, helpOpen, tourOpen, workspace]);

  if (!hydrated || !workspace || !activeTab) {
    return (
      <div className="loading-screen">
        <LogoMark className="loading-logo" />
        <span>CLI Cockpit を初期化しています…</span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="title-bar">
        <div className="drag-region">
          <span className="title-wordmark">CLI Cockpit</span>
          <span className="local-badge">
            <ShieldCheck aria-hidden="true" size={12} />
            LOCAL ONLY
          </span>
        </div>
        <div className="title-actions">
          <button
            aria-label="全ペイン検索"
            onClick={() => setSearchOpen(true)}
            title="検索 (Ctrl+Shift+F)"
            type="button"
          >
            <Search aria-hidden="true" size={15} />
          </button>
          <button
            aria-label="使い方とショートカット"
            onClick={() => setHelpOpen(true)}
            title="使い方とショートカット (F1)"
            type="button"
          >
            <CircleHelp aria-hidden="true" size={15} />
          </button>
          <button
            aria-label={
              workspace.settings.notificationsEnabled
                ? "入力待ち通知をオフ"
                : "入力待ち通知をオン"
            }
            className={
              workspace.settings.notificationsEnabled ? "is-enabled" : ""
            }
            onClick={() =>
              setWorkspace((current) =>
                current
                  ? {
                      ...current,
                      settings: {
                        ...current.settings,
                        notificationsEnabled:
                          !current.settings.notificationsEnabled,
                      },
                    }
                  : current,
              )
            }
            title="入力待ち通知"
            type="button"
          >
            {workspace.settings.notificationsEnabled ? (
              <Bell aria-hidden="true" size={15} />
            ) : (
              <BellOff aria-hidden="true" size={15} />
            )}
          </button>
          <button
            aria-expanded={settingsOpen}
            aria-label="設定"
            data-tour-target="settings"
            onClick={() => setSettingsOpen((value) => !value)}
            title="設定"
            type="button"
          >
            <Settings aria-hidden="true" size={15} />
          </button>
        </div>
        {settingsOpen && (
          <div className="settings-popover">
            <div className="settings-app-version">
              <div>
                <strong>CLI Cockpit</strong>
                <span>現在のバージョン</span>
              </div>
              <b>{appVersion ? `v${appVersion}` : "確認中…"}</b>
            </div>
            <span>SESSION SAFETY</span>
            <label>
              <input
                checked={workspace.settings.alwaysConfirmClose}
                onChange={(event) =>
                  setWorkspace((current) =>
                    current
                      ? {
                          ...current,
                          settings: {
                            ...current.settings,
                            alwaysConfirmClose: event.target.checked,
                          },
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
              終了時に常に確認する
            </label>
            <p>busy中の終了確認は常に有効です。</p>
            <span>KEYS</span>
            <label>
              <input
                checked={workspace.settings.enterInsertsNewline}
                onChange={(event) =>
                  setWorkspace((current) =>
                    current
                      ? {
                          ...current,
                          settings: {
                            ...current.settings,
                            enterInsertsNewline: event.target.checked,
                          },
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
              Enter で改行する
            </label>
            <p>
              送信は Shift+Enter になります。チャット欄と同じ感覚で書けます。
              この設定は Cockpit の中だけで効き、CLI の設定ファイルは
              変更しません。
            </p>
            <span>REMOTE LAUNCH</span>
            <label>
              <input
                checked={workspace.settings.remoteLaunchEnabled}
                onChange={(event) =>
                  setWorkspace((current) =>
                    current
                      ? {
                          ...current,
                          settings: {
                            ...current.settings,
                            remoteLaunchEnabled: event.target.checked,
                          },
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
              受け取った依頼でセッションを起動する
            </label>
            <p>
              inbox フォルダに置かれた依頼から Claude を起動します。
              ネットワークは開きませんが、そのフォルダに書ける相手に
              この PC で作業を実行させることになります。
            </p>
            {remoteLaunchInbox && (
              <div className="settings-inbox">
                <code>{remoteLaunchInbox}</code>
                <button
                  onClick={() => {
                    void cockpitApi.writeClipboardText(remoteLaunchInbox);
                    setNotice("受付フォルダのパスをコピーしました");
                  }}
                  type="button"
                >
                  パスをコピー
                </button>
              </div>
            )}
            <button
              className="settings-tour-button"
              onClick={showTour}
              type="button"
            >
              <CircleHelp aria-hidden="true" size={14} />
              使い方ツアーを見る
            </button>
          </div>
        )}
      </header>

      {availableUpdate && (
        <aside
          aria-label="更新のお知らせ"
          aria-live="polite"
          className="update-banner"
          data-testid="update-banner"
        >
          <span className="update-banner-eyebrow">UPDATE AVAILABLE</span>
          <h2>v{availableUpdate.version} が利用できます</h2>
          <p>{availableUpdate.notes}</p>
          {!availableUpdate.downloadAvailable && (
            <p className="update-banner-fallback">
              Google Drive の「CLI Cockpit」配布フォルダから手動で更新してください。
            </p>
          )}
          <div className="update-banner-actions">
            {availableUpdate.downloadAvailable && (
              <button
                className="update-download-button"
                onClick={() => void openUpdateDownload()}
                type="button"
              >
                <Download aria-hidden="true" size={14} />
                ダウンロード
              </button>
            )}
            <button
              className="update-dismiss-button"
              onClick={dismissUpdate}
              type="button"
            >
              このバージョンは通知しない
            </button>
          </div>
        </aside>
      )}

      <div className="workspace-shell">
        <Sidebar
          activeSessionId={activeSession?.id ?? null}
          collapsed={sidebarCollapsed}
          onCloseSession={requestCloseSession}
          onLaunchPinned={launchPinned}
          onNewSession={newTab}
          onRemoveSession={removeSession}
          onRenameSession={renameSession}
          onRestartSession={restartSession}
          onResize={resizeSidebar}
          onSelectSession={selectSession}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          pinnedProjects={pinnedProjects}
          sessions={sessions}
          width={workspace.settings.sidebarWidth}
        />

        <main className="main-stage">
          <div className="session-toolbar">
            <div className="active-session-summary">
              {activeSession ? (
                <>
                  <StatusDot status={activeSession.status} />
                  <TerminalSquare aria-hidden="true" size={15} />
                  <strong>
                    {activeSession.projectName} · {activeSession.title}
                  </strong>
                  <span>{activeSession.cwd}</span>
                </>
              ) : (
                <>
                  <span className="toolbar-empty-mark">+</span>
                  <strong>New Session</strong>
                  <span>案件とCLIを選択してください</span>
                </>
              )}
            </div>
            <span className="pane-count">
              {collectPanes(activeTab.root).length} PANE
              {collectPanes(activeTab.root).length === 1 ? "" : "S"}
            </span>
          </div>

          <TabBar
            activeTabId={workspace.activeTabId}
            onActivate={(tabId) =>
              setWorkspace((current) =>
                current ? { ...current, activeTabId: tabId } : current,
              )
            }
            onClose={requestCloseTab}
            onNew={newTab}
            tabs={displayTabs}
          />

          <div className="pane-stage">
            {tabRenderStates.map(({ active, tab }) => (
              <div
                aria-hidden={!active}
                aria-labelledby={`tab-${tab.id}`}
                className="tab-panel"
                data-active-tab-panel={active ? "true" : undefined}
                data-tab-panel-id={tab.id}
                hidden={!active}
                id={`tab-panel-${tab.id}`}
                key={tab.id}
                role="tabpanel"
              >
                <PaneGrid
                  activePaneId={tab.activePaneId}
                  closingSessionIds={closingSessionIds}
                  launcherError={active ? launcherError : undefined}
                  node={tab.root}
                  onActivatePane={(paneId) =>
                    updateTab(tab.id, (currentTab) => ({
                      ...currentTab,
                      activePaneId: paneId,
                    }))
                  }
                  onClosePane={(paneId) => {
                    updateTab(tab.id, (currentTab) => {
                      const root = removePane(currentTab.root, paneId);
                      if (!root) {
                        return currentTab;
                      }
                      return {
                        ...currentTab,
                        activePaneId:
                          collectPanes(root)[0]?.id ??
                          currentTab.activePaneId,
                        root,
                      };
                    });
                  }}
                  onRescan={rescan}
                  onResizeSplit={(splitId, ratio) =>
                    updateTab(tab.id, (currentTab) => ({
                      ...currentTab,
                      root: updateSplitRatio(
                        currentTab.root,
                        splitId,
                        ratio,
                      ),
                    }))
                  }
                  onSplitPane={(paneId, axis: SplitAxis) => {
                    updateTab(tab.id, (currentTab) => {
                      const result = splitPane(
                        currentTab.root,
                        paneId,
                        axis,
                        (prefix) => createId(prefix),
                      );
                      return {
                        ...currentTab,
                        activePaneId: result.activePaneId,
                        root: result.root,
                      };
                    });
                  }}
                  onStart={async (paneId, input) => {
                    await startSession(tab.id, paneId, input);
                  }}
                  onTogglePin={togglePin}
                  paneCount={collectPanes(tab.root).length}
                  projects={projects}
                  recent={workspace.recent}
                  sessions={sessions}
                  settings={workspace.settings}
                  tabActive={active}
                />
              </div>
            ))}
          </div>
        </main>
      </div>

      {searchOpen && (
        <SearchOverlay
          onClose={() => setSearchOpen(false)}
          onSelectSession={selectSession}
          sessions={sessions}
        />
      )}
      {helpOpen && (
        <HelpPanel
          onClose={() => setHelpOpen(false)}
          version={appVersion}
        />
      )}
      {confirmingSession && (
        <ConfirmDialog
          description={`${confirmingSession.projectName} · ${confirmingSession.title} は実行中です。PTYプロセスを終了しますか？`}
          onCancel={() => setConfirmingSession(null)}
          onConfirm={() => void killSession(confirmingSession)}
          title="実行中のセッションを終了"
        />
      )}
      {confirmingTab && (
        <ConfirmDialog
          description={`このタブには起動中のCLIが ${confirmingTab.runningSessionCount} 個あります。すべて終了して閉じますか？`}
          onCancel={() => setConfirmingTab(null)}
          onConfirm={() => void closeTab(confirmingTab.tabId)}
          title="タブ内のCLIを終了"
        />
      )}
      {notice && (
        <button
          className="notice-toast"
          onClick={() => setNotice(undefined)}
          role="status"
          type="button"
        >
          {notice}
        </button>
      )}
      {tourOpen && <TourOverlay onComplete={completeTour} />}
    </div>
  );
}
