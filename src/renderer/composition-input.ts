import type { Terminal } from "@xterm/xterm";

interface CompositionInputHelper {
  readonly isComposing: boolean;
  _isComposing: boolean;
  _isSendingComposition: boolean;
  compositionend: () => void;
}

/**
 * xterm 6.0.0 は確定文字を古い textarea の末尾位置から切り出す。
 * Windows の IME が既存の値を置換すると、その位置より短い確定文字は消える。
 * Electron の compositionend が持つ確定文字を使い、textarea は変更しない。
 * https://github.com/xtermjs/xterm.js/issues/6049
 *
 * 内部状態への依存はここだけに閉じる。keydown による先行確定は xterm に任せ、
 * その後の compositionend から同じ文字を二度送らない。変換の取消も送信しない。
 */
export function synchronizeCompositionInput(
  terminal: Terminal,
  onDiagnostic?: (fields: Record<string, unknown>) => void,
): () => void {
  const helper = (terminal as unknown as {
    _core?: { _compositionHelper?: CompositionInputHelper };
  })._core?._compositionHelper;
  const textarea = terminal.textarea;
  const view = terminal.element?.querySelector(".composition-view");
  if (
    !helper || !textarea || !view ||
    typeof helper.compositionend !== "function" ||
    typeof helper._isComposing !== "boolean" ||
    typeof helper._isSendingComposition !== "boolean"
  ) {
    return () => undefined;
  }

  let committedText: string | undefined;
  const captureCommit = (event: globalThis.CompositionEvent): void => {
    committedText = event.data;
  };
  const reportStart = (): void => {
    const bounds = textarea.getBoundingClientRect();
    // 診断には入力内容を含めず、矩形・文字数・フォーカス状態だけを記録する。
    onDiagnostic?.({
      event: "composition-start",
      focused: textarea.ownerDocument.activeElement === textarea,
      height: bounds.height,
      width: bounds.width,
      x: bounds.x,
      y: bounds.y,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      valueLength: textarea.value.length,
      synchronizedOutput: terminal.modes.synchronizedOutputMode,
    });
  };
  const compositionend = helper.compositionend;
  helper.compositionend = () => {
    const text = committedText;
    committedText = undefined;
    // DOM イベントを伴わない内部呼び出しは既存の動作を保つ。
    if (text === undefined) {
      compositionend.call(helper);
      return;
    }
    const wasComposing = helper.isComposing;
    helper._isComposing = false;
    helper._isSendingComposition = false;
    view.classList.remove("active");
    onDiagnostic?.({
      event: "composition-end",
      committedLength: text.length,
      emittedLength: wasComposing ? text.length : 0,
      wasComposing,
    });
    if (wasComposing && text.length > 0) {
      terminal.input(text, true);
    }
  };
  textarea.addEventListener("compositionend", captureCommit, true);
  textarea.addEventListener("compositionstart", reportStart);

  return () => {
    textarea.removeEventListener("compositionend", captureCommit, true);
    textarea.removeEventListener("compositionstart", reportStart);
    helper.compositionend = compositionend;
    committedText = undefined;
  };
}
