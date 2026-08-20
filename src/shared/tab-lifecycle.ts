import { collectPanes } from "./layout";

import type { SessionState, TabState } from "./types";

function isRunningSession(session: SessionState): boolean {
  return session.status !== "exited" && session.status !== "error";
}

export function getRunningSessionIdsInTab(
  tab: TabState,
  sessions: readonly SessionState[],
): string[] {
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const sessionIds = new Set(
    collectPanes(tab.root)
      .map((pane) => pane.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null),
  );

  return [...sessionIds].filter((sessionId) => {
    const session = sessionsById.get(sessionId);
    return session !== undefined && isRunningSession(session);
  });
}

interface CloseTabAfterTerminatingSessionsOptions {
  killSession: (sessionId: string) => Promise<void>;
  onClose: (terminatedSessionIds: string[]) => void;
  sessions: readonly SessionState[];
  tab: TabState;
}

export async function closeTabAfterTerminatingSessions({
  killSession,
  onClose,
  sessions,
  tab,
}: CloseTabAfterTerminatingSessionsOptions): Promise<void> {
  const sessionIds = getRunningSessionIdsInTab(tab, sessions);
  await Promise.all(sessionIds.map((sessionId) => killSession(sessionId)));
  onClose(sessionIds);
}
