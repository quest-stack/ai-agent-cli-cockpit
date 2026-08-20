interface TerminalKeyEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  keyCode: number;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

const TERMINAL_ENTER_CODES = new Set(["Enter", "NumpadEnter"]);

// CSI-u (extended keys / modifyOtherKeys) では Shift+Enter を ESC [ 13 ; 2 u と表す。
// Claude Code は extended keys で Shift+Enter を識別し、公式 terminal-config も tmux で
// extended-keys を必須としている。過去の plain "\n" と ESC+CR ("\x1b\r") は、どちらも
// pty まで到達したが改行として認識されなかったため、これらへ戻してはならない。
export const TERMINAL_MANUAL_NEWLINE_SEQUENCE = "\x1b[13;2u";

export type TerminalKeyAction =
  | "copy-selection"
  | "passthrough";

/**
 * 実測した 1 文字ぶんのセル幅が、値として信用できるか。
 *
 * 幅の測定には xterm の `.xterm-char-measure-element` を読むが、この要素は
 * xterm が測定のたびに中身を書き換える。測っている最中に読むと、複数文字が
 * 入った状態の幅を掴むことがある（実測 243.75px。本来は 7px 前後で、約 35 倍）。
 *
 * この値をそのまま使うと桁数が極端に少なく算出され（実測 2 桁）、その幅で
 * CLI が描き始めるため、起動直後からレイアウトが崩れる。ウィンドウサイズを
 * 変えると測り直されて直る、という形で現れる。
 *
 * フォントサイズ 13px・行高 1.24 の等幅フォントで、1 文字の幅が 40px を
 * 超えることはない。範囲外はフォント読み込み前や測定中の値として捨てる。
 */
const MIN_PLAUSIBLE_CHAR_WIDTH_PX = 1;
const MAX_PLAUSIBLE_CHAR_WIDTH_PX = 40;

export function isPlausibleCharacterWidth(widthPx: number): boolean {
  return (
    Number.isFinite(widthPx) &&
    widthPx >= MIN_PLAUSIBLE_CHAR_WIDTH_PX &&
    widthPx <= MAX_PLAUSIBLE_CHAR_WIDTH_PX
  );
}

export interface CaptureKeydownTarget {
  addEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: { capture: true },
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: { capture: true },
  ): void;
}

/**
 * capture フェーズの keydown リスナを、常に「今の host」へ張り替える。
 *
 * host（ペインの div）は React が作り直すため、ターミナルを開いた時に
 * 1 回だけ登録すると、リスナは捨てられた古い host に取り残される。
 * xterm 本体は host を移し替えても生き続けるので、見た目は動いていながら
 * キーだけ拾えない状態になる。実際に Shift+Enter がこの形で死んでいた
 * （39,585 件の keydown すべてでハンドラ未発火）。
 *
 * 呼び出し側は戻り値を「今どこに張っているか」として保持する。
 */
export function rebindCaptureKeydown(
  previousHost: CaptureKeydownTarget | undefined,
  nextHost: CaptureKeydownTarget,
  listener: (event: KeyboardEvent) => void,
): CaptureKeydownTarget {
  if (previousHost === nextHost) {
    return nextHost;
  }

  previousHost?.removeEventListener("keydown", listener, { capture: true });
  nextHost.addEventListener("keydown", listener, { capture: true });
  return nextHost;
}

/**
 * IME 変換中（確定前）の Enter は「変換の確定」であって改行ではない。
 *
 * 日本語を変換中に Shift+Enter を押すと、IME は変換を確定させるだけで
 * 改行の意図はない。ここで CSI-u を送ってしまうと、確定した文字が入力欄に
 * 残ったまま改行/送信まで走る（実測: isComposing=true かつ shiftKey=true の
 * keydown が発生していた）。
 *
 * isComposing は環境によって立たないことがあるため、IME 処理中を表す
 * 慣習的な keyCode 229 も併せて弾く。
 */
function isImeComposing(event: TerminalKeyEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === "Process";
}

