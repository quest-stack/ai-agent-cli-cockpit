import type { Terminal } from "@xterm/xterm";

interface CompositionInputHelper {
  readonly isComposing: boolean;
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _handleAnyTextareaChanges: () => void;
  compositionend: () => void;
}

interface PendingTextareaDiff {
  keydownSequence: number;
  followedByComposition: boolean;
  timer: number;
}

function insertedText(before: string, after: string): string {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return after.slice(prefix, after.length - suffix);
}

/**
 * xterm 6.0.0 は確定文字を古い textarea の末尾位置から切り出す。
 * Windows の IME が既存の値を置換すると、その位置より短い確定文字は消える。
 * Electron の compositionend が持つ確定文字を使い、textarea は変更しない。
 * event.data が空のIMEでは、イベント後のtextarea差分を補助経路にする。
 * https://github.com/xtermjs/xterm.js/issues/6049
 *
 * 内部状態への依存はここだけに閉じる。keydown による先行確定は xterm に任せ、
 * その後の compositionend から同じ文字を二度送らない。変換の取消も送信しない。
 * keyCode 229 の直後に変換が始まる場合、xterm の遅延 textarea 差分が
 * 確定文字を再送するため、そのキーに対応する差分だけ無効にする。
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
    typeof helper._handleAnyTextareaChanges !== "function" ||
    typeof helper._dataAlreadySent !== "string" ||
    typeof helper._isComposing !== "boolean" ||
    typeof helper._isSendingComposition !== "boolean"
  ) {
    return () => undefined;
  }

  let committedText: string | undefined;
  let compositionStartValue = textarea.value;
  let compositionGeneration = 0;
  let keydownSequence = 0;
  const pendingTextareaDiffs = new Set<PendingTextareaDiff>();
  const fallbackTimers = new Set<number>();
  const observeKeydown = (event: KeyboardEvent): void => {
    if (event.target === textarea) keydownSequence += 1;
  };
  const captureCommit = (event: globalThis.CompositionEvent): void => {
    committedText = event.data;
  };
  const reportStart = (): void => {
    compositionGeneration += 1;
    compositionStartValue = textarea.value;
    for (const pending of pendingTextareaDiffs) {
      if (pending.keydownSequence === keydownSequence) {
        pending.followedByComposition = true;
      }
    }
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
  const handleAnyTextareaChanges = helper._handleAnyTextareaChanges;
  helper._handleAnyTextareaChanges = () => {
    const oldValue = textarea.value;
    const pending: PendingTextareaDiff = {
      keydownSequence,
      followedByComposition: false,
      timer: 0,
    };
    pending.timer = window.setTimeout(() => {
      pendingTextareaDiffs.delete(pending);
      // The same key's compositionend already delivered its committed text.
      if (pending.followedByComposition || helper.isComposing) return;
      const newValue = textarea.value;
      const diff = newValue.replace(oldValue, "");
      helper._dataAlreadySent = diff;
      if (newValue.length > oldValue.length) {
        terminal.input(diff, true);
      } else if (newValue.length < oldValue.length) {
        terminal.input("\x7f", true);
      } else if (newValue !== oldValue) {
        terminal.input(newValue, true);
      }
    }, 0);
    pendingTextareaDiffs.add(pending);
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
    const startValue = compositionStartValue;
    const generation = compositionGeneration;
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
    } else if (wasComposing) {
      // Chromium は一部の IME で compositionend.data を空にする。DOM の
      // 確定後に、変換開始前の値と比較する。取消なら差分は空のまま。
      const timer = window.setTimeout(() => {
        fallbackTimers.delete(timer);
        const endValue = generation === compositionGeneration
          ? textarea.value
          : compositionStartValue;
        const fallback = insertedText(startValue, endValue);
        onDiagnostic?.({
          event: "composition-end-fallback",
          emittedLength: fallback.length,
          valueChanged: startValue !== endValue,
        });
        if (fallback) {
          terminal.input(fallback, true);
        } else if (
          generation === compositionGeneration &&
          textarea.isConnected &&
          textarea.ownerDocument.activeElement === textarea &&
          !helper.isComposing
        ) {
          // In the affected installed app, the next key opened candidates at
          // (0, 0) without compositionstart. Moving focus to search and back
          // restored IME input, so repeat that focus cycle after cancellation.
          terminal.blur();
          terminal.focus();
          onDiagnostic?.({ event: "composition-cancel-refocus" });
        }
      }, 0);
      fallbackTimers.add(timer);
    }
  };
  textarea.addEventListener("compositionend", captureCommit, true);
  textarea.addEventListener("compositionstart", reportStart);
  textarea.ownerDocument.addEventListener("keydown", observeKeydown, true);

  return () => {
    textarea.removeEventListener("compositionend", captureCommit, true);
    textarea.removeEventListener("compositionstart", reportStart);
    textarea.ownerDocument.removeEventListener("keydown", observeKeydown, true);
    helper._handleAnyTextareaChanges = handleAnyTextareaChanges;
    helper.compositionend = compositionend;
    committedText = undefined;
    for (const pending of pendingTextareaDiffs) window.clearTimeout(pending.timer);
    pendingTextareaDiffs.clear();
    for (const timer of fallbackTimers) window.clearTimeout(timer);
    fallbackTimers.clear();
  };
}
