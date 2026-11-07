import { getCliKind, getConversationResumeCommand } from "./cli-launch";

import type { ProviderConversation } from "./provider-conversation";
import type { PersistedSession, RecentSession } from "./types";

export function sameConversationDirectory(a: string, b: string): boolean {
  const key = (value: string): string => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
    return /^(?:[a-z]:|\/\/)/iu.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  return key(a) === key(b);
}

/** Only the originating Cockpit session ID proves a recent record's identity. */
export function enrichRecentConversations(
  recent: readonly RecentSession[], sessions: readonly PersistedSession[],
  observed: ReadonlyMap<string, ProviderConversation | null> = new Map(),
): RecentSession[] {
  return recent.map(item => {
    const cli = getCliKind(item.command);
    if (cli !== "claude" && cli !== "codex") return item;
    const candidates = sessions.filter(session => Boolean(item.sessionId) && getCliKind(session.command) === cli
      && sameConversationDirectory(session.cwd, item.cwd)
      && session.id === item.sessionId);
    const session = candidates.length === 1 ? candidates[0] : undefined;
    const sessionId = item.sessionId ?? session?.id;
    const conversation = sessionId && observed.has(sessionId) ? observed.get(sessionId) : session?.conversation;
    if (conversation === undefined || (conversation && conversation.cli !== cli)) return item;
    return { ...item, ...(sessionId ? { sessionId } : {}), conversation,
      ...(session ? { title: session.title, projectName: session.projectName } : {}) };
  });
}

export function getRecentConversationCommand(item: RecentSession): string | undefined {
  return item.conversation ? getConversationResumeCommand(item.command, item.conversation)?.toLowerCase() : undefined;
}

/** A resumed conversation has one recent entry, even after opening a new pane. */
export function rememberRecentConversation(recent: readonly RecentSession[], next: RecentSession): RecentSession[] {
  const command = getRecentConversationCommand(next);
  return [next, ...recent.filter(item => {
    if (next.sessionId && item.sessionId === next.sessionId) return false;
    if (command && sameConversationDirectory(item.cwd, next.cwd) && getRecentConversationCommand(item) === command) return false;
    const provider = getCliKind(next.command);
    return provider === "claude" || provider === "codex" || !(sameConversationDirectory(item.cwd, next.cwd) && item.command === next.command && item.title === next.title);
  })].slice(0, 40);
}

export function getRecordedResumeTargets(recent: readonly RecentSession[], sessions: readonly PersistedSession[]): RecentSession[] {
  const entries = enrichRecentConversations(recent, sessions);
  // Live sessions also recover old folder records whose names were ambiguous.
  for (const session of sessions) {
    if (!session.conversation || !getConversationResumeCommand(session.command, session.conversation)) continue;
    if (entries.some(item => getRecentConversationCommand(item) === getConversationResumeCommand(session.command, session.conversation!)
      && sameConversationDirectory(item.cwd, session.cwd))) continue;
    entries.push({ command: session.command, sessionId: session.id, conversation: session.conversation,
      cwd: session.cwd, projectName: session.projectName, title: session.title, lastUsedAt: 0 });
  }
  const unique: RecentSession[] = [];
  for (const item of entries) {
    const command = getRecentConversationCommand(item);
    if (command && !unique.some(other => getRecentConversationCommand(other) === command && sameConversationDirectory(other.cwd, item.cwd))) unique.push(item);
  }
  return unique;
}