export function isTerminalLineFeedKey(event: TerminalKeyEvent): boolean {
  return (
    event.type === "keydown" &&
    (event.key === "Enter" || TERMINAL_ENTER_CODES.has(event.code)) &&
    event.shiftKey &&
    !isImeComposing(event) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export function getTerminalManualNewlineSequence(
  event: TerminalKeyEvent,
): string | undefined {
  return isTerminalLineFeedKey(event)
    ? TERMINAL_MANUAL_NEWLINE_SEQUENCE
    : undefined;
}

export type TerminalEnterDisposition =
  | "ime-first-keydown"
  | "ime-second-keydown"
  | "manual-newline"
  | "delegate-to-xterm";

/**
 * IME 変換中の Shift+Enter に伴う 2 回の keydown を状態として追い、
 * それぞれをどう扱うかを決める。
 *
 * Windows の IME は変換中の Shift+Enter で
 *   1回目: keyCode 229 / key "Process" / isComposing true（IME が確定に消費）
 *   2回目: 通常の Enter（keyCode 13 / isComposing false）
 * を発火する。2 回目は IME 由来だと単体では判定できないため、
 * 1 回目を見たかどうかを呼び出し側が保持して渡す。
 *
 * どちらも端末へ送ってはならない。1 回目で改行を送ると「確定 + 改行」になり、
 * 2 回目を素通しすると xterm が CR（＝送信）にしてしまう。
 */
export function resolveTerminalEnterDisposition(
  event: TerminalKeyEvent,
  pendingImeEnterSuppression: boolean,
): TerminalEnterDisposition {
  const isEnterKey =
    event.code === "Enter" ||
    event.code === "NumpadEnter" ||
    event.key === "Enter";
  const isImeConsumed =
    event.isComposing || event.keyCode === 229 || event.key === "Process";

  if (isEnterKey && event.shiftKey && isImeConsumed) {
    return "ime-first-keydown";
  }
  if (isEnterKey && pendingImeEnterSuppression) {
    return "ime-second-keydown";
  }
  return getTerminalManualNewlineSequence(event) === undefined
    ? "delegate-to-xterm"
    : "manual-newline";
}

export function resolveTerminalKeyAction(
  event: TerminalKeyEvent,
  hasSelection: boolean,
): TerminalKeyAction {
  if (
    event.type === "keydown" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "c" &&
    hasSelection
  ) {
    return "copy-selection";
  }

  return "passthrough";
}

interface TerminalSize {
  cols: number;
  rows: number;
}

export function shouldReportTerminalResize(
  previous: TerminalSize | undefined,
  next: TerminalSize,
  force: boolean,
): boolean {
  return (
    force ||
    !previous ||
    previous.cols !== next.cols ||
    previous.rows !== next.rows
  );
}

interface ShouldSendTerminalResizeOptions {
  fontsReady: boolean;
  force: boolean;
  next: TerminalSize;
  previous: TerminalSize | undefined;
}

export function shouldSendTerminalResize({
  fontsReady,
  force,
  next,
  previous,
}: ShouldSendTerminalResizeOptions): boolean {
  return (
    fontsReady && shouldReportTerminalResize(previous, next, force)
  );
}

interface ScheduleTerminalFitOptions {
  cancelFrame: (frameId: number) => void;
  getHostSize: () => {
    height: number;
    width: number;
  };
  onReady: () => void;
  requestFrame: (callback: () => void) => number;
}

const MIN_TERMINAL_HOST_SIZE = 10;
const REQUIRED_VISIBLE_FRAMES = 2;

export function scheduleTerminalFitAfterReveal({
  cancelFrame,
  getHostSize,
  onReady,
  requestFrame,
}: ScheduleTerminalFitOptions): () => void {
  let cancelled = false;
  let pendingFrame: number | undefined;
  let visibleFrames = 0;

  const checkLayout = (): void => {
    pendingFrame = undefined;
    if (cancelled) {
      return;
    }

    const { height, width } = getHostSize();
    if (
      width >= MIN_TERMINAL_HOST_SIZE &&
      height >= MIN_TERMINAL_HOST_SIZE
    ) {
      visibleFrames += 1;
    } else {
      visibleFrames = 0;
    }

    if (visibleFrames >= REQUIRED_VISIBLE_FRAMES) {
      onReady();
      return;
    }

    pendingFrame = requestFrame(checkLayout);
  };

  pendingFrame = requestFrame(checkLayout);

  return () => {
    cancelled = true;
    if (pendingFrame !== undefined) {
      cancelFrame(pendingFrame);
      pendingFrame = undefined;
    }
  };
}
