import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

import type { WebglAddon } from "@xterm/addon-webgl";

import {
  describeDiagnosticPayload,
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_LOGGING,
  formatDiagnosticMessage,
} from "../shared/diagnostics";
import { shouldAvoidWebgl } from "../shared/gpu-fallback";
import { shouldRunPreventiveRedraw } from "../shared/preventive-redraw";

import { cockpitApi } from "./bridge";
import {
  resolveCompositionHorizontalLayout,
  resolveCompositionTranslateY,
} from "./composition-layout";
import { synchronizeCompositionPosition } from "./composition-sync";
import { getEmojiCellCount } from "./emoji-width";
import {
  getTerminalManualNewlineSequence,
  isPlausibleCharacterWidth,
  rebindCaptureKeydown,
  resolveTerminalEnterDisposition,
  resolveTerminalKeyAction,
  type TerminalEnterRole,
  shouldSendTerminalResize,
} from "./terminal-behavior";

interface SearchMatch {
  sessionId: string;
}

interface CharacterCellMeasurement {
  charHeightPx: number | "unavailable";
  charWidthPx: number | "unavailable";
  source: "dom-char-measure" | "unavailable";
}

interface WebglGpuFallbackDecision {
  renderer: string | null;
  shouldAvoid: boolean;
}

type ObservedMutationRecords = Parameters<
  ConstructorParameters<typeof window.MutationObserver>[0]
>[0];

const WEBGL_LAYOUT_STABILIZATION_FRAMES = 2;

/**
 * xterm が `.xterm-char-measure-element` に並べる文字数。
 *
 * xterm 本体は `textContent = "W".repeat(32)` としたうえで `offsetWidth / 32`
 * で 1 セル幅を求める。こちらも同じ数で割らないと 32 文字ぶんの幅を
 * 1 文字ぶんと誤認する。
 */
const MEASURE_ELEMENT_CHAR_COUNT = 32;
/** IME 変換文字列を包む span のクラス（背景を文字の背後だけに限定するため）。 */
/**
 * リサイズが止まってから「確定」とみなすまでの待ち。
 *
 * 起動直後はウィンドウのレイアウトが数回変わる。実測では最後の変化が
 * 起動 9 秒後で、それまでに 85桁×41行 → 92桁×28行 と動いた。連続する
 * 変化をまとめて拾えるだけの長さが要る一方、長すぎると CLI の起動を
 * 待たせることになるので、pty 側の上限（3 秒）より短く取る。
 */
const SIZE_STABLE_DELAY_MS = 400;

/**
 * 描き直したあと、念のためもう一度描き直すまでの間隔。
 *
 * 一度の再描画では直らず、利用者が Ctrl+Shift+R を連打していた記録が
 * 実測で残っている。描画基盤が落ち着く前に作ったアトラスが再び失効する
 * ためと見ており、少し置いてから追い打ちをかける。
 */
const FOLLOW_UP_REDRAW_DELAY_MS = 300;

const COMPOSITION_TEXT_CLASS = "cockpit-composition-text";
const EMOJI_CELL_CLASS = "cockpit-emoji-cell";
const EMOJI_CELL_WIDTH_PROPERTY = "--cockpit-emoji-cell-width";
const TERMINAL_CELL_WIDTH_PROPERTY = "--cockpit-terminal-cell-width";
const PREVENTIVE_REDRAW_DISABLE_STORAGE_KEY =
  "cockpit.disablePreventiveRedraw";
/**
 * 実測では崩れの再発間隔が中央値 4.1 分、最短 0.1 分だった。
 * 崩れたまま数分残る時間を減らしつつ無駄打ちを抑えるため、中央値を
 * 下回る最小の切りのよい間隔として 3 分を採る。
 */
const PREVENTIVE_REDRAW_INTERVAL_MS = 180_000;
const PREVENTIVE_REDRAW_MIN_GAP_MS = 60_000;
const WEBGL_DISABLE_STORAGE_KEY = "cockpit.disableWebgl";
const WEBGL_FORCE_STORAGE_KEY = "cockpit.forceWebgl";

let cachedWebglGpuFallbackDecision:
  | WebglGpuFallbackDecision
  | undefined;

/** localStorage で予防再描画だけを切っているか（切り分け用）。 */
function isPreventiveRedrawDisabledByUser(): boolean {
  try {
    return (
      window.localStorage.getItem(
        PREVENTIVE_REDRAW_DISABLE_STORAGE_KEY,
      ) === "1"
    );
  } catch {
    return false;
  }
}

/** localStorage で WebGL 描画を切っているか（切り分け用）。 */
/**
 * 切り分け用に手で入れた WebGL 無効化フラグを、一度だけ取り除く。
 *
 * 0.1.9 より前は GPU の自動判定が無く、表示が崩れる機体では利用者に
 * localStorage で手動設定してもらうしかなかった。いまは起動時に GPU を
 * 見て自動で切り替えるため、この手動フラグは判断を上書きして邪魔になる。
 *
 * 具体的には、WebGL で問題の無い機体でも切れたままになり、描画品質を
 * 落とし続ける。自動判定が入った版に更新した時点で役目を終えているので、
 * 残っていたら消す。
 */
function clearLegacyWebglDisableFlag(): void {
  try {
    if (window.localStorage.getItem(WEBGL_DISABLE_STORAGE_KEY) === null) {
      return;
    }
    window.localStorage.removeItem(WEBGL_DISABLE_STORAGE_KEY);
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      event: "cleared-legacy-disable-flag",
      reason: "gpu-detection-supersedes-manual-flag",
    });
  } catch {
    // localStorage が使えない環境では何もしない。
  }
}

