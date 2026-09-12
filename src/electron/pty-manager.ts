import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import * as pty from "node-pty";

import {
  describeDiagnosticPayload,
  DIAGNOSTIC_CATEGORIES,
  ExtendedKeyModeSequenceDetector,
} from "../shared/diagnostics";

import { StatusDetector } from "./status-detector";

import type {
  PtyDataEvent,
  PtyStatusEvent,
  SessionState,
  SpawnSessionRequest,
} from "../shared/types";

interface ManagedPty {
  detector: StatusDetector;
  process: pty.IPty;
  /**
   * ブートストラップ（シェル初期化 + claude 等の起動）を保留している間だけ入る。
   * 起動直後の ConPTY は resize を例外なしで黙って捨てるため、この間に来た
   * サイズは pty へ流さず、確定値としてここに退避しておく。
   */
  pendingBootstrap?: {
    command: string;
    /** 確定通知が来ないまま固まらないための上限タイマー。 */
    timeoutTimer: ReturnType<typeof setTimeout>;
  };
  /** リサイズ後の再描画を1回にまとめるタイマー。 */
  redrawTimer?: ReturnType<typeof setTimeout>;
  /** 保留中に renderer から届いた最新サイズ。 */
  pendingSize?: {
    cols: number;
    rows: number;
  };
}

/**
 * renderer 側は起動直後に DOM 実測のセル幅で一度 fit し、その後 WebGL の
 * ロードでセル幅が整数へ丸められて再 fit する（実測 7.616px→7.000px、
 * 159列→173列）。この確定を待たずに claude を起動すると、claude は
 * 誤った桁数で初回描画してしまい、以後入力があるまで再描画されないため
 * 右端が枠からはみ出して見える。
 *
 * 最初に届くサイズ（159列）は確定値ではないため、renderer が
 * sizeSettled=true を付けて送ってくるまで待つ。通知が来ない異常時に備えて
 * 上限でも打ち切る。
 *
 * 以前はこの上限を 3 秒にしていたが、renderer 側が「WebGL のロード完了」を
 * 確定と見なしていたため、レイアウトがまだ動いている段階で起動していた。
 * 実測ではウィンドウのレイアウトが落ち着いたのは起動 9 秒後で、その間に
 * 85桁×41行 → 92桁×28行 と変わり、CLI は 85 桁で描いた画面のまま 92 桁の
 * 枠に置かれて崩れていた。renderer 側をサイズが動かなくなったことで判定する
 * よう直したうえで、上限も実測を覆う長さへ広げている。
 */
const BOOTSTRAP_SIZE_SETTLE_TIMEOUT_MS = 12_000;

/**
 * 出るはずのない文字が届いていないかを見張るための目印。
 *
 * 箇条書きの先頭に「料」が出る現象を追うために置いている。ここに挙げた
 * 文字は Claude Code の出力に本来現れないので、届いたら記録して中身を
 * 確かめられるようにする。原因が分かったら消してよい。
 */
const SUSPICIOUS_GLYPH_PATTERN = /[料]/u;

/** 記録する前後の長さ。周辺を見ないと何が起きたか分からないため。 */
const SUSPICIOUS_GLYPH_CONTEXT_LENGTH = 400;

/** 連続リサイズをまとめ、レイアウト確定後に再描画を送るまでの待ち。 */
const REDRAW_DEBOUNCE_MS = 250;
/** 揺らした幅を元に戻すまでの待ち。TUI が 1 回目を取りこぼさない程度に置く。 */
const REDRAW_NUDGE_RESTORE_MS = 30;

interface PtyManagerEvents {
  onData: (event: PtyDataEvent) => void;
  onDiagnostic: (category: string, message: string) => void;
  onStatus: (event: PtyStatusEvent) => void;
}

function getPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const systemPowerShell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  return existsSync(systemPowerShell) ? systemPowerShell : "powershell.exe";
}

// Cockpit 自体が別の Claude Code / Codex CLI セッションの子プロセスとして
// 起動されると、process.env に親セッション固有の変数が入り込む。これをそのまま
// pty に渡すと、ペイン内で起動した claude が「自分は子セッション/ブリッジ配下」と
// 誤認し、(1) トランスクリプト保存が OFF になる、(2) resume 一覧に出ず開けない、
// という不具合を起こす。Cockpit は純粋なターミナルの入れ物なので、外側の CLI
// セッション由来の変数は子に伝播させず、クリーンな通常セッションとして起動させる。
export function isInheritedCliSessionVar(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "CLAUDECODE" ||
    upper === "AI_AGENT" ||
    upper.startsWith("CLAUDE_") ||
    upper.startsWith("CLAUDE_CODE_") ||
    upper.startsWith("CODEX_") ||
    upper.startsWith("ANTHROPIC_")
  );
}

