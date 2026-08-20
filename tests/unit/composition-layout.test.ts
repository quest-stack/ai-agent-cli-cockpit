import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCompositionHorizontalLayout,
  resolveCompositionTranslateY,
} from "../../src/renderer/composition-layout";

test("short IME text keeps an explicit natural width without a pane-wide background", () => {
  assert.deepEqual(
    resolveCompositionHorizontalLayout({
      cursorLeftPx: 320,
      naturalWidthPx: 104,
      screenWidthPx: 1_200,
    }),
    {
      availableWidthPx: 880,
      helperWidthPx: 104,
      textIndentPx: 0,
      translateXPx: 0,
      viewWidthPx: 104,
      wraps: false,
    },
  );
});

test("long IME text gets a real renderer width and wraps from the cursor column", () => {
  assert.deepEqual(
    resolveCompositionHorizontalLayout({
      cursorLeftPx: 320,
      naturalWidthPx: 2_400,
      screenWidthPx: 1_200,
    }),
    {
      availableWidthPx: 880,
      helperWidthPx: 880,
      textIndentPx: 320,
      translateXPx: -320,
      viewWidthPx: 1_200,
      wraps: true,
    },
  );
});

test("IME wrap width follows both wide and narrow terminal panes", () => {
  const wide = resolveCompositionHorizontalLayout({
    cursorLeftPx: 240,
    naturalWidthPx: 2_400,
    screenWidthPx: 1_200,
  });
  const narrow = resolveCompositionHorizontalLayout({
    cursorLeftPx: 128,
    naturalWidthPx: 2_400,
    screenWidthPx: 640,
  });

  assert.equal(wide.viewWidthPx, 1_200);
  assert.equal(wide.availableWidthPx, 960);
  assert.equal(narrow.viewWidthPx, 640);
  assert.equal(narrow.availableWidthPx, 512);
  assert.ok(narrow.availableWidthPx < wide.availableWidthPx);
});

test("a composition starting at the last column uses full width after line one", () => {
  assert.deepEqual(
    resolveCompositionHorizontalLayout({
      cursorLeftPx: 632,
      naturalWidthPx: 2_400,
      screenWidthPx: 640,
    }),
    {
      availableWidthPx: 8,
      helperWidthPx: 8,
      textIndentPx: 632,
      translateXPx: -632,
      viewWidthPx: 640,
      wraps: true,
    },
  );
});

test("multiline IME text stacks upward instead of growing past the caret line", () => {
  // 変換中の文字はまだ CLI に届いていないため、下のアプリは入力欄を広げられない。
  // よって画面内に収まっていても、カーソル行より下へは伸ばさず上へ積む。
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 342,
      screenHeightPx: 360,
      wrappedHeightPx: 72,
    }),
    -54,
  );
  // 画面中央で変換しても同じ。4行(72px)のうちカーソル行(18px)を除く 54px を上へ。
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 90,
      screenHeightPx: 360,
      wrappedHeightPx: 72,
    }),
    -54,
  );
  // 1行に収まるなら動かさない。
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 90,
      screenHeightPx: 360,
      wrappedHeightPx: 18,
    }),
    0,
  );
  // 画面上端付近では、上へ逃がせる分までしか持ち上げない（見切れさせない）。
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 18,
      screenHeightPx: 360,
      wrappedHeightPx: 90,
    }),
    -18,
  );
});

test("measured 150-character preedit wraps at different points in two pane widths", () => {
  const characterWidthPx = 2_400 / 150;
  const estimateLines = (
    screenWidthPx: number,
    cursorLeftPx: number,
  ): number => {
    const firstLineCharacters = Math.floor(
      (screenWidthPx - cursorLeftPx) / characterWidthPx,
    );
    const laterLineCharacters = Math.floor(
      screenWidthPx / characterWidthPx,
    );
    return (
      1 +
      Math.ceil((150 - firstLineCharacters) / laterLineCharacters)
    );
  };

  const wideLines = estimateLines(1_211, 537);
  const narrowLines = estimateLines(640, 240);
  assert.equal(wideLines, 3);
  assert.equal(narrowLines, 5);
  assert.ok(150 / wideLines > 1);
  assert.ok(150 / narrowLines > 1);
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 342,
      screenHeightPx: 360,
      wrappedHeightPx: wideLines * 18,
    }),
    -36,
  );
  assert.equal(
    resolveCompositionTranslateY({
      cellHeightPx: 18,
      cursorTopPx: 342,
      screenHeightPx: 360,
      wrappedHeightPx: narrowLines * 18,
    }),
    -72,
  );
});