function isWebglDisabledByUser(): boolean {
  try {
    return window.localStorage.getItem(WEBGL_DISABLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** localStorage で GPU 判定を上書きし、WebGL 描画を使うか。 */
function isWebglForcedByUser(): boolean {
  try {
    return window.localStorage.getItem(WEBGL_FORCE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getWebglGpuFallbackDecision(): WebglGpuFallbackDecision {
  if (cachedWebglGpuFallbackDecision) {
    return cachedWebglGpuFallbackDecision;
  }

  let renderer: string | null = null;
  try {
    const canvas = document.createElement("canvas");
    try {
      const context =
        canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (context) {
        try {
          const rendererInfo = context.getExtension(
            "WEBGL_debug_renderer_info",
          );
          const rendererValue: unknown = rendererInfo
            ? context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
            : null;
          renderer =
            typeof rendererValue === "string" && rendererValue.length > 0
              ? rendererValue
              : null;
        } finally {
          try {
            context.getExtension("WEBGL_lose_context")?.loseContext();
          } catch {
            // 判定用コンテキストの明示解放に失敗しても端末初期化は止めない。
          }
        }
      }
    } finally {
      // DOM へ追加していない使い捨て canvas への参照をここで手放す。
      canvas.remove();
    }
  } catch {
    // 判定不能時まで DOM 描画へ落とすと全 PC の品質を下げるため、WebGL を使う。
    renderer = null;
  }

  cachedWebglGpuFallbackDecision = {
    renderer,
    shouldAvoid: shouldAvoidWebgl(renderer),
  };
  return cachedWebglGpuFallbackDecision;
}

function logRendererDiagnostic(
  category: string,
  fields: Record<string, unknown>,
): void {
  if (!DIAGNOSTIC_LOGGING) {
    return;
  }

  try {
    cockpitApi.diagnosticLog(formatDiagnosticMessage(category, fields));
  } catch {
    // Diagnostic delivery must never change terminal input or resize behavior.
  }
}

class TerminalController {
  private activeKeydownEventId: number | undefined;
  private attachedHost: HTMLElement | undefined;
  /**
   * このペインで動いている CLI（"claude" / "codex" / "powershell"）。
   *
   * 改行として送るバイト列が CLI で異なるため保持する。Codex は CSI-u では
   * 改行にならず ESC+CR が要る（terminal-behavior.ts の定数コメント参照）。
   */
  private command: string | undefined;
  private diagnosticKeydownHost: HTMLElement | undefined;
  private disposed = false;
  /** DOM レンダラの絵文字幅補正へ渡す、実測済みの1セル幅。 */
  private emojiCellWidthPx: number | undefined;
  /** セッションごとにセル幅の診断を1度だけ残すための印。 */
  private emojiCellWidthReported = false;
  private fontsReady = false;
  private readonly keydownEventIds = new WeakMap<KeyboardEvent, number>();
  private keydownEventSequence = 0;
  private lastReportedSize: { cols: number; rows: number } | undefined;
  private readonly lineFeedHandlerEvents = new WeakSet<KeyboardEvent>();
  /** IME 変換表示の折り返し・位置補正のための監視。 */
  private compositionObserver: InstanceType<typeof window.MutationObserver> | undefined;
  /** 上の監視のコールバック実行中か。自分の書き込みによる再入を防ぐ。 */
  private suppressCompositionObserver = false;
  /** 折返し判定前に変換文字列の非折返し幅を測る不可視要素。 */
  private compositionMeasureElement: HTMLElement | undefined;
  private disposeCompositionSync: (() => void) | undefined;
  private opened = false;
  /** ペイン横スクロール打ち消しリスナを張っている host。 */
  private paneScrollHost: HTMLElement | undefined;
  /** handleLineFeedKey を張っている host（解除用）。 */
  /** 直近に CLI から出力が届いた時刻。起動完了の判断に使う。 */
  private lastOutputAt: number | undefined;
  /** 直近に全行を再描画した時刻。アトラス劣化までの時間を追うために使う。 */
  private lastRedrawAt: number | undefined;
  /** サイズが動かなくなったかを見るタイマー。 */
  private sizeStableTimer: number | undefined;
  private lineFeedHost: HTMLElement | undefined;
  /**
   * IME 変換中の Shift+Enter を検出した直後か。
   * 続けて来る通常の Enter（＝確定に伴うもの）を端末へ渡さないために使う。
   */
  private pendingImeEnterSuppression = false;
  /** WebGL ロードでセル寸法が確定したか（pty へ確定サイズを知らせる印）。 */
  private sizeSettled = false;
  private webglAddon: WebglAddon | undefined;
  private webglInitializationPending = false;
  private webglLoadAttempted = false;
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon();
  private readonly terminal: Terminal;

  constructor(readonly sessionId: string) {
    this.terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      ignoreBracketedPasteMode: false,
      letterSpacing: 0,
      lineHeight: 1.24,
      // minimumContrastRatio は 1（無補正）。4.5等にすると、暗い背景に中間色を使う
      // claude/codex のシンタックスハイライトが低コントラストと判定され、文字色が
      // 白/グレーに丸められて「色が消えた」ように見える。ターミナルでは補正しない。
      minimumContrastRatio: 1,
      scrollback: 10_000,
      theme: {
        background: "#0b0d10",
        black: "#171a20",
        blue: "#60a5fa",
        brightBlack: "#6b7280",
        brightBlue: "#93c5fd",
        brightCyan: "#67e8f9",
        brightGreen: "#86efac",
        brightMagenta: "#d8b4fe",
        brightRed: "#fca5a5",
        brightWhite: "#ffffff",
        brightYellow: "#fde68a",
        cursor: "#f5a623",
        cursorAccent: "#0b0d10",
        cyan: "#22d3ee",
        foreground: "#d8dde7",
        green: "#4ade80",
        magenta: "#c084fc",
        red: "#f87171",
        selectionBackground: "#f5a62333",
        white: "#e6e9ef",
        yellow: "#eab308",
      },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    // @xterm/xterm 6.0.0 には modifyOtherKeys / kitty keyboard protocol を有効化する
    // 公開 option や addon がない。parser.registerCsiHandler は要求を観測できるだけで、
    // Shift の有無にかかわらず Enter を CR にする内蔵キーエンコーダは切り替わらない。
    // そのため Shift+Enter は terminal-behavior.ts の手動 CSI-u 送出を正とする。
    this.terminal.attachCustomKeyEventHandler((event) =>
      this.handleCustomKeyEvent(event),
    );
    this.terminal.onData((data) => {
      const payload = describeDiagnosticPayload(data);
      const eventId = this.activeKeydownEventId ?? null;
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalKeyTranslation,
        {
          branch: "xterm-on-data",
          eventId,
          resultPayload: payload,
          sessionId: this.sessionId,
          source: "xterm",
        },
      );
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalWriteSession,
        {
          eventId,
          invoked: true,
          payload,
          sessionId: this.sessionId,
          source: "xterm-onData",
        },
      );
      cockpitApi.writeSession({
        data,
        sessionId: this.sessionId,
      });
    });
  }

  private handleDiagnosticKeydown = (event: KeyboardEvent): void => {
    if (event.target !== this.terminal.textarea) {
      return;
    }

    this.keydownEventSequence += 1;
    const eventId = this.keydownEventSequence;
    this.keydownEventIds.set(event, eventId);
    this.activeKeydownEventId = eventId;

    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalKeydown, {
      altKey: event.altKey,
      code: event.code,
      ctrlKey: event.ctrlKey,
      eventId,
      handler: "terminal-host-capture-observer",
      handlerFired: true,
      isComposing: event.isComposing,
      key: event.key,
      keyCode: event.keyCode,
      metaKey: event.metaKey,
      phase: "observed",
      sessionId: this.sessionId,
      shiftKey: event.shiftKey,
      targetIsTerminalTextarea: true,
      type: event.type,
    });

    void Promise.resolve().then(() => {
      const lineFeedHandlerFired = this.lineFeedHandlerEvents.has(event);
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalKeydown, {
        eventId,
        handler: "handleLineFeedKey",
        handlerFired: lineFeedHandlerFired,
        phase: "handler-result",
        sessionId: this.sessionId,
      });
      if (!lineFeedHandlerFired) {
        logRendererDiagnostic(
          DIAGNOSTIC_CATEGORIES.terminalKeyTranslation,
          {
            branch: "handle-line-feed-not-invoked",
            eventId,
            resultPayload: "unavailable",
            sessionId: this.sessionId,
            source: "handleLineFeedKey",
          },
        );
        logRendererDiagnostic(
          DIAGNOSTIC_CATEGORIES.terminalWriteSession,
          {
            eventId,
            invoked: false,
            reason: "handle-line-feed-not-invoked",
            sessionId: this.sessionId,
            source: "handleLineFeedKey",
          },
        );
      }
      if (this.activeKeydownEventId === eventId) {
        this.activeKeydownEventId = undefined;
      }
    });
  };

  private handleCustomKeyEvent(event: KeyboardEvent): boolean {
    const action = resolveTerminalKeyAction(
      event,
      this.terminal.hasSelection(),
    );

    if (action === "copy-selection") {
      void cockpitApi
        .writeClipboardText(this.terminal.getSelection())
        .catch(() => undefined);
      return false;
    }

    // Ctrl+V と Shift+Enter はここでは処理しない。Enter 系は host の capture
    // リスナ（handleLineFeedKey）で xterm より先に処理する。
    return true;
  }

  private handleLineFeedKey = (event: KeyboardEvent): void => {
    // 「このハンドラを通った」ことは、対象外で抜ける場合も含めて記録する。
    // ここより後に置くと、host 配下の無関係なキーがすべて
    // handle-line-feed-not-invoked として記録され、診断が読めなくなる。
    this.lineFeedHandlerEvents.add(event);

    // host に張っているため、ターミナル入力以外のキーも流れてくる。
    if (event.target !== this.terminal.textarea) {
      return;
    }
    const eventId = this.keydownEventIds.get(event) ?? null;

    // --- IME 変換中の Shift+Enter（keydown が 2 回来る）---
    //
    // Windows の IME は変換中の Shift+Enter で
    //   1回目: keyCode 229 / key "Process" / isComposing true（IME が確定に消費）
    //   2回目: 通常の Enter（keyCode 13 / isComposing false）
    // を発火する。1回目で改行を送ると「確定 + 改行」、さらに 2 回目で送信まで
    // 走る。2回目は IME 由来と判定できないため、1回目でフラグを立てて追う。
    //
    // 1回目は preventDefault しない。keydown をキャンセルすると後続の
    // composition イベントが抑止され得るため（W3C UI Events）、IME の確定
    // 自体を壊しかねない。xterm へ渡さないよう伝播だけ止める。
    // 押された瞬間の割り当てを読む。設定を変えたあと、開いたままのペインでも
    // すぐ新しい割り当てになる。
    const enterRole = terminalRegistry.getEnterRole();
    const disposition = resolveTerminalEnterDisposition(
      event,
      this.pendingImeEnterSuppression,
      enterRole,
      this.command,
    );

    if (disposition === "ime-first-keydown") {
      this.pendingImeEnterSuppression = true;
      event.stopPropagation();
      event.stopImmediatePropagation();
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWriteSession, {
        eventId,
        invoked: false,
        reason: "ime-shift-enter-first-keydown",
        sessionId: this.sessionId,
        source: "handleLineFeedKey",
        suppressedFromXterm: true,
      });
      return;
    }

    if (disposition === "ime-second-keydown") {
      this.pendingImeEnterSuppression = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWriteSession, {
        eventId,
        invoked: false,
        reason: "ime-shift-enter-second-keydown",
        sessionId: this.sessionId,
        source: "handleLineFeedKey",
        suppressedFromXterm: true,
      });
      return;
    }

    // Enter 以外まで来たらフラグは持ち越さない（2回目が来ない場合の取り残し防止）。
    this.pendingImeEnterSuppression = false;

    const sequence = getTerminalManualNewlineSequence(
      event,
      enterRole,
      this.command,
    );
    logRendererDiagnostic(
      DIAGNOSTIC_CATEGORIES.terminalKeyTranslation,
      {
        branch:
          sequence === undefined
            ? "delegate-to-xterm"
            : "manual-newline-sequence",
        eventId,
        resultPayload:
          sequence === undefined
            ? "undefined"
            : describeDiagnosticPayload(sequence),
        sessionId: this.sessionId,
        source: "getTerminalManualNewlineSequence",
      },
    );
    if (sequence === undefined) {
      // ここへ来るのは xterm に委ねてよいキーだけ。変換中の Enter は手前の
      // resolveTerminalEnterDisposition が "ime-first-keydown" として捌く。
      //
      // 以前はこの場所で同じ判定をもう一度書いていたが、対象が Enter かを
      // 見ていなかった。変換中のキーは種類を問わず keyCode 229 / key
      // "Process" で来るため、Enter を改行に入れ替えている間は日本語入力中の
      // すべての文字キーが preventDefault され、IME に何も入らなくなっていた
      // （0.2.2 以降の「入力できない」の原因）。判定を二重に持たない。
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalWriteSession,
        {
          eventId,
          invoked: false,
          reason: "manual-newline-sequence-undefined",
          sessionId: this.sessionId,
          source: "handleLineFeedKey",
          suppressedFromXterm: false,
        },
      );
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    logRendererDiagnostic(
      DIAGNOSTIC_CATEGORIES.terminalWriteSession,
      {
        eventId,
        invoked: true,
        payload: describeDiagnosticPayload(sequence),
        sessionId: this.sessionId,
        source: "handleLineFeedKey",
      },
    );
    cockpitApi.writeSession({
      data: sequence,
      sessionId: this.sessionId,
    });
  };

  private handlePasteKey = (event: KeyboardEvent): void => {
    if (
      event.type !== "keydown" ||
      !event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.key.toLowerCase() !== "v"
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.pasteFromClipboard().catch(() => undefined);
  };

  private async pasteFromClipboard(): Promise<void> {
    const result = await cockpitApi.readClipboardForPaste();
    if (result.kind === "empty") {
      return;
    }
    this.terminal.paste(result.text);
  }

  private observeFontReadiness(): void {
    void document.fonts.ready.then(() => {
      if (this.fontsReady) {
        return;
      }

      // PTY resize の解禁は WebGL のロード成否とは独立させる。
      this.fontsReady = true;
      if (this.disposed) {
        return;
      }

      const host = this.attachedHost;
      if (
        !host ||
        this.terminal.element?.parentElement !== host
      ) {
        return;
      }

      // フォント確定後のセル寸法を、初回通知として必ず PTY に反映する。
      this.fit(host, true);
    });
  }

  private measureCharacterCell(): CharacterCellMeasurement {
    const measureElement =
      this.terminal.element?.querySelector<HTMLElement>(
        ".xterm-char-measure-element",
      );
    if (!measureElement) {
      return {
        charHeightPx: "unavailable",
        charWidthPx: "unavailable",
        source: "unavailable",
      };
    }

    const bounds = measureElement.getBoundingClientRect();
    // xterm は測定要素に 1 文字を 32 個並べて入れ（"W".repeat(32)）、
    // offsetWidth を 32 で割って 1 セル幅を得る。要素の幅をそのまま読むと
    // 常に 32 文字ぶんになり、実測でも 243.75px（= 7.617 × 32）や
    // 416px（= 13.0 × 32）が観測された。全 441 回の測定がこの理由で
    // "ありえない値" として捨てられ、セル幅が一度も得られていなかった。
    const charWidthPx = bounds.width / MEASURE_ELEMENT_CHAR_COUNT;
    // 割ってもなお範囲外なら、測定中や フォント未読込の値なので捨てる。
    if (!isPlausibleCharacterWidth(charWidthPx)) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalFit, {
        elementWidthPx: bounds.width,
        event: "implausible-char-width",
        measuredWidthPx: charWidthPx,
        sessionId: this.sessionId,
      });
      return {
        charHeightPx: "unavailable",
        charWidthPx: "unavailable",
        source: "unavailable",
      };
    }

    return {
      charHeightPx: bounds.height > 0 ? bounds.height : "unavailable",
      charWidthPx,
      source: "dom-char-measure",
    };
  }

  /**
   * DOM レンダラが生成した絵文字専用 span に、実測セル幅由来の幅を渡す。
   * WebGL では .xterm-rows 自体が無いため、canvas や他の UI には作用しない。
   */
  private decorateEmojiSpans(startRow: number, endRow: number): void {
    const cellWidthPx = this.emojiCellWidthPx;
    const rowContainer =
      this.terminal.element?.querySelector<HTMLElement>(".xterm-rows");
    if (this.disposed || cellWidthPx === undefined || !rowContainer) {
      return;
    }

    rowContainer.style.setProperty(
      TERMINAL_CELL_WIDTH_PROPERTY,
      `${cellWidthPx}px`,
    );
    const firstRow = Math.max(0, startRow);
    const lastRow = Math.min(endRow, rowContainer.children.length - 1);
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
      const row = rowContainer.children.item(rowIndex);
      if (!(row instanceof HTMLElement)) {
        continue;
      }

      for (const child of row.children) {
        if (child instanceof HTMLElement) {
          this.decorateEmojiSpan(child, rowContainer, cellWidthPx);
        }
      }
    }
  }

  /** xterm が差し替えた span のうち、絵文字だけのものへ幅を付ける。 */
  private decorateEmojiSpan(
    candidate: HTMLElement,
    rowContainer: HTMLElement,
    cellWidthPx: number,
  ): void {
    if (
      candidate.tagName !== "SPAN" ||
      candidate.parentElement?.parentElement !== rowContainer
    ) {
      return;
    }

    const emojiCellCount = getEmojiCellCount(candidate.textContent ?? "");
    if (emojiCellCount === null) {
      return;
    }

    // 同じ値なら書き込まない。スタイルの再設定はレイアウトを起こすため、
    // 入力のたびに同値を設定し続けると画面がちらつく。
    const width = `${cellWidthPx * emojiCellCount}px`;
    if (
      candidate.style.getPropertyValue(EMOJI_CELL_WIDTH_PROPERTY) !== width
    ) {
      candidate.style.setProperty(EMOJI_CELL_WIDTH_PROPERTY, width);
    }
    if (!candidate.classList.contains(EMOJI_CELL_CLASS)) {
      candidate.classList.add(EMOJI_CELL_CLASS);
    }
  }

  /**
   * 選択範囲・カーソルだけの再描画でも xterm は span を差し替えるため、既存の
   * composition 監視で追加ノードだけを拾う。属性変更は無視し、自己ループを防ぐ。
   */
  private decorateAddedEmojiSpans(records: ObservedMutationRecords): void {
    const cellWidthPx = this.emojiCellWidthPx;
    const rowContainer =
      this.terminal.element?.querySelector<HTMLElement>(".xterm-rows");
    if (this.disposed || cellWidthPx === undefined || !rowContainer) {
      return;
    }

    const cellWidthValue = `${cellWidthPx}px`;
    if (
      rowContainer.style.getPropertyValue(TERMINAL_CELL_WIDTH_PROPERTY) !==
      cellWidthValue
    ) {
      rowContainer.style.setProperty(
        TERMINAL_CELL_WIDTH_PROPERTY,
        cellWidthValue,
      );
    }

    for (const record of records) {
      if (record.type !== "childList") {
        continue;
      }

      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        this.decorateEmojiSpan(node, rowContainer, cellWidthPx);
        for (const span of node.querySelectorAll<HTMLElement>("span")) {
          this.decorateEmojiSpan(span, rowContainer, cellWidthPx);
        }
      }
    }
  }

  /** 実測セル幅を CSS へ反映し、フォント確定後の値だけを1度診断へ残す。 */
  private updateEmojiCellWidth(cellWidthPx: number): void {
    if (!Number.isFinite(cellWidthPx) || cellWidthPx <= 0) {
      return;
    }

    this.emojiCellWidthPx = cellWidthPx;
    this.decorateEmojiSpans(0, this.terminal.rows - 1);
    if (this.emojiCellWidthReported || !this.fontsReady) {
      return;
    }

    const rowContainer =
      this.terminal.element?.querySelector<HTMLElement>(".xterm-rows");
    if (!rowContainer) {
      return;
    }

    this.emojiCellWidthReported = true;
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalFit, {
      cellWidthPx,
      emojiTargetWidthPx: cellWidthPx * 2,
      event: "emoji-cell-width-applied",
      sessionId: this.sessionId,
    });
  }

  private scheduleWebglInitialization(): void {
    // 切り分け用の逃がし弁。GPU/ドライバ側の問題で WebGL 描画が壊れた場合に、
    // 再ビルドせず DOM レンダラへ退避して比較できるようにする。
    // 既定は従来どおり WebGL 有効（キー未設定なら何も変わらない）。
    if (isWebglDisabledByUser()) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "skip-load",
        reason: "disabled-by-localstorage",
        sessionId: this.sessionId,
      });
      this.webglLoadAttempted = true;
      return;
    }

    if (
      this.disposed ||
      this.webglAddon ||
      this.webglInitializationPending ||
      this.webglLoadAttempted ||
      !this.attachedHost
    ) {
      return;
    }

    const forceWebgl = isWebglForcedByUser();
    const gpuDecision = getWebglGpuFallbackDecision();
    if (forceWebgl) {
      // GPU 判定を上書きした事実と判定材料を、実機で追跡できるよう残す。
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "force-load",
        gpuKnownIssue: gpuDecision.shouldAvoid,
        reason: "forced-by-localstorage",
        renderer: gpuDecision.renderer,
        sessionId: this.sessionId,
      });
    } else if (gpuDecision.shouldAvoid) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "skip-load",
        reason: "gpu-known-issue",
        renderer: gpuDecision.renderer,
        sessionId: this.sessionId,
      });
      this.webglLoadAttempted = true;
      return;
    }

    const host = this.attachedHost;
    this.webglInitializationPending = true;
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      event: "defer-load",
      fontStatus: document.fonts.status,
      layoutFramesToWait: WEBGL_LAYOUT_STABILIZATION_FRAMES,
      sessionId: this.sessionId,
    });
    void this.initializeWebglAfterLayout(host).finally(() => {
      this.webglInitializationPending = false;
      if (
        !this.disposed &&
        !this.webglLoadAttempted &&
        this.attachedHost
      ) {
        this.scheduleWebglInitialization();
      }
    });
  }

  private async initializeWebglAfterLayout(
    host: HTMLElement,
  ): Promise<void> {
    await document.fonts.ready;
    for (
      let frame = 0;
      frame < WEBGL_LAYOUT_STABILIZATION_FRAMES;
      frame += 1
    ) {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }

    if (
      this.disposed ||
      this.attachedHost !== host ||
      this.terminal.element?.parentElement !== host
    ) {
      return;
    }

    this.webglLoadAttempted = true;
    let webglAddon: WebglAddon | undefined;
    try {
      const { WebglAddon: WebglAddonConstructor } =
        await import("@xterm/addon-webgl");
      webglAddon = new WebglAddonConstructor();
      webglAddon.onContextLoss(() => {
        logRendererDiagnostic(
          DIAGNOSTIC_CATEGORIES.terminalWebgl,
          {
            event: "context-loss",
            sessionId: this.sessionId,
            webglEnabledBeforeLoss: this.webglAddon !== undefined,
          },
        );
        webglAddon?.dispose();
        this.webglAddon = undefined;
      });
      this.terminal.loadAddon(webglAddon);
      this.webglAddon = webglAddon;

      // WebGL が確定済みセル寸法からアトラスを作り直すよう明示し、
      // 既存バッファも直ちに新しい寸法で全行再描画する。
      webglAddon.clearTextureAtlas();
      const refreshEndRow = Math.max(0, this.terminal.rows - 1);
      this.terminal.refresh(0, refreshEndRow);
      // ここでは sizeSettled を立てない。WebGL のロードでセル幅は整数へ
      // 丸められるが（実測 7.616px→7.000px）、それはセル寸法が決まっただけで
      // ウィンドウのレイアウトが決まったことにはならない。実測では WebGL は
      // 0.4 秒で終わる一方、レイアウトが落ち着いたのは 9 秒後で、その間に
      // 85桁×41行 → 92桁×28行 と変わっていた。ここで確定を伝えると、
      // CLI は 85 桁で描いた画面のまま 92 桁の枠へ置かれて崩れる。
      // 確定はサイズが動かなくなったことで判定する
      // （scheduleSizeStableNotification）。
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalWebgl,
        {
          event: "load-addon",
          fontStatus: document.fonts.status,
          fullRefreshRequested: true,
          loadSucceeded: true,
          refreshEndRow,
          sessionId: this.sessionId,
          textureAtlasCleared: true,
          webglEnabled: true,
        },
      );
    } catch (error: unknown) {
      webglAddon?.dispose();
      this.webglAddon = undefined;
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalWebgl,
        {
          errorName: error instanceof Error ? error.name : "unknown",
          event: "load-addon",
          fontStatus: document.fonts.status,
          loadSucceeded: false,
          sessionId: this.sessionId,
          webglEnabled: false,
        },
      );
      // 失敗時もここでは立てない。理由は成功側と同じで、セル寸法が決まった
      // こととレイアウトが決まったことは別だから。下の fit からサイズ安定の
      // 判定が始まり、動かなくなった時点で確定を伝える。
    }

    // 確定サイズを pty へ通知する（保留中のブートストラップを解除させる）。
    if (this.attachedHost) {
      this.fit(this.attachedHost, true);
    }
  }

  /**
   * ペインの横スクロールを常に 0 に戻す。
   *
   * xterm の入力用 textarea は IME 変換窓をカーソル位置へ出すため absolute で
   * 右方向へ大きく張り出しており（実測 left:420px / width:1118px）、ペインの
   * scrollWidth が clientWidth を大きく超える。この textarea にフォーカスが
   * 入るとブラウザが可視化のためペインを横スクロールし（実測 scrollLeft:222）、
   * ペイン全体が左へずれて右端が枠から切れる。これが「右端が突き抜ける」正体。
   * overflow:hidden でもプログラム的スクロールは発生するため、実値で打ち消す。
   */
  private readonly resetPaneScroll = (): void => {
    const pane = this.attachedHost?.closest<HTMLElement>(".terminal-pane");
    if (pane && pane.scrollLeft !== 0) {
      pane.scrollLeft = 0;
    }
  };

  /**
   * IME 変換開始時に、xterm 内部のカーソル位置同期を強制する。
   *
   * xterm.js 6.0.0 には、pty からのデータを複数チャンクで受け取る際に
   * 「カーソル位置が最終位置に達する前に compositionstart が発火する」
   * レース条件があり、変換窓が実際のカーソル位置ではなく直前に描かれた
   * 文字列の末尾へ出てしまう（xtermjs/xterm.js#5734）。Electron + Windows で
   * 再現し、素のターミナルでは起きないため Cockpit 固有の症状に見える。
   *
   * 本家は compositionstart の直前に内部の _syncTextArea() を呼ぶ修正を入れた
   * （PR #5759・マイルストーン 7.0.0）。6.0.0 には未取り込みのため、同等の
   * 同期をここで行う。7.0.0 へ上げたらこの回避策は削除してよい。
   */
  private readonly handleCompositionStart = (): void => {
    this.resetCompositionViewLayout();
    const core = (
      this.terminal as unknown as {
        _core?: { _syncTextArea?: () => void };
      }
    )._core;
    try {
      core?._syncTextArea?.();
    } catch {
      // 内部 API のため将来変わりうる。失敗しても入力自体は継続させる。
    }
  };

  /**
   * IME 変換文字列の自然幅を、表示用要素とは別の nowrap 要素で測る。
   *
   * max-content/fit-content は実際の composition-view には使わない。absolute かつ
   * left のみの要素では shrink-to-fit に戻るためで、ここは明示幅を決めるための
   * 計測専用である。
   */
  private measureCompositionText(view: HTMLElement, text: string): number {
    const document = view.ownerDocument;
    let measure = this.compositionMeasureElement;
    if (!measure || measure.ownerDocument !== document) {
      measure?.remove();
      measure = document.createElement("span");
      measure.setAttribute("aria-hidden", "true");
      measure.style.contain = "layout style paint";
      measure.style.display = "inline-block";
      measure.style.left = "-100000px";
      measure.style.pointerEvents = "none";
      measure.style.position = "fixed";
      measure.style.top = "0";
      measure.style.visibility = "hidden";
      measure.style.whiteSpace = "pre";
      measure.style.width = "max-content";
      document.body.appendChild(measure);
      this.compositionMeasureElement = measure;
    }

    const viewStyle = document.defaultView?.getComputedStyle(view);
    if (viewStyle) {
      measure.style.fontFamily = viewStyle.fontFamily;
      measure.style.fontKerning = viewStyle.fontKerning;
      measure.style.fontSize = viewStyle.fontSize;
      measure.style.fontStretch = viewStyle.fontStretch;
      measure.style.fontStyle = viewStyle.fontStyle;
      measure.style.fontVariantLigatures = viewStyle.fontVariantLigatures;
      measure.style.fontWeight = viewStyle.fontWeight;
      measure.style.letterSpacing = viewStyle.letterSpacing;
    }
    measure.textContent = text;

    return Math.max(1, Math.ceil(measure.getBoundingClientRect().width));
  }

  /** このクラスが所有するレイアウト指定だけを次の変換前に外す。 */
  private resetCompositionViewLayout(view?: HTMLElement): void {
    const target =
      view ??
      this.attachedHost?.querySelector<HTMLElement>(".composition-view");
    if (!target) {
      return;
    }

    for (const property of [
      "--composition-line-height",
      "height",
      "max-width",
      "text-indent",
      "transform",
      "width",
    ]) {
      if (target.style.getPropertyValue(property)) {
        target.style.removeProperty(property);
      }
    }

    // 背景用に包んだ span を外し、xterm が期待する素のテキストへ戻す。
    const wrapper = target.firstElementChild;
    if (
      wrapper instanceof HTMLElement &&
      wrapper.classList.contains(COMPOSITION_TEXT_CLASS)
    ) {
      target.textContent = wrapper.textContent;
    }
  }

  /**
   * IME 変換窓に、xterm の描画領域を基準にした実幅を与えて折り返す。
   *
   * xterm.js 6.0.0 は absolute の要素へ left/top/1行分の height だけを設定し、
   * right/width は設定しない。そのため max-width だけでは shrink-to-fit のままで、
   * width:fit-content では min-content（日本語1文字幅）まで潰れる。
   *
   * 短文には計測した自然幅を明示し、長文には .xterm-screen の実幅を明示する。
   * 長文時は要素を画面左端へ translate し、最初の行だけ cursorLeft 分 indent する。
   * これにより1行目はカーソルから右端まで、2行目以降は通常の端末と同じ全幅を
   * 使える。下端を超える分だけ上へ移動し、ペイン外のステータス行にも重ねない。
   * textarea の left/top は一切変更せず、IME 候補位置の基準は xterm に任せる。
   */
  /**
   * 変換文字列を span で包み、背景をその span にだけ付ける。
   *
   * xterm 本体は .composition-view 全体へ不透明な黒を敷く。折り返しのために
   * 要素を端末全幅へ広げると、1行目の text-indent より左（＝カーソルより手前に
   * 既に入力済みの文字）まで黒が覆い、確定済みの文字が見えなくなる。
   * 背景を文字の背後だけに限定することでこれを防ぐ。
   *
   * xterm は textContent を書き直すので、既に包んであり内容も同じ場合は何もしない
   * （MutationObserver 経由で呼ばれるため、毎回書き換えるとループになる）。
   */
  private wrapCompositionText(view: HTMLElement, text: string): void {
    const existing = view.firstElementChild;
    if (
      view.childNodes.length === 1 &&
      existing instanceof HTMLElement &&
      existing.classList.contains(COMPOSITION_TEXT_CLASS)
    ) {
      if (existing.textContent !== text) {
        existing.textContent = text;
      }
      return;
    }

    const span = window.document.createElement("span");
    span.className = COMPOSITION_TEXT_CLASS;
    span.textContent = text;
    view.replaceChildren(span);
  }

  private readonly layoutCompositionView = (): void => {
    const host = this.attachedHost;
    const view = host?.querySelector<HTMLElement>(".composition-view");
    if (!host || !view) {
      return;
    }
    if (!view.classList.contains("active")) {
      this.resetCompositionViewLayout(view);
      return;
    }

    const text = view.textContent ?? "";
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const cursorLeft = Number.parseFloat(view.style.left);
    const cursorTop = Number.parseFloat(view.style.top);
    const cellHeight = Number.parseFloat(view.style.lineHeight);
    const screenBounds = screen?.getBoundingClientRect();
    if (
      !text ||
      !screenBounds ||
      screenBounds.width < 1 ||
      screenBounds.height < 1 ||
      !Number.isFinite(cursorLeft) ||
      !Number.isFinite(cursorTop) ||
      !Number.isFinite(cellHeight) ||
      cellHeight <= 0
    ) {
      return;
    }

    // 背景を「文字の背後だけ」に限定する。
    // xterm 本体は要素全体へ不透明な黒を敷くが、折り返しのため要素を端末全幅まで
    // 広げると、1行目の text-indent より左（＝カーソルより手前にある入力済みの
    // 文字）まで黒く覆い、確定済みの文字が見えなくなる。テキストを span で包み、
    // 背景をその span にだけ付ける（CSS 側で box-decoration-break:clone 指定）。
    this.wrapCompositionText(view, text);

    // 背景を「1行目だけ透明・2行目以降は不透明」に切り替えるための境界。
    // 1行目はカーソル行なので透かして既入力を見せ、2行目以降は下の会話へ
    // 重なるため塗り潰す（CSS の linear-gradient がこの値を使う）。
    const lineHeightValue = `${cellHeight}px`;
    if (
      view.style.getPropertyValue("--composition-line-height") !==
      lineHeightValue
    ) {
      view.style.setProperty("--composition-line-height", lineHeightValue);
    }

    // clientWidth は整数へ丸まるため、実際の描画幅を超えないよう rect を切り下げる。
    const screenWidth = Math.max(1, Math.floor(screenBounds.width));
    const horizontal = resolveCompositionHorizontalLayout({
      cursorLeftPx: cursorLeft,
      naturalWidthPx: this.measureCompositionText(view, text),
      screenWidthPx: screenWidth,
    });
    const width = `${horizontal.viewWidthPx}px`;
    const textIndent = `${horizontal.textIndentPx}px`;
    if (view.style.maxWidth) {
      view.style.removeProperty("max-width");
    }
    if (view.style.width !== width) {
      view.style.width = width;
    }
    // height は書かない。styles.css が height:auto !important で押さえており、
    // ここから書き戻すと xterm の setTimeout(0) 再帰との往復になる（上記 CSS 参照）。
    if (view.style.textIndent !== textIndent) {
      view.style.textIndent = textIndent;
    }

    const wrappedHeight = Math.max(
      cellHeight,
      view.scrollHeight,
      view.getBoundingClientRect().height,
    );
    const translateY = resolveCompositionTranslateY({
      cellHeightPx: cellHeight,
      cursorTopPx: cursorTop,
      screenHeightPx: screenBounds.height,
      wrappedHeightPx: wrappedHeight,
    });
    const transform = `translate(${horizontal.translateXPx}px, ${translateY}px)`;
    if (view.style.transform !== transform) {
      view.style.transform = transform;
    }

    // xterm の再帰更新は composition-view の全幅を textarea に複写する。表示要素を
    // 左へ広げた分は候補位置に不要なので、従来どおりカーソルから右端までに戻す。
    // left/top は触らないため、OS の候補ウィンドウ基準は変わらない。
    const textarea = this.terminal.textarea;
    const helperWidth = `${horizontal.helperWidthPx}px`;
    if (textarea && textarea.style.width !== helperWidth) {
      textarea.style.width = helperWidth;
    }
  };

  attach(host: HTMLElement): void {
    this.attachedHost = host;
    if (this.compositionObserver === undefined) {
      // .composition-view は変換のたびに表示/更新されるため、属性と内容の
      // 変化を監視して都度レイアウトし直す。同じ監視で DOM レンダラが追加した
      // span だけも拾い、端末ごと・行ごとの MutationObserver は増やさない。
      this.compositionObserver = new window.MutationObserver((records) => {
        // 自分が書いた変更で再び呼ばれないようにする。
        //
        // この監視は style 属性も対象にしている一方、コールバックから呼ぶ
        // layoutCompositionView() は .composition-view の style を書き換える。
        // そのため書き込みが次の Mutation を生み、呼び出しが連鎖していた。
        //
        // 実測（IME で「あ」を10文字ぶん変換）: composition-view の属性変更が
        // 221 回、getBoundingClientRect が 624 回。1文字あたり約22回の
        // 書き換えと約62回のレイアウト読み取りが起きており、これが日本語入力中の
        // ちらつきとして見えていた。
        if (this.suppressCompositionObserver) {
          return;
        }
        this.suppressCompositionObserver = true;
        try {
          this.layoutCompositionView();
          this.decorateAddedEmojiSpans(records);
        } finally {
          // 自分の書き込みが記録されたキューを捨ててから監視を戻す。
          this.compositionObserver?.takeRecords();
          this.suppressCompositionObserver = false;
        }
      });
    }
    if (this.paneScrollHost !== host) {
      this.paneScrollHost
        ?.closest<HTMLElement>(".terminal-pane")
        ?.removeEventListener("scroll", this.resetPaneScroll);
      host
        .closest<HTMLElement>(".terminal-pane")
        ?.addEventListener("scroll", this.resetPaneScroll);
      this.paneScrollHost = host;
    }
    this.diagnosticKeydownHost = rebindCaptureKeydown(
      this.diagnosticKeydownHost,
      host,
      this.handleDiagnosticKeydown,
    ) as HTMLElement;

    // Enter 系は host（祖先要素）の capture に張る。textarea へ張ると、
    // xterm が open() 内で先に登録した capture リスナのほうが先に走り
    // （同一 target・同一フェーズでは登録順）、Shift を無視して CR を
    // 送られてしまう。祖先の capture なら xterm より確実に先を取れる。
    //
    // ここは open 済みかどうかに関わらず、attach のたびに現在の host へ
    // 張り替える。host は React が作り直す（タブ切替・ペイン分割で別の
    // div になる）ため、open 時の 1 回だけ登録すると、リスナは捨てられた
    // 旧 host に残り、以後 Shift+Enter が二度と拾えなくなる。
    // 実測: 39,585 件の keydown すべてで handleLineFeedKey が未発火。
    // 同じ host に張っている handleDiagnosticKeydown（毎回張り替え）だけが
    // 発火していたことが、host が差し替わっている証拠だった。
    this.lineFeedHost = rebindCaptureKeydown(
      this.lineFeedHost,
      host,
      this.handleLineFeedKey,
    ) as HTMLElement;

    if (!this.opened) {
      host.replaceChildren();
      this.terminal.open(host);
      this.disposeCompositionSync = synchronizeCompositionPosition(this.terminal);
      this.opened = true;
      this.observeFontReadiness();
      // Ctrl+V を確実に捕まえるため、xterm の入力先 textarea に capture フェーズで
      // keydown を張る。xterm 内部処理より前に奪って自前ペーストに回す。
      const textarea = this.terminal.textarea;
      textarea?.addEventListener("keydown", this.handlePasteKey, true);
      // フォーカス時のブラウザ自動スクロールを打ち消す（右端が切れる原因）。
      textarea?.addEventListener("focus", this.resetPaneScroll);
      // IME 変換のたびに基準値を取り直す（変換開始位置は毎回変わる）。
      // capture フェーズで登録する。xterm 内部の compositionstart ハンドラが
      // isComposing を立てる前に同期しないと、_syncTextArea が即 return する。
      textarea?.addEventListener(
        "compositionstart",
        this.handleCompositionStart,
        true,
      );
      // IME 変換表示が枠を突き抜けないよう、表示・更新のたびに位置を補正する。
      const xtermElement = this.terminal.element;
      if (xtermElement && this.compositionObserver) {
        this.compositionObserver.observe(xtermElement, {
          attributeFilter: ["class", "style"],
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      }
      logRendererDiagnostic(
        DIAGNOSTIC_CATEGORIES.terminalKeydownListener,
        {
          diagnosticHostObserverRegistered:
            this.diagnosticKeydownHost === host,
          // textarea の有無ではなく、実際に張った host を見る。
          // 以前は textarea !== undefined を報告していたため、リスナが
          // 旧 host に取り残されていても "registered: true" と出ていた。
          lineFeedHandlerRegistered: this.lineFeedHost === host,
          pasteHandlerRegistered: textarea !== undefined,
          sessionId: this.sessionId,
          textareaAvailable: textarea !== undefined,
        },
      );
    } else if (
      this.terminal.element &&
      this.terminal.element.parentElement !== host
    ) {
      // host は React に再利用されるため、append だと以前のセッションの
      // xterm 要素が残る。常に1 host = 1 terminal に保つ。
      host.replaceChildren(this.terminal.element);
    }

    this.scheduleWebglInitialization();
    this.fit(host);
    // フォーカスが入った直後にブラウザが横スクロールさせるため、ここでも打ち消す。
    this.resetPaneScroll();
  }

  detach(host: HTMLElement): void {
    if (this.paneScrollHost === host) {
      host
        .closest<HTMLElement>(".terminal-pane")
        ?.removeEventListener("scroll", this.resetPaneScroll);
      this.paneScrollHost = undefined;
    }
    if (this.attachedHost === host) {
      this.attachedHost = undefined;
    }
    if (this.diagnosticKeydownHost === host) {
      host.removeEventListener(
        "keydown",
        this.handleDiagnosticKeydown,
        true,
      );
      this.diagnosticKeydownHost = undefined;
    }
    if (this.lineFeedHost === host) {
      host.removeEventListener("keydown", this.handleLineFeedKey, true);
      this.lineFeedHost = undefined;
    }
    if (this.terminal.element?.parentElement === host) {
      this.terminal.element.remove();
    }
  }

  fit(host: HTMLElement, forceResize = false): boolean {
    const hostWidthPx = host.clientWidth;
    const hostHeightPx = host.clientHeight;
    if (!this.opened || hostWidthPx < 10 || hostHeightPx < 10) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalFit, {
        actualCols: this.terminal.cols,
        actualRows: this.terminal.rows,
        charHeightPx: "unavailable",
        charWidthPx: "unavailable",
        expectedColsFromHost: "unavailable",
        fitExecuted: false,
        forceResize,
        hostHeightPx,
        hostWidthPx,
        proposedCols: "unavailable",
        proposedRows: "unavailable",
        resizeSessionInvoked: false,
        sessionId: this.sessionId,
        skippedReason: !this.opened
          ? "terminal-not-opened"
          : "host-too-small",
      });
      return false;
    }

    let proposal: { cols: number; rows: number } | undefined;
    let proposalErrorName: string | null = null;
    try {
      proposal = this.fitAddon.proposeDimensions();
    } catch (error: unknown) {
      proposalErrorName = error instanceof Error ? error.name : "unknown";
    }

    this.fitAddon.fit();
    const nextSize = {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
    const resizeSessionInvoked = shouldSendTerminalResize({
      fontsReady: this.fontsReady,
      force: forceResize,
      next: nextSize,
      previous: this.lastReportedSize,
    });
    const cell = this.measureCharacterCell();
    if (typeof cell.charWidthPx === "number") {
      this.updateEmojiCellWidth(cell.charWidthPx);
    }
    const expectedColsFromHost =
      typeof cell.charWidthPx === "number"
        ? Math.floor(hostWidthPx / cell.charWidthPx)
        : "unavailable";
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalFit, {
      actualCols: nextSize.cols,
      actualRows: nextSize.rows,
      charHeightPx: cell.charHeightPx,
      charMeasurementSource: cell.source,
      charWidthPx: cell.charWidthPx,
      expectedColsFromHost,
      fitExecuted: true,
      fontsReady: this.fontsReady,
      forceResize,
      hostHeightPx,
      hostWidthPx,
      proposalErrorName,
      proposedCols: proposal?.cols ?? "unavailable",
      proposedRows: proposal?.rows ?? "unavailable",
      resizeSessionInvoked,
      sessionId: this.sessionId,
      ...(!this.fontsReady
        ? { skippedReason: "fonts-not-ready" }
        : {}),
      terminalElementHeightPx:
        this.terminal.element?.clientHeight ?? "unavailable",
      terminalElementWidthPx:
        this.terminal.element?.clientWidth ?? "unavailable",
      webglEnabled: this.webglAddon !== undefined,
    });
    if (resizeSessionInvoked) {
      cockpitApi.resizeSession({
        ...nextSize,
        sessionId: this.sessionId,
        sizeSettled: this.sizeSettled,
      });
      this.lastReportedSize = nextSize;
    }
    // 確定判定は「送ったかどうか」ではなく fit が走るたびに仕掛け直す。
    // 送信は寸法が変わったときだけなので、そこに紐づけると
    // 「最初の寸法のまま動かなかった」場合に確定がいつまでも伝わらない。
    if (!this.sizeSettled) {
      this.scheduleSizeStableNotification(nextSize);
    }
    // 変換中のリサイズでは折返し幅と上方向の退避量も同じフレームで更新する。
    this.layoutCompositionView();
    return true;
  }

  /**
   * サイズが動かなくなったことを検知して pty へ「確定」を伝える。
   *
   * 以前は WebGL のロード完了をもって確定としていたが、それは
   * レイアウトの確定とは別物だった。実測では WebGL は 0.4 秒で終わる一方、
   * ウィンドウのレイアウトが落ち着いたのは 9 秒後で、その間に
   * 85桁×41行 → 92桁×28行 と変わっていた。CLI は 85 桁で画面を描いた後に
   * 92 桁の枠へ置かれるため、起動直後からレイアウトが崩れていた。
   *
   * 全画面 TUI は pty の resize を受けても自発的には描き直さない。
   * 幅が変わった後に描き直させる確実な手段は端末への Ctrl+L だが、
   * それは「入力」であり画面クリアとして解釈されるため使えない
   * （実際に「勝手に clear が打たれる」として現れた）。
   * したがって、そもそも起動後に幅を変えないことが要になる。
   */
  private scheduleSizeStableNotification(size: {
    cols: number;
    rows: number;
  }): void {
    if (this.sizeStableTimer !== undefined) {
      window.clearTimeout(this.sizeStableTimer);
    }
    this.sizeStableTimer = window.setTimeout(() => {
      this.sizeStableTimer = undefined;
      // この間にさらにリサイズが来ていれば、タイマーは張り直されている。
      // ここへ来たということは、この寸法で落ち着いたということ。
      if (this.disposed || !this.attachedHost) {
        return;
      }
      this.sizeSettled = true;
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalFit, {
        cols: size.cols,
        event: "size-stable",
        rows: size.rows,
        sessionId: this.sessionId,
      });
      cockpitApi.resizeSession({
        ...size,
        sessionId: this.sessionId,
        sizeSettled: true,
      });
    }, SIZE_STABLE_DELAY_MS);
  }

  focus(): void {
    this.terminal.focus();
  }

  /** このペインの CLI を覚える。改行シーケンスの選択に使う。 */
  setCommand(command: string): void {
    this.command = command;
  }

  setVisible(visible: boolean): void {
    if (this.terminal.element) {
      this.terminal.element.style.visibility = visible ? "" : "hidden";
    }
  }

  search(query: string, direction: "next" | "previous" = "next"): boolean {
    if (!query) {
      return false;
    }

    return direction === "next"
      ? this.searchAddon.findNext(query)
      : this.searchAddon.findPrevious(query);
  }

  write(data: string): void {
    this.lastOutputAt = Date.now();
    this.terminal.write(data);
  }

  /**
   * 出力が一定時間止まるまで待つ。
   *
   * CLI の起動完了を知る手段が端末には無いため、「描画が落ち着いたら
   * 入力を受け付けられる状態になった」とみなす。起動に失敗した場合に
   * 待ち続けないよう、上限を超えたら false を返す。
   */
  waitForOutputToSettle({
    quietMs,
    timeoutMs,
  }: {
    quietMs: number;
    timeoutMs: number;
  }): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    return new Promise<boolean>((resolve) => {
      const check = (): void => {
        if (this.disposed) {
          resolve(false);
          return;
        }
        // 一度も出力が来ていないなら、まだ起動していないとみなして待つ。
        const since =
          this.lastOutputAt === undefined
            ? 0
            : Date.now() - this.lastOutputAt;
        if (this.lastOutputAt !== undefined && since >= quietMs) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(check, Math.min(quietMs, 200));
      };

      check();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disposeCompositionSync?.();
    this.disposeCompositionSync = undefined;
    if (this.sizeStableTimer !== undefined) {
      window.clearTimeout(this.sizeStableTimer);
      this.sizeStableTimer = undefined;
    }
    this.compositionObserver?.disconnect();
    this.compositionObserver = undefined;
    this.compositionMeasureElement?.remove();
    this.compositionMeasureElement = undefined;
    this.terminal.textarea?.removeEventListener(
      "compositionstart",
      this.handleCompositionStart,
      true,
    );
    this.attachedHost = undefined;
    this.diagnosticKeydownHost?.removeEventListener(
      "keydown",
      this.handleDiagnosticKeydown,
      true,
    );
    this.diagnosticKeydownHost = undefined;
    this.terminal.textarea?.removeEventListener(
      "keydown",
      this.handlePasteKey,
      true,
    );
    // Enter 系は host（祖先）の capture に張っているので、そちらから外す。
    this.lineFeedHost?.removeEventListener(
      "keydown",
      this.handleLineFeedKey,
      true,
    );
    this.lineFeedHost = undefined;
    this.terminal.element?.remove();
    this.webglAddon?.dispose();
    this.terminal.dispose();
  }

  /**
   * グリフのテクスチャアトラスを作り直し、全行を描き直す。
   *
   * WebGL レンダラは「どの解像度で焼いたグリフか」を保持したアトラスから
   * 文字を貼るため、アトラスを焼いた後に条件が変わると、既に焼かれた
   * グリフが実際の描画条件と噛み合わなくなる。噛み合わなくなったグリフは
   * 欠けたり出なくなったりする（＝打った文字が画面に出ない）。
   *
   * アトラスが陳腐化する主な条件:
   *  - デバイスピクセル比の変化（別 DPI のモニターへウィンドウを移動、
   *    表示スケールの変更、サブモニターでの全画面化）
   *  - 日本語のように種類の多いグリフを長時間扱ってアトラスが詰まる場合
   *
   * どちらもウィンドウを動かす／サイズを変えるとアトラスが作り直されて
   * 直るため、「動かしたら直った」という形で現れる。ここを明示的に
   * 呼べるようにして、発生時に手動でも自動でも回復させる。
   */
  redraw(): void {
    const redrawAt = window.performance.now();
    const secondsSincePreviousRedraw =
      this.lastRedrawAt === undefined
        ? null
        : Math.round(redrawAt - this.lastRedrawAt) / 1_000;
    this.lastRedrawAt = redrawAt;
    this.webglAddon?.clearTextureAtlas();
    this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      devicePixelRatio: window.devicePixelRatio,
      event: "redraw",
      secondsSincePreviousRedraw,
      sessionId: this.sessionId,
      textureAtlasCleared: this.webglAddon !== undefined,
    });
  }
}