// Cockpit を CLI から起動すると、親プロセス（Claude Code / CI ツール等）が持つ
// NO_COLOR=1 がそのまま pty へ継承され、ペイン内の claude / codex が色出力を
// 完全に止めてしまう（PowerShell 自身は NO_COLOR に従わないため「claude だけ
// 色が出ない」という分かりにくい形で表面化する）。Cockpit は色付き前提の
// ターミナルなので、色を抑止する系の変数は子に伝播させない。
export function isColorSuppressionVar(key: string): boolean {
  const upper = key.toUpperCase();
  return upper === "NO_COLOR" || upper === "CLICOLOR";
}

function getPtyEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !isInheritedCliSessionVar(key) &&
      !isColorSuppressionVar(key)
    ) {
      environment[key] = value;
    }
  }

  environment.COLORTERM = "truecolor";
  environment.LANG = "ja_JP.UTF-8";
  environment.TERM = "xterm-256color";
  return environment;
}

function createBootstrapCommand(command: string): string {
  const encodingSetup = [
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding=[Console]::OutputEncoding",
    "chcp.com 65001 | Out-Null",
    // claude / codex は .ps1 ラッパー。既定の実行ポリシー(Restricted/RemoteSigned)
    // だと読み込めず PSSecurityException で起動失敗する。
    // このプロセス(セッション)内だけ Bypass にする（システム設定は不変・可逆）。
    "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force",
  ].join("; ");

  return command === "powershell"
    ? `${encodingSetup}\r`
    : `${encodingSetup}; ${command}\r`;
}

export class PtyManager {
  private readonly processes = new Map<string, ManagedPty>();

  constructor(private readonly events: PtyManagerEvents) {}

  spawn(request: SpawnSessionRequest): SessionState {
    if (this.processes.has(request.id)) {
      throw new Error(`Session ${request.id} is already running.`);
    }

    if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
      throw new Error(`Working directory does not exist: ${request.cwd}`);
    }

    const terminalProcess = pty.spawn(
      getPowerShellPath(),
      ["-NoLogo", "-NoExit"],
      {
        cols: request.cols,
        cwd: request.cwd,
        env: getPtyEnvironment(),
        name: "xterm-256color",
        rows: request.rows,
      },
    );
    this.events.onDiagnostic(
      DIAGNOSTIC_CATEGORIES.ptySpawn,
      JSON.stringify({
        ptyCols: terminalProcess.cols,
        ptyRows: terminalProcess.rows,
        ptySpawnInvoked: true,
        requestedInitialCols: request.cols,
        requestedInitialRows: request.rows,
        sessionId: request.id,
      }),
    );

    const detector = new StatusDetector((status) => {
      this.events.onStatus({
        sessionId: request.id,
        status,
      });
    });
    const extendedKeyModeDetector =
      new ExtendedKeyModeSequenceDetector();

    const managed: ManagedPty = {
      detector,
      process: terminalProcess,
    };
    this.processes.set(request.id, managed);

    terminalProcess.onData((data) => {
      for (const modeRequest of extendedKeyModeDetector.push(data)) {
        // pty 出力全体には画面内容が含まれるため記録せず、拡張キーモードの
        // 制御シーケンスそのものだけを抽出してログへ残す。
        this.events.onDiagnostic(
          DIAGNOSTIC_CATEGORIES.ptyExtendedKeyMode,
          JSON.stringify({
            direction: "pty-to-terminal",
            mode: modeRequest.mode,
            protocol: modeRequest.protocol,
            sequence: describeDiagnosticPayload(modeRequest.sequence),
            sessionId: request.id,
          }),
        );
      }
      detector.handleData(data);
      // 「箇条書きの先頭に見覚えのない漢字が出る」の原因を掴むための記録。
      //
      // 当初は Cockpit の描画（GPU のグリフ破損）を疑ったが、Cockpit を
      // 通さないスマホアプリでも同じ位置に同じ字が出ると分かったため、
      // CLI が実際にその文字を送っていることになる。何が届いているのかを
      // 実物で確かめないと、これ以上は推測の域を出ない。
      //
      // 全受信を残すとログが肥大するので、疑わしい文字を含むときだけ拾う。
      if (SUSPICIOUS_GLYPH_PATTERN.test(data)) {
        this.events.onDiagnostic(
          DIAGNOSTIC_CATEGORIES.suspiciousGlyph,
          JSON.stringify({
            payload: describeDiagnosticPayload(
              data.slice(0, SUSPICIOUS_GLYPH_CONTEXT_LENGTH),
            ),
            sessionId: request.id,
          }),
        );
      }
      this.events.onData({
        data,
        sessionId: request.id,
      });
    });

