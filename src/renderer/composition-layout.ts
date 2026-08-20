interface CompositionHorizontalLayoutInput {
  cursorLeftPx: number;
  naturalWidthPx: number;
  screenWidthPx: number;
}

interface CompositionHorizontalLayout {
  availableWidthPx: number;
  helperWidthPx: number;
  textIndentPx: number;
  translateXPx: number;
  viewWidthPx: number;
  wraps: boolean;
}

interface CompositionVerticalLayoutInput {
  /** 1行分の高さ（カーソル行が占める高さ）。 */
  cellHeightPx: number;
  cursorTopPx: number;
  screenHeightPx: number;
  wrappedHeightPx: number;
}

function finiteAtLeast(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

/**
 * Resolve a real width for xterm's absolutely positioned IME overlay.
 *
 * A wrapping composition spans the full renderer width. The element is moved
 * back to the screen's left edge while text-indent preserves the cursor column
 * on the first line; following lines therefore use the normal full terminal
 * width. A short composition keeps its natural width so its black background
 * does not fill the pane.
 */
export function resolveCompositionHorizontalLayout({
  cursorLeftPx,
  naturalWidthPx,
  screenWidthPx,
}: CompositionHorizontalLayoutInput): CompositionHorizontalLayout {
  const screenWidth = finiteAtLeast(screenWidthPx, 1);
  const cursorLeft = Math.min(
    screenWidth,
    finiteAtLeast(cursorLeftPx, 0),
  );
  const availableWidth = Math.max(1, screenWidth - cursorLeft);
  const naturalWidth = finiteAtLeast(naturalWidthPx, 1);
  const wraps = naturalWidth > availableWidth;

  if (!wraps) {
    const viewWidth = Math.min(naturalWidth, availableWidth);
    return {
      availableWidthPx: availableWidth,
      helperWidthPx: viewWidth,
      textIndentPx: 0,
      translateXPx: 0,
      viewWidthPx: viewWidth,
      wraps,
    };
  }

  return {
    availableWidthPx: availableWidth,
    helperWidthPx: availableWidth,
    textIndentPx: cursorLeft,
    translateXPx: -cursorLeft,
    viewWidthPx: screenWidth,
    wraps,
  };
}

/**
 * Keep a multiline overlay from growing downward past the caret's own line.
 *
 * The composing text has not reached the CLI yet — the IME only delivers it on
 * commit — so the app below cannot grow its input box to fit it. Anchoring to
 * the renderer's bottom edge is therefore not enough: a three-line overlay on
 * the last row still covers the input frame and whatever sits under it. Anchor
 * to the bottom of the caret's line instead, so extra lines stack upward and
 * the overlay never occupies space the app has not reserved.
 *
 * Clamped so the overlay never runs off the top of the renderer; a composition
 * taller than the viewport starts at row 0 and is cut off at the bottom rather
 * than being pushed out of sight.
 */
export function resolveCompositionTranslateY({
  cellHeightPx,
  cursorTopPx,
  screenHeightPx,
  wrappedHeightPx,
}: CompositionVerticalLayoutInput): number {
  const cursorTop = finiteAtLeast(cursorTopPx, 0);
  const screenHeight = finiteAtLeast(screenHeightPx, 1);
  const wrappedHeight = finiteAtLeast(wrappedHeightPx, 1);
  const cellHeight = finiteAtLeast(cellHeightPx, 1);

  // Lines beyond the caret's own row must go upward, not downward.
  const overflowBelowCaretLine = Math.max(0, wrappedHeight - cellHeight);
  // Never lift past the top of the renderer.
  const maxLift = cursorTop;
  const lift = Math.min(overflowBelowCaretLine, maxLift);

  // Still respect the renderer's bottom edge for the single-line case.
  const bottomOverflow = Math.max(
    0,
    cursorTop - lift + wrappedHeight - screenHeight,
  );

  const total = lift + bottomOverflow;
  return total === 0 ? 0 : -total;
}

export type {
  CompositionHorizontalLayout,
  CompositionHorizontalLayoutInput,
  CompositionVerticalLayoutInput,
};
