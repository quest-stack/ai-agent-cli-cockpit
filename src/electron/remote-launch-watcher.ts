import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  remoteLaunchRequestSchema,
  stripByteOrderMark,
} from "../shared/schema";

import type { RemoteLaunchRequest } from "../shared/types";

/**
 * 受付フォルダを見張り、置かれた依頼を 1 件ずつ渡す。
 *
 * ここはネットワークを一切開かない。外部から届いた指示は、この PC 上で
 * 動いている別のプロセス（Claude Code など）がファイルとして書き出し、
 * それを Cockpit が拾う、という片道の流れにしてある。受信のために
 * ポートを開けると Cockpit 自体が攻撃対象になるため、その形は採らない。
 *
 * 監視は fs.watch ではなくポーリングにしている。ネットワークドライブや
 * 一部のウイルス対策ソフト配下で fs.watch がイベントを取りこぼすことが
 * あり、「置いたのに動かない」が最も困る失敗のため。
 */

/** 依頼を拾いに行く間隔。人が待てる範囲で、負荷にならない程度。 */
const POLL_INTERVAL_MS = 2_000;

/**
 * 書き込み途中のファイルを読まないための待ち時間。
 *
 * 書き手が JSON を書ききる前に読むと、壊れた JSON として捨ててしまう。
 * 更新時刻がこの時間より新しいファイルは、次の巡回まで待つ。
 */
const WRITE_SETTLE_MS = 300;

/** 1 回の巡回で処理する上限。まとめて置かれても一度に開きすぎない。 */
const MAX_REQUESTS_PER_POLL = 3;

/** 依頼ファイルの上限サイズ。これを超えるものは読まずに捨てる。 */
const MAX_REQUEST_BYTES = 64 * 1024;

export interface RemoteLaunchWatcherEvents {
  onDiagnostic: (category: string, message: string) => void;
  /**
   * 依頼を受理したときに呼ばれる。
   *
   * 実際にセッションを起動してタブへ載せるのは renderer 側の責務。
   * main だけで pty を起こすと、プロセスは立つのに画面に出ない
   * 「見えないセッション」ができてしまう。
   */
  onRequest: (request: RemoteLaunchRequest) => void;
}

interface RemoteLaunchWatcherOptions {
  diagnosticCategory: string;
  /** 受付フォルダ。既定は userData 配下の inbox。 */
  directory: string;
  events: RemoteLaunchWatcherEvents;
}

export class RemoteLaunchWatcher {
  private readonly directory: string;
  private readonly diagnosticCategory: string;
  private readonly events: RemoteLaunchWatcherEvents;
  private enabled = false;
  /** 巡回が重ならないようにするための実行中フラグ。 */
  private polling = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RemoteLaunchWatcherOptions) {
    this.diagnosticCategory = options.diagnosticCategory;
    this.directory = options.directory;
    this.events = options.events;
  }

  get inboxDirectory(): string {
    return this.directory;
  }

  /**
   * 設定に合わせて監視を開始・停止する。
   *
   * 無効化したら即座に見に行くのをやめる。フォルダは消さない
   * （利用者が置いたファイルを黙って消すべきではない）。
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }

    this.enabled = enabled;
    this.events.onDiagnostic(
      this.diagnosticCategory,
      JSON.stringify({
        directory: this.directory,
        enabled,
        event: "set-enabled",
      }),
    );

    if (enabled) {
      this.timer = setInterval(() => {
        void this.poll();
      }, POLL_INTERVAL_MS);
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.setEnabled(false);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.enabled) {
      return;
    }

    this.polling = true;
    try {
      await this.processPendingRequests();
    } catch (error: unknown) {
      // フォルダが無いのは「まだ誰も置いていない」だけなので黙って通す。
      if (!isMissingDirectoryError(error)) {
        this.events.onDiagnostic(
          this.diagnosticCategory,
          JSON.stringify({
            errorName: error instanceof Error ? error.name : "unknown",
            event: "poll-failed",
          }),
        );
      }
    } finally {
      this.polling = false;
    }
  }

  private async processPendingRequests(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_REQUESTS_PER_POLL);

    for (const name of candidates) {
      if (!this.enabled) {
        return;
      }
      await this.processRequestFile(join(this.directory, name), name);
    }
  }

  private async processRequestFile(
    filePath: string,
    name: string,
  ): Promise<void> {
    let raw: string;
    try {
      const info = await stat(filePath);
      if (info.size > MAX_REQUEST_BYTES) {
        await this.discard(filePath, name, "too-large");
        return;
      }
      // 書き込み途中なら次の巡回に回す。消さずに残す。
      if (Date.now() - info.mtimeMs < WRITE_SETTLE_MS) {
        return;
      }
      raw = await readFile(filePath, "utf8");
    } catch (error: unknown) {
      // 読む前に消えた場合は何もしない（別の巡回が処理済み）。
      if (!isMissingFileError(error)) {
        this.events.onDiagnostic(
          this.diagnosticCategory,
          JSON.stringify({
            errorName: error instanceof Error ? error.name : "unknown",
            event: "read-failed",
            name,
          }),
        );
      }
      return;
    }

    // 受理・不受理にかかわらず、まずファイルを消す。残したまま失敗すると
    // 次の巡回で同じ依頼を何度も起動してしまう。
    await this.discard(filePath, name, "consumed");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripByteOrderMark(raw));
    } catch {
      this.events.onDiagnostic(
        this.diagnosticCategory,
        JSON.stringify({ event: "rejected", name, reason: "invalid-json" }),
      );
      return;
    }

    const parsed = remoteLaunchRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.events.onDiagnostic(
        this.diagnosticCategory,
        JSON.stringify({
          event: "rejected",
          name,
          reason: "schema",
          // 依頼の中身そのものは書かない（指示文が丸ごとログに残るのを避ける）。
          validationIssue: parsed.error.issues[0]?.path.join(".") ?? "unknown",
        }),
      );
      return;
    }

    // 実在するディレクトリでなければ起動しない。存在しない cwd で pty を
    // 起こすと、シェルの起動位置が予期しない場所になる。
    try {
      const target = await stat(parsed.data.cwd);
      if (!target.isDirectory()) {
        this.events.onDiagnostic(
          this.diagnosticCategory,
          JSON.stringify({ event: "rejected", name, reason: "cwd-not-a-directory" }),
        );
        return;
      }
    } catch {
      this.events.onDiagnostic(
        this.diagnosticCategory,
        JSON.stringify({ event: "rejected", name, reason: "cwd-missing" }),
      );
      return;
    }

    this.events.onDiagnostic(
      this.diagnosticCategory,
      JSON.stringify({
        cwd: parsed.data.cwd,
        event: "accepted",
        hasPrompt: parsed.data.prompt !== undefined,
        name,
      }),
    );
    this.events.onRequest(parsed.data);
  }

  private async discard(
    filePath: string,
    name: string,
    reason: string,
  ): Promise<void> {
    try {
      await rm(filePath, { force: true });
    } catch (error: unknown) {
      this.events.onDiagnostic(
        this.diagnosticCategory,
        JSON.stringify({
          errorName: error instanceof Error ? error.name : "unknown",
          event: "discard-failed",
          name,
          reason,
        }),
      );
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissingDirectoryError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}