    terminalProcess.onExit(({ exitCode }) => {
      detector.dispose();
      this.clearBootstrapTimers(managed);
      this.processes.delete(request.id);
      this.events.onStatus({
        exitCode,
        sessionId: request.id,
        status: exitCode === 0 ? "exited" : "error",
      });
    });

    // ここで書き込むと ConPTY 初期化中の誤ったサイズで claude が起動してしまう。
    // renderer からサイズが確定するまで保留する（詳細は定数のコメント）。
    managed.pendingBootstrap = {
      command: request.command,
      timeoutTimer: setTimeout(() => {
        this.flushBootstrap(request.id, "settle-timeout");
      }, BOOTSTRAP_SIZE_SETTLE_TIMEOUT_MS),
    };
    this.events.onDiagnostic(
      DIAGNOSTIC_CATEGORIES.ptySpawn,
      JSON.stringify({
        bootstrapDeferred: true,
        sessionId: request.id,
        timeoutMs: BOOTSTRAP_SIZE_SETTLE_TIMEOUT_MS,
      }),
    );

    return {
      ...request,
      shouldRestore: true,
      startedAt: Date.now(),
      status: "idle",
    };
  }

  /**
   * 保留していたブートストラップを実行する。確定サイズを pty に適用してから
   * コマンドを書き込むことで、claude は最初から正しい桁数で描画を始められる。
   */
  private flushBootstrap(sessionId: string, reason: string): void {
    const target = this.processes.get(sessionId);
    const pending = target?.pendingBootstrap;
    if (!target || !pending) {
      return;
    }

    clearTimeout(pending.timeoutTimer);
    target.pendingBootstrap = undefined;

    const size = target.pendingSize;
    let appliedCols: number | "not-applied" = "not-applied";
    let appliedRows: number | "not-applied" = "not-applied";
    let resizeErrorName: string | null = null;
    if (size) {
      try {
        target.process.resize(size.cols, size.rows);
        appliedCols = target.process.cols;
        appliedRows = target.process.rows;
      } catch (error: unknown) {
        resizeErrorName = error instanceof Error ? error.name : "unknown";
      }
      target.pendingSize = undefined;
    }

    this.events.onDiagnostic(
      DIAGNOSTIC_CATEGORIES.ptyBootstrap,
      JSON.stringify({
        appliedCols,
        appliedRows,
        bootstrapWritten: true,
        reason,
        requestedCols: size?.cols ?? "none",
        requestedRows: size?.rows ?? "none",
        resizeErrorName,
        sessionId,
      }),
    );

    target.process.write(createBootstrapCommand(pending.command));
  }

  /**
   * 幅が変わった後に、TUI へ画面の再描画を促す。
   *
   * claude/codex のような全画面 TUI は、pty の resize を受け取っても既に描いた
   * 画面を自発的には描き直さない。全画面（例 159 列）で起動した直後にペインを
   * 分割して 78 列になると、159 列想定の行が 78 列の枠で折り返され、ステータス
   * 行などが崩れて文字化けのように見える（実測: resize 直後の最大行幅 100 桁 →
   * 再描画後 16 桁）。
   *
   * かつては Ctrl+L（FF, 0x0C）を送っていたが、これは端末への「入力」であり、
   * Claude Code でも PowerShell プロンプトでも画面クリアとして解釈される。
   * 実測で、タブを切り替えて幅が 92⇄85 と往復するたびに Ctrl+L が飛び、
   * 「勝手に clear が打たれる」状態になっていた（全期間 32 回）。
   *
   * 代わりに幅を 1 桁だけ揺らして戻す。TUI は resize（SIGWINCH 相当）を受けて
   * 自前で描き直すため再描画は保たれ、CLI へ入力を一切送らずに済む。
   */
  private scheduleRedrawAfterResize(sessionId: string): void {
    const target = this.processes.get(sessionId);
    if (!target) {
      return;
    }

    if (target.redrawTimer) {
      clearTimeout(target.redrawTimer);
    }
    target.redrawTimer = setTimeout(() => {
      const current = this.processes.get(sessionId);
      if (!current) {
        return;
      }
      current.redrawTimer = undefined;

      const { cols, rows } = current.process;
      // 1 列しかない異常時は揺らす余地がないので何もしない。
      if (cols <= 1) {
        this.events.onDiagnostic(
          DIAGNOSTIC_CATEGORIES.ptyRedraw,
          JSON.stringify({
            cols,
            reason: "too-narrow-to-nudge",
            sentRedraw: false,
            sessionId,
          }),
        );
        return;
      }

      try {
        current.process.resize(cols - 1, rows);
      } catch {
        // 揺らしに失敗しても、表示が崩れたままになるだけで実害はない。
        return;
      }

      current.redrawTimer = setTimeout(() => {
        const restored = this.processes.get(sessionId);
        if (!restored) {
          return;
        }
        restored.redrawTimer = undefined;
        try {
          restored.process.resize(cols, rows);
        } catch {
          return;
        }
        this.events.onDiagnostic(
          DIAGNOSTIC_CATEGORIES.ptyRedraw,
          JSON.stringify({
            cols,
            nudgedCols: cols - 1,
            reason: "resize",
            rows,
            sentRedraw: false,
            sessionId,
          }),
        );
      }, REDRAW_NUDGE_RESTORE_MS);
    }, REDRAW_DEBOUNCE_MS);
  }

  write(sessionId: string, data: string): void {
    const target = this.processes.get(sessionId);
    const payload = describeDiagnosticPayload(data);
    this.events.onDiagnostic(
      DIAGNOSTIC_CATEGORIES.ptyWrite,
      JSON.stringify({
        receivedByteLength: payload.utf8ByteLength,
        receivedHex: payload.hex,
        sessionId,
        targetFound: target !== undefined,
        writeInvoked: target !== undefined,
      }),
    );
    if (!target) {
      return;
    }

    target.detector.handleInput();
    target.process.write(data);
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    sizeSettled = false,
  ): void {
    const target = this.processes.get(sessionId);
    if (!target) {
      this.events.onDiagnostic(
        DIAGNOSTIC_CATEGORIES.ptyResize,
        JSON.stringify({
          applied: false,
          appliedCols: "unavailable",
          appliedRows: "unavailable",
          receivedCols: cols,
          receivedRows: rows,
          reason: "session-not-running",
          sessionId,
        }),
      );
      return;
    }

    // ブートストラップ保留中は ConPTY がまだ resize を受け付けないため、
    // pty へは流さずに退避する。renderer が「WebGL ロードでセル寸法が確定した」
    // と知らせてきた時点で、そのサイズを適用してから claude を起動する。
    const pending = target.pendingBootstrap;
    if (pending) {
      target.pendingSize = { cols, rows };
      this.events.onDiagnostic(
        DIAGNOSTIC_CATEGORIES.ptyResize,
        JSON.stringify({
          applied: false,
          appliedCols: "deferred",
          appliedRows: "deferred",
          reason: "bootstrap-pending",
          receivedCols: cols,
          receivedRows: rows,
          sessionId,
          sizeSettled,
        }),
      );
      if (sizeSettled) {
        this.flushBootstrap(sessionId, "size-settled");
      }
      return;
    }

    const previousCols = target.process.cols;
    try {
      target.process.resize(cols, rows);
      this.events.onDiagnostic(
        DIAGNOSTIC_CATEGORIES.ptyResize,
        JSON.stringify({
          applied: true,
          appliedCols: target.process.cols,
          appliedRows: target.process.rows,
          receivedCols: cols,
          receivedRows: rows,
          sessionId,
        }),
      );
      if (previousCols !== target.process.cols) {
        this.scheduleRedrawAfterResize(sessionId);
      }
    } catch (error: unknown) {
      this.events.onDiagnostic(
        DIAGNOSTIC_CATEGORIES.ptyResize,
        JSON.stringify({
          applied: false,
          appliedCols: "unavailable",
          appliedRows: "unavailable",
          errorName: error instanceof Error ? error.name : "unknown",
          receivedCols: cols,
          receivedRows: rows,
          sessionId,
        }),
      );
      throw error;
    }
  }

  private clearBootstrapTimers(target: ManagedPty): void {
    if (target.redrawTimer) {
      clearTimeout(target.redrawTimer);
      target.redrawTimer = undefined;
    }

    const pending = target.pendingBootstrap;
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutTimer);
    target.pendingBootstrap = undefined;
  }

  kill(sessionId: string): void {
    const target = this.processes.get(sessionId);
    if (!target) {
      return;
    }

    target.detector.dispose();
    this.clearBootstrapTimers(target);
    target.process.kill();
  }

  killAll(): void {
    for (const sessionId of [...this.processes.keys()]) {
      this.kill(sessionId);
    }
  }
}
