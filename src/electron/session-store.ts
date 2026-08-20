import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { persistedWorkspaceSchema } from "../shared/schema";

import { createDefaultWorkspace } from "./defaults";

import type { PersistedWorkspace } from "../shared/types";

export class SessionStore {
  private current: PersistedWorkspace = createDefaultWorkspace();
  private readonly filePath: string;
  private writeCounter = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "session.json");
  }

  get snapshot(): PersistedWorkspace {
    return structuredClone(this.current);
  }

  async load(): Promise<PersistedWorkspace> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = persistedWorkspaceSchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        console.warn("Ignoring invalid persisted workspace.", parsed.error.message);
        this.current = createDefaultWorkspace();
        return this.snapshot;
      }

      this.current = parsed.data;
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

    this.current = parsed.data;

    // 保存要求が重なっても壊れないように直列化する。並行して走ると、先行の
    // rename が一時ファイルを消した後に後続が rename して ENOENT になる。
    const pending = this.writeQueue.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    this.writeQueue = pending.catch(() => undefined);
    return pending;
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
