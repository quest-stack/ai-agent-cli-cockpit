import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrichRecentConversations, getRecentConversationCommand, getRecordedResumeTargets, rememberRecentConversation, sameConversationDirectory } from "../../src/shared/recent-conversations";
import { SessionStore } from "../../src/electron/session-store";
import { createDefaultWorkspace } from "../../src/electron/defaults";
import type { RecentSession, PersistedSession } from "../../src/shared/types";

const a = { cli: "claude" as const, id: "11111111-1111-4111-8111-111111111111" };
const b = { cli: "claude" as const, id: "22222222-2222-4222-8222-222222222222" };
const c = { cli: "codex" as const, id: "33333333-3333-4333-8333-333333333333" };
const recent = (title = "A", sessionId?: string): RecentSession => ({ command: "claude", cwd: "C:/work/same-folder", title, projectName: "same-folder", lastUsedAt: 1, ...(sessionId ? { sessionId } : {}) });
const session = (id = "session-a", title = "A", conversation = a): PersistedSession => ({ ...recent(title), id, shouldRestore: true, conversation });

test("recent resume keeps distinct same-folder conversations and deduplicates reopening only the exact one", () => {
  const first = { ...recent("same", "session-a"), conversation: a }, second = { ...recent("same", "session-b"), conversation: b };
  const entries = rememberRecentConversation([first], second);
  assert.equal(entries.length, 2);
  assert.equal(getRecentConversationCommand(entries[1]), `claude --resume ${a.id}`);
  const resumed = rememberRecentConversation(entries, { ...first, sessionId: "session-resumed" });
  assert.equal(resumed.length, 2); assert.equal(resumed[0].sessionId, "session-resumed");
  assert.equal(resumed[1].conversation?.id, b.id);
});

test("legacy folder and title matches never prove a conversation identity", () => {
  assert.equal(enrichRecentConversations([recent()], [session()])[0].conversation, undefined);
  assert.equal(enrichRecentConversations([recent("A", "session-a")], [session()])[0].conversation?.id, a.id);
  assert.equal(enrichRecentConversations([recent()], [session(), session("session-b", "A", b)])[0].conversation, undefined);
  assert.equal(enrichRecentConversations([recent()], [{ ...session(), cwd: "C:/other" }])[0].conversation, undefined);
  assert.equal(enrichRecentConversations([recent()], [{ ...session(), command: "codex", conversation: c }])[0].conversation, undefined);
  assert.equal(getRecentConversationCommand({ ...recent(), conversation: c }), undefined);
  assert.equal(getRecentConversationCommand(recent()), undefined);
  const targets = getRecordedResumeTargets([recent()], [session()]);
  assert.equal(targets.length, 1); assert.equal(targets[0].sessionId, "session-a");
});

test("saved session IDs survive rename and prevent same-title sessions from stealing the target", () => {
  const result = enrichRecentConversations([recent("old title", "session-a")], [session("session-a", "renamed"), session("session-b", "old title", b)]);
  assert.equal(result[0].title, "renamed"); assert.equal(result[0].conversation?.id, a.id);
  assert.equal(sameConversationDirectory("C:\\work\\same-folder\\", "c:/WORK/same-folder"), true);
  assert.equal(sameConversationDirectory("/work/Case", "/work/case"), false);
});

test("ambiguous old recent names still expose each known live conversation without guessing a card", () => {
  const targets = getRecordedResumeTargets([recent("same")], [session("session-a", "same"), session("session-b", "same", b)]);
  assert.equal(targets.length, 2); assert.deepEqual(new Set(targets.map(item => item.conversation?.id)), new Set([a.id, b.id]));
  assert.equal(enrichRecentConversations([recent("same")], [session("session-a", "same"), session("session-b", "same", b)])[0].conversation, undefined);
});

test("backend identity reaches recent history before first save, survives close/reload and stale renderer saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-recent-store-")), store = new SessionStore(root);
  const workspace = createDefaultWorkspace(); workspace.sessions = [{ ...session(), conversation: undefined }]; workspace.recent = [recent("A", "session-a")];
  await store.recordConversation("session-a", a); await store.save(workspace);
  assert.equal(store.snapshot.recent[0].conversation?.id, a.id);
  await store.save({ ...workspace, sessions: [] });
  assert.equal(store.snapshot.recent[0].conversation?.id, a.id);
  const reloaded = new SessionStore(root); await reloaded.load();
  await reloaded.save({ ...workspace, sessions: [] });
  assert.equal(reloaded.snapshot.recent[0].conversation?.id, a.id);
  await reloaded.recordConversation("session-a", b);
  assert.equal(reloaded.snapshot.recent[0].conversation?.id, b.id);
});