class TerminalRegistry {
  private readonly controllers = new Map<string, TerminalController>();

  private devicePixelRatioQuery: globalThis.MediaQueryList | undefined;

  /**
   * Enter と Shift+Enter の割り当て。
   *
   * 設定は画面から切り替えられるため、ペインごとに写しを持たず、押された
   * 瞬間にここを読む。写しにすると、設定を変えたあと既存のペインだけ古い
   * 割り当てのまま残る。
   */
  private enterRole: TerminalEnterRole = "submit";

  /** 追い打ちの再描画タイマー（連続要求では最後の 1 回だけ残す）。 */
  private followUpRedrawTimer: number | undefined;

  /** 直近に redrawAll が要求された時刻。予防再描画の無駄打ちを防ぐ。 */
  private lastRedrawAt: number | undefined;

  /** ペインがある間だけ張る予防再描画タイマー。 */
  private preventiveRedrawTimer: number | undefined;

  constructor() {
    // 自動判定が入る前の手動フラグが残っていると、判定を上書きして
    // 不要に WebGL を切ったままにしてしまう。起動時に一度だけ掃除する。
    clearLegacyWebglDisableFlag();
    this.watchDevicePixelRatio();
  }

  /** 押された瞬間の割り当てを返す。コントローラから参照する。 */
  getEnterRole(): TerminalEnterRole {
    return this.enterRole;
  }

