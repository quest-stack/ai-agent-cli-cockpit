import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultWorkspace } from "../../src/electron/defaults";
import { SessionStore } from "../../src/electron/session-store";
import { createBootstrapCommand } from "../../src/electron/cli-bootstrap";
import { getRestoredCliCommand } from "../../src/shared/cli-launch";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("tabs in the same folder restore their own exact conversations", () => {
  const commands = [first, second].map(id => getRestoredCliCommand("codex", { cli: "codex", id }));
  assert.deepEqual(commands, [`codex resume ${first}`, `codex resume ${second}`]);
  assert.match(createBootstrapCommand(commands[1], true, "win32"), new RegExp(`resume ${second}`));
  assert.ok(!createBootstrapCommand(commands[1], true, "win32").includes("--last"));
  assert.equal(getRestoredCliCommand("claude", { cli: "claude", id: first }), `claude --resume ${first}`);
});

test("legacy sessions open a picker rather than guessing a folder's latest conversation", () => {
  assert.equal(getRestoredCliCommand("codex", undefined), "codex resume");
  assert.equal(getRestoredCliCommand("claude", undefined), "claude --resume");
  assert.equal(getRestoredCliCommand("codex", null), "codex resume");
  assert.equal(getRestoredCliCommand("claude", null), "claude --resume");
  assert.equal(getRestoredCliCommand("custom-script", undefined), "custom-script");
  assert.throws(() => getRestoredCliCommand("claude", { cli: "codex", id: first }));
  assert.throws(() => getRestoredCliCommand("codex", { cli: "codex", id: `${first}; write-host injected` }));
});

test("a provider observation survives stale renderer saves and a storage reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-conversation-store-"));
  const store = new SessionStore(directory);
  const workspace = createDefaultWorkspace();
  workspace.sessions = [first, second].map((id, index) => ({
    command: "codex", cwd: directory, id: `pane-session-${index}`, projectName: "owned", shouldRestore: true, title: "owned",
  }));
  await store.recordConversation("pane-session-0", { cli: "codex", id: first });
  await store.save(workspace);
  await store.recordConversation("pane-session-1", { cli: "codex", id: second });
  await store.save(workspace);
  await store.flush();
  const reloaded = await new SessionStore(directory).load();
  assert.deepEqual(reloaded.sessions.map(session => session.conversation?.id), [first, second]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "session.json"), "utf8")).sessions.map((session: { conversation: { id: string } }) => session.conversation.id), [first, second]);
});
