import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { persistedWorkspaceSchema } from "../shared/schema";
import { providerConversationSchema } from "../shared/provider-conversation";
import { enrichRecentConversations } from "../shared/recent-conversations";

import { createDefaultWorkspace } from "./defaults";

import type { PersistedWorkspace } from "../shared/types";
import type { ProviderConversation } from "../shared/provider-conversation";

export class SessionStore {
  private current: PersistedWorkspace = createDefaultWorkspace();
  private readonly filePath: string;
  private writeCounter = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly conversations = new Map<string, ProviderConversation | null>();

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "session.json");
  }

  get snapshot(): PersistedWorkspace {
    return structuredClone(this.current);
  }

  async load(): Promise<PersistedWorkspace> {
    this.conversations.clear();
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = persistedWorkspaceSchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        console.warn("Ignoring invalid persisted workspace.", parsed.error.message);
        this.current = createDefaultWorkspace();
        return this.snapshot;
      }

      this.current = { ...parsed.data, recent: enrichRecentConversations(parsed.data.recent, parsed.data.sessions) };
      for (const session of this.current.sessions) {
        if (session.conversation !== undefined) this.conversations.set(session.id, session.conversation);
      }
      for (const item of this.current.recent) {
        if (item.sessionId && item.conversation !== undefined && !this.conversations.has(item.sessionId)) this.conversations.set(item.sessionId, item.conversation);
      }
      return this.snapshot;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        console.warn("Could not load persisted workspace.", error.message);
      }

      this.current = createDefaultWorkspace();
      return this.snapshot;
    }
  }

  async save(workspace: PersistedWorkspace): Promise<void> {
    const parsed = persistedWorkspaceSchema.safeParse(workspace);
    if (!parsed.success) {
      throw new Error(`Invalid workspace payload: ${parsed.error.message}`);
    }

    const sessions = parsed.data.sessions.map(session => {
      const conversation = this.conversations.get(session.id);
      return conversation !== undefined ? { ...session, conversation } : session;
    });
    this.current = {
      ...parsed.data,
      sessions,
      recent: enrichRecentConversations(parsed.data.recent.map(item => {
        const previous = item.sessionId ? this.current.recent.find(saved => saved.sessionId === item.sessionId) : undefined;
        return item.conversation === undefined && previous?.conversation !== undefined ? { ...item, conversation: previous.conversation } : item;
      }), sessions, this.conversations),
    };

    // 保存要求が重なっても壊れないように直列化する。並行して走ると、先行の
    // rename が一時ファイルを消した後に後続が rename して ENOENT になる。
    const pending = this.writeQueue.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    this.writeQueue = pending.catch(() => undefined);
    return pending;
  }

  /** Backend observations win over a stale renderer debounce, including before first save. */
  async recordConversation(sessionId: string, value: ProviderConversation | null): Promise<void> {
    const conversation = providerConversationSchema.nullable().parse(value);
    if (!this.conversations.has(sessionId) && this.conversations.size >= 128) {
      this.conversations.delete(this.conversations.keys().next().value!);
    }
    this.conversations.set(sessionId, conversation);
    if (this.current.sessions.some(session => session.id === sessionId)
      || this.current.recent.some(item => item.sessionId === sessionId)) await this.save(this.current);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    // 一時ファイル名は呼び出しごとにユニークにする（固定名だと同時実行時に
    // 互いの一時ファイルを奪い合う）。
    this.writeCounter += 1;
    const temporaryPath = `${this.filePath}.${process.pid}.${this.writeCounter}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.current, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