  /** 設定が変わったら呼ぶ。開いているペインにも即座に効く。 */
  setEnterRole(role: TerminalEnterRole): void {
    this.enterRole = role;
  }

  /**
   * デバイスピクセル比の変化を監視し、全ペインのアトラスを作り直す。
   *
   * 別 DPI のモニターへウィンドウを移した時、Windows の表示スケールを
   * 変えた時、サブモニターで全画面にした時に比率が変わる。xterm の WebGL
   * レンダラはこの変化を自力では検知しないため、焼き済みのグリフが
   * 噛み合わなくなり文字が出なくなることがある。
   *
   * resize イベントでは拾えない（モニター間の移動ではウィンドウサイズが
   * 変わらないことがある）ため、比率そのものを見張る。matchMedia は
   * 現在の比率にしか反応しないので、発火のたびに次の比率で貼り直す。
   */
  private watchDevicePixelRatio(): void {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const ratio = window.devicePixelRatio;
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    this.devicePixelRatioQuery?.removeEventListener(
      "change",
      this.handleDevicePixelRatioChange,
    );
    query.addEventListener("change", this.handleDevicePixelRatioChange, {
      once: true,
    });
    this.devicePixelRatioQuery = query;
  }

  private readonly handleDevicePixelRatioChange = (): void => {
    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      devicePixelRatio: window.devicePixelRatio,
      event: "device-pixel-ratio-change",
      paneCount: this.controllers.size,
    });
    this.redrawAll();
    // 次の比率を見張り直す。
    this.watchDevicePixelRatio();
  };

  private readonly handleVisibilityChange = (): void => {
    if (
      document.visibilityState !== "visible" ||
      this.controllers.size === 0
    ) {
      return;
    }

    if (isPreventiveRedrawDisabledByUser()) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "preventive-redraw-skipped",
        paneCount: this.controllers.size,
        reason: "disabled-by-user",
        trigger: "visibility-restored",
      });
      return;
    }

    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      event: "preventive-redraw",
      paneCount: this.controllers.size,
      reason: "visibility-restored",
    });
    // 復帰直後はアトラスが最も怪しい局面なので、直前の再描画から
    // 60 秒未満でも必ず作り直す。定期実行の無駄打ちガードは適用しない。
    this.redrawAll();
  };

  private runPreventiveRedraw(): void {
    const lastRedrawAgoMs =
      this.lastRedrawAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, window.performance.now() - this.lastRedrawAt);
    const paneCount = this.controllers.size;

    if (isPreventiveRedrawDisabledByUser()) {
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "preventive-redraw-skipped",
        paneCount,
        reason: "disabled-by-user",
        trigger: "interval",
      });
      return;
    }

    const isHidden = document.visibilityState === "hidden";
    if (
      !shouldRunPreventiveRedraw({
        isHidden,
        lastRedrawAgoMs,
        minGapMs: PREVENTIVE_REDRAW_MIN_GAP_MS,
        paneCount,
      })
    ) {
      const reason =
        paneCount === 0
          ? "no-panes"
          : isHidden
            ? "document-hidden"
            : "minimum-gap";
      logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
        event: "preventive-redraw-skipped",
        lastRedrawAgoMs: Number.isFinite(lastRedrawAgoMs)
          ? Math.round(lastRedrawAgoMs)
          : null,
        paneCount,
        reason,
        trigger: "interval",
      });
      return;
    }

    logRendererDiagnostic(DIAGNOSTIC_CATEGORIES.terminalWebgl, {
      event: "preventive-redraw",
      paneCount,
      reason: "interval",
    });
    this.redrawAll();
  }

  private schedulePreventiveRedraw(): void {
    if (
      this.controllers.size === 0 ||
      this.preventiveRedrawTimer !== undefined
    ) {
      return;
    }

    this.preventiveRedrawTimer = window.setTimeout(() => {
      this.preventiveRedrawTimer = undefined;
      this.runPreventiveRedraw();
      this.schedulePreventiveRedraw();
    }, PREVENTIVE_REDRAW_INTERVAL_MS);
  }

  private startPreventiveRedraw(): void {
    document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.schedulePreventiveRedraw();
  }

  private stopPreventiveRedraw(): void {
    if (this.preventiveRedrawTimer !== undefined) {
      window.clearTimeout(this.preventiveRedrawTimer);
      this.preventiveRedrawTimer = undefined;
    }
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  /**
   * 全ペインを描き直す。表示が壊れた時の回復手段。
   *
   * 一度では直らないことがある。実測でも、利用者が Ctrl+Shift+R を
   * 押しても直らず 2〜3 回連打していた記録が残っている
   * （01:54:48/49/50、08:48:43/46）。作り直したアトラスが、描画基盤が
   * まだ落ち着いていない段階では再び失効するためと見ている。
   *
   * そこで少し間を置いてもう一度描き直す。CLI へは何も送らないので、
   * 余分に実行しても副作用はない。
   */
  redrawAll(): void {
    this.lastRedrawAt = window.performance.now();
    this.redrawAllOnce();

    if (this.followUpRedrawTimer !== undefined) {
      window.clearTimeout(this.followUpRedrawTimer);
    }
    this.followUpRedrawTimer = window.setTimeout(() => {
      this.followUpRedrawTimer = undefined;
      this.redrawAllOnce();
    }, FOLLOW_UP_REDRAW_DELAY_MS);
  }

  private redrawAllOnce(): void {
    for (const controller of this.controllers.values()) {
      controller.redraw();
    }
  }

  ensure(sessionId: string, command?: string): TerminalController {
    const existing = this.controllers.get(sessionId);
    if (existing) {
      // 復元されたセッションは最初の ensure で command を持たないことがある。
      // 後から分かった時点で反映する（改行シーケンスの判定に使う）。
      if (command !== undefined) {
        existing.setCommand(command);
      }
      return existing;
    }

    const controller = new TerminalController(sessionId);
    if (command !== undefined) {
      controller.setCommand(command);
    }
    this.controllers.set(sessionId, controller);
    if (this.controllers.size === 1) {
      this.startPreventiveRedraw();
    }
    return controller;
  }

  remove(sessionId: string): void {
    this.controllers.get(sessionId)?.dispose();
    this.controllers.delete(sessionId);
    if (this.controllers.size === 0) {
      this.stopPreventiveRedraw();
    }
  }

  setVisible(sessionId: string, visible: boolean): void {
    this.controllers.get(sessionId)?.setVisible(visible);
  }

  write(sessionId: string, data: string): void {
    this.ensure(sessionId).write(data);
  }

  waitForOutputToSettle(
    sessionId: string,
    options: { quietMs: number; timeoutMs: number },
  ): Promise<boolean> {
    return this.ensure(sessionId).waitForOutputToSettle(options);
  }

  searchAll(query: string): SearchMatch[] {
    const matches: SearchMatch[] = [];
    for (const [sessionId, controller] of this.controllers) {
      if (controller.search(query)) {
        matches.push({ sessionId });
      }
    }
    return matches;
  }

  searchIn(
    sessionId: string,
    query: string,
    direction: "next" | "previous",
  ): boolean {
    return this.controllers.get(sessionId)?.search(query, direction) ?? false;
  }
}

export const terminalRegistry = new TerminalRegistry();
export type { TerminalController };
