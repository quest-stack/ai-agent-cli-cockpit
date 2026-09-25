import type { Terminal } from "@xterm/xterm";

interface CompositionCore {
  _syncTextArea?: () => void;
  _compositionHelper?: {
    updateCompositionElements: (dontRecurse?: boolean) => void;
  };
}

/**
 * xterm 6 は本文だけを DEC 2026 で保留し、IME は解析途中のカーソルを参照する。
 * 分割された更新の途中で変換すると本文上へ飛ぶため、入力位置にも同じ保留を適用。
 * xterm 内部 API への依存はここに閉じ込め、利用できない場合は既定動作を保つ。
 */
export function synchronizeCompositionPosition(terminal: Terminal): () => void {
  const core = (terminal as unknown as { _core?: CompositionCore })._core;
  const helper = core?._compositionHelper;
  const syncTextArea = core?._syncTextArea;
  if (
    !core ||
    !helper ||
    typeof syncTextArea !== "function" ||
    typeof helper.updateCompositionElements !== "function"
  ) {
    return () => undefined;
  }
  const updateCompositionElements = helper.updateCompositionElements;
  const compositionView = () =>
    terminal.element?.querySelector<HTMLElement>(".composition-view");
  let position: { left: string; top: string; lineHeight: string } | undefined;
  let pendingTextAreaSync = false;
  const ensureInputTarget = (): void => {
    const textarea = terminal.textarea;
    if (!textarea) return;
    // 初回のカーソル移動まで xterm の既定 CSS は画面外・0x0。
    // 最初の出力が同期描画だと、その無効な入力先まで保留されていた。
    for (const property of ["left", "top"] as const) {
      if (!Number.isFinite(Number.parseFloat(textarea.style[property]))) {
        textarea.style[property] = "0px";
      }
    }
    for (const property of ["width", "height", "lineHeight"] as const) {
      const size = Number.parseFloat(textarea.style[property]);
      if (!Number.isFinite(size) || size < 1) textarea.style[property] = "1px";
    }
  };
  const rememberPosition = (element: HTMLElement | undefined): void => {
    if (element) {
      const { left, top, lineHeight } = element.style;
      position = { left, top, lineHeight };
    }
  };

  core._syncTextArea = () => {
    if (terminal.modes.synchronizedOutputMode) {
      pendingTextAreaSync = true;
      return;
    }
    pendingTextAreaSync = false;
    syncTextArea.call(core);
    ensureInputTarget();
    if (!compositionView()?.classList.contains("active")) {
      rememberPosition(terminal.textarea);
    }
  };

  // ネイティブ IME は compositionstart より前に入力先の矩形を参照する。
  // 変換開始時だけ直すのでは遅いため、接続・フォーカス・リサイズでも同期する。
  core._syncTextArea();
  ensureInputTarget();
  rememberPosition(terminal.textarea);
  const syncInputTarget = (): void => { core._syncTextArea?.(); };
  terminal.textarea?.addEventListener("focus", syncInputTarget);
  const resized = terminal.onResize(syncInputTarget);
  helper.updateCompositionElements = (dontRecurse) => {
    if (!terminal.modes.synchronizedOutputMode) {
      updateCompositionElements.call(helper, dontRecurse);
      const view = compositionView();
      if (view?.classList.contains("active")) {
        // textarea の lineHeight は折り返し後の全高なので、1行高は view から取る。
        rememberPosition(view);
      }
      return;
    }

    // 同期描画の途中で初めて変換を始めた場合も、最後の確定位置を使う。
    // カーソルの一時位置を代入してから戻すと、OS の候補窓が先に追随する。
    const view = compositionView();
    if (position && view?.classList.contains("active")) {
      view.style.left = position.left;
      view.style.top = position.top;
      view.style.lineHeight = position.lineHeight;
      view.style.fontFamily = terminal.options.fontFamily ?? "";
      view.style.fontSize = `${terminal.options.fontSize}px`;
    }
  };

  // 同期解除だけのチャンクでは cursorMove が発生しない場合がある。
  const rendered = terminal.onRender(() => {
    if (pendingTextAreaSync) {
      core._syncTextArea?.();
    }
  });
  return () => {
    rendered.dispose();
    resized.dispose();
    terminal.textarea?.removeEventListener("focus", syncInputTarget);
    core._syncTextArea = syncTextArea;
    helper.updateCompositionElements = updateCompositionElements;
  };
}
