import type {
  LayoutNode,
  PaneNode,
  SessionState,
  SplitAxis,
  TabState,
} from "./types";

export type IdFactory = (prefix: "pane" | "split" | "tab") => string;

export interface TabRenderState {
  active: boolean;
  tab: TabState;
}

export function createPane(id: string, sessionId: string | null = null): PaneNode {
  return {
    id,
    sessionId,
    type: "pane",
  };
}

export function createTab(
  idFactory: IdFactory,
  title = "New Session",
): TabState {
  const pane = createPane(idFactory("pane"));

  return {
    activePaneId: pane.id,
    id: idFactory("tab"),
    root: pane,
    title,
  };
}

export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") {
    return [node];
  }

  return [...collectPanes(node.children[0]), ...collectPanes(node.children[1])];
}

export function createTabRenderStates(
  tabs: readonly TabState[],
  activeTabId: string,
): TabRenderState[] {
  return tabs.map((tab) => ({
    active: tab.id === activeTabId,
    tab,
  }));
}

export function getTabDisplayTitle(
  tab: TabState,
  sessions: readonly Pick<
    SessionState,
    "id" | "projectName" | "title"
  >[],
): string {
  const sessionIds = new Set(
    collectPanes(tab.root)
      .map((pane) => pane.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null),
  );
  const tabSessions = sessions.filter((session) => sessionIds.has(session.id));

  if (tabSessions.length === 0) {
    return "New Session";
  }

  if (tabSessions.length === 1) {
    const [session] = tabSessions;
    return `${session.title} · ${session.projectName}`;
  }

  // 特定セッションを「親」にせず、選択中の作業名を先に見せる。
  const activeSessionId = findPane(tab.root, tab.activePaneId)?.sessionId;
  const activeSession = tabSessions.find((session) => session.id === activeSessionId)
    ?? tabSessions[0];
  return `${activeSession.title} · ほか${tabSessions.length - 1}件`;
}

export function findPane(
  node: LayoutNode,
  paneId: string,
): PaneNode | undefined {
  if (node.type === "pane") {
    return node.id === paneId ? node : undefined;
  }

  return (
    findPane(node.children[0], paneId) ??
    findPane(node.children[1], paneId)
  );
}

export function findPaneBySession(
  node: LayoutNode,
  sessionId: string,
): PaneNode | undefined {
  return collectPanes(node).find((pane) => pane.sessionId === sessionId);
}

export function assignSession(
  node: LayoutNode,
  paneId: string,
  sessionId: string | null,
): LayoutNode {
  if (node.type === "pane") {
    return node.id === paneId ? { ...node, sessionId } : node;
  }

  return {
    ...node,
    children: [
      assignSession(node.children[0], paneId, sessionId),
      assignSession(node.children[1], paneId, sessionId),
    ],
  };
}

export function splitPane(
  node: LayoutNode,
  paneId: string,
  axis: SplitAxis,
  idFactory: IdFactory,
): { activePaneId: string; root: LayoutNode } {
  if (node.type === "pane") {
    if (node.id !== paneId) {
      return { activePaneId: paneId, root: node };
    }

    const nextPane = createPane(idFactory("pane"));

    return {
      activePaneId: nextPane.id,
      root: {
        axis,
        children: [node, nextPane],
        id: idFactory("split"),
        ratio: 0.5,
        type: "split",
      },
    };
  }

  if (findPane(node.children[0], paneId)) {
    const result = splitPane(node.children[0], paneId, axis, idFactory);
    return {
      activePaneId: result.activePaneId,
      root: {
        ...node,
        children: [result.root, node.children[1]],
      },
    };
  }

  if (findPane(node.children[1], paneId)) {
    const result = splitPane(node.children[1], paneId, axis, idFactory);
    return {
      activePaneId: result.activePaneId,
      root: {
        ...node,
        children: [node.children[0], result.root],
      },
    };
  }

  return { activePaneId: paneId, root: node };
}

export function removePane(
  node: LayoutNode,
  paneId: string,
): LayoutNode | null {
  if (node.type === "pane") {
    return node.id === paneId ? null : node;
  }

  const left = removePane(node.children[0], paneId);
  const right = removePane(node.children[1], paneId);

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    ...node,
    children: [left, right],
  };
}

export function updateSplitRatio(
  node: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode {
  if (node.type === "pane") {
    return node;
  }

  if (node.id === splitId) {
    return {
      ...node,
      ratio: Math.max(0.15, Math.min(0.85, ratio)),
    };
  }

  return {
    ...node,
    children: [
      updateSplitRatio(node.children[0], splitId, ratio),
      updateSplitRatio(node.children[1], splitId, ratio),
    ],
  };
}

export function replaceSessionEverywhere(
  node: LayoutNode,
  sessionId: string,
): LayoutNode {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? { ...node, sessionId: null } : node;
  }

  return {
    ...node,
    children: [
      replaceSessionEverywhere(node.children[0], sessionId),
      replaceSessionEverywhere(node.children[1], sessionId),
    ],
  };
}
