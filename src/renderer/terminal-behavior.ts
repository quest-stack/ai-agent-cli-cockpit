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
// extended-keys を必須としている。過去の plain "\n" は pty まで到達したが改行として
// 認識されなかったため、これへ戻してはならない。
export const TERMINAL_MANUAL_NEWLINE_SEQUENCE = "\x1b[13;2u";

/**
 * Codex CLI へ送る改行（ESC+CR = Alt+Enter）。
 *
 * Codex は CSI-u を解釈する実装を持つが、それには端末が kitty keyboard protocol を
 * 有効化していることが要る。Cockpit が使う xterm.js 6.0.0 はこのプロトコルを
 * 実装しておらず（ライブラリ内に該当コードが無い）、Codex 側も起動時に有効化要求
 * (ESC [ > N u) を一度も送ってこない。つまりこの組み合わせでは CSI-u 経路が
 * 最初から成立せず、ESC [ 13 ; 2 u を送っても改行にならない。
 *
 * Codex 0.154.0 に対する実測（Cockpit と同じ pty・TERM=xterm-256color）:
 *   "\n"          → 改行にならない
 *   "\x1b[13;2u"  → 改行にならない
 *   "\x1b\r"      → 改行する（2回再現）
 *
 * Codex の既定キーマップは insert_newline に Alt+Enter を含んでおり、ESC+CR は
 * その Alt+Enter として解釈される。
 */
export const TERMINAL_CODEX_NEWLINE_SEQUENCE = "\x1b\r";

/**
 * CLI ごとの改行シーケンスを返す。
 *
 * Claude Code は CSI-u で改行できているため変えない。Codex だけ ESC+CR にする。
 * powershell など全画面 TUI でないものは、従来どおり CSI-u のまま（改行の概念が
 * 無く、送っても無視される）。
 */
export function getNewlineSequenceForCommand(
  command: string | undefined,
): string {
  return command === "codex"
    ? TERMINAL_CODEX_NEWLINE_SEQUENCE
    : TERMINAL_MANUAL_NEWLINE_SEQUENCE;
}

/**
 * 送信（CLI 側が「入力を確定して送る」と解釈するバイト）。
 *
 * xterm の内蔵エンコーダが Enter に対して送るものと同じ。Enter を改行へ
 * 割り当てたときは、素通しでは送信できなくなるため、こちらから明示的に送る。
 */
export const TERMINAL_SUBMIT_SEQUENCE = "\r";

/**
 * Enter と Shift+Enter の役割。
 *
 * 既定（"submit"）は CLI 本来の割り当てで、Enter が送信・Shift+Enter が改行。
 * "newline" にすると入れ替わり、Enter が改行・Shift+Enter が送信になる。
 * チャット欄の感覚に合わせたい利用者向けの選択で、既定は変えない。
 */
export type TerminalEnterRole = "newline" | "submit";

export type TerminalKeyAction =
  | "copy-selection"
  | "ignore"
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

/**
 * Cockpit が横取りして自前でバイトを送る Enter か。
 *
 * Shift+Enter は常に横取りする（xterm の内蔵エンコーダは Shift の有無に
 * かかわらず Enter を CR にしてしまい、改行として送れないため）。
 * Enter の入れ替えを有効にしている場合は、素の Enter も横取りする。
 */
export function isTerminalLineFeedKey(
  event: TerminalKeyEvent,
  enterRole: TerminalEnterRole = "submit",
): boolean {
  const isEnter =
    event.key === "Enter" || TERMINAL_ENTER_CODES.has(event.code);
  const hasOnlyShift = event.shiftKey;
  const isBare =
    !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

  return (
    event.type === "keydown" &&
    isEnter &&
    (hasOnlyShift || (enterRole === "newline" && isBare)) &&
    !isImeComposing(event) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export function getTerminalManualNewlineSequence(
  event: TerminalKeyEvent,
  enterRole: TerminalEnterRole = "submit",
  command?: string,
): string | undefined {
  if (!isTerminalLineFeedKey(event, enterRole)) {
    return undefined;
  }
  const newline = getNewlineSequenceForCommand(command);
  if (enterRole === "submit") {
    // 既定。Shift+Enter だけを改行として送る。
    return newline;
  }
  // 入れ替え時。Shift を伴うものが送信、素の Enter が改行。
  return event.shiftKey ? TERMINAL_SUBMIT_SEQUENCE : newline;
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
  enterRole: TerminalEnterRole = "submit",
  command?: string,
): TerminalEnterDisposition {
  const isEnterKey =
    event.code === "Enter" ||
    event.code === "NumpadEnter" ||
    event.key === "Enter";
  const isImeConsumed =
    event.isComposing || event.keyCode === 229 || event.key === "Process";

  // 変換中の Enter は「確定」であって、改行でも送信でもない。
  //
  // Shift を伴う場合は常に抑止する。素通しすると xterm が CR にしてしまい、
  // 変換確定と同時に送信されてしまう（実機で発生）。
  //
  // Shift なしの場合は割り当てによって分かれる。既定（Enter=送信）では xterm に
  // 委ねてよい。確定のあと CR が送られるのは、利用者が期待する動きに一致する。
  // 入れ替え時（Enter=改行）は抑止する。委ねると xterm の CR で送信されてしまい、
  // 「Enter では送信されない」という設定と食い違う。
  const suppressImeCommit = event.shiftKey || enterRole === "newline";
  if (isEnterKey && isImeConsumed && suppressImeCommit) {
    return "ime-first-keydown";
  }
  if (isEnterKey && pendingImeEnterSuppression) {
    return "ime-second-keydown";
  }
  return getTerminalManualNewlineSequence(event, enterRole, command) ===
    undefined
    ? "delegate-to-xterm"
    : "manual-newline";
}

export function resolveTerminalKeyAction(
  event: TerminalKeyEvent,
  hasSelection: boolean,
  ctrlCCopies = false,
): TerminalKeyAction {
  if (
    event.type === "keydown" &&
    event.ctrlKey &&
    (event.shiftKey || ctrlCCopies) &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "c"
  ) {
    if (hasSelection) {
      return "copy-selection";
    }
    // コピーしようとして選択が外れていても、作業を中断しない。
    if (ctrlCCopies) {
      return "ignore";
    }
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

/**
 * pty へ resize を送るか。
 *
 * force は「非表示から戻した後、確定サイズを必ず一度は伝える」ためのもので、
 * まだ一度も通知していない（previous が無い）ときに効かせる。
 *
 * 一方、既に同じ寸法を通知済みなら force でも送らない。claude/codex のような
 * 全画面 TUI は寸法が変わらない resize でも画面全体を描き直すため、タブを
 * 表示するたびに送ると入力中のちらつきになる（実測: 159x37 のまま変化が無いのに
 * 18 秒間に 5 回送信されていた）。送らなくても寸法は既に正しく伝わっている。
 */
export function shouldSendTerminalResize({
  fontsReady,
  force,
  next,
  previous,
}: ShouldSendTerminalResizeOptions): boolean {
  if (!fontsReady) {
    return false;
  }
  if (previous && previous.cols === next.cols && previous.rows === next.rows) {
    return false;
  }
  return shouldReportTerminalResize(previous, next, force);
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
