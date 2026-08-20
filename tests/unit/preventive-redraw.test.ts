import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunPreventiveRedraw } from "../../src/shared/preventive-redraw";

const MIN_GAP_MS = 60_000;

test("表示中で前回から十分に経過し、ペインがあれば実行する", () => {
  assert.equal(
    shouldRunPreventiveRedraw({
      isHidden: false,
      lastRedrawAgoMs: MIN_GAP_MS + 1,
      minGapMs: MIN_GAP_MS,
      paneCount: 1,
    }),
    true,
  );
});

test("ウィンドウが非表示なら実行しない", () => {
  assert.equal(
    shouldRunPreventiveRedraw({
      isHidden: true,
      lastRedrawAgoMs: MIN_GAP_MS + 1,
      minGapMs: MIN_GAP_MS,
      paneCount: 1,
    }),
    false,
  );
});

test("前回の再描画から最小間隔を経過していなければ実行しない", () => {
  assert.equal(
    shouldRunPreventiveRedraw({
      isHidden: false,
      lastRedrawAgoMs: MIN_GAP_MS - 1,
      minGapMs: MIN_GAP_MS,
      paneCount: 1,
    }),
    false,
  );
});

test("ペインがなければ実行しない", () => {
  assert.equal(
    shouldRunPreventiveRedraw({
      isHidden: false,
      lastRedrawAgoMs: MIN_GAP_MS + 1,
      minGapMs: MIN_GAP_MS,
      paneCount: 0,
    }),
    false,
  );
});

test("前回の再描画から最小間隔ちょうどで実行する", () => {
  assert.equal(
    shouldRunPreventiveRedraw({
      isHidden: false,
      lastRedrawAgoMs: MIN_GAP_MS,
      minGapMs: MIN_GAP_MS,
      paneCount: 1,
    }),
    true,
  );
});
