import assert from "node:assert/strict";
import test from "node:test";

import {
  getCircledNumberJoinRanges,
  getCompactCircledNumberCount,
  isSpacedCircledNumber,
} from "../../src/renderer/circled-number-rendering";

test("joins only a circled number and its existing ASCII space", () => {
  assert.deepEqual(getCircledNumberJoinRanges("① first ② second ⑳ last"), [[0, 2], [8, 10], [17, 19]]);
  assert.deepEqual(getCircledNumberJoinRanges("①②③x ①\t②\n③　㉑ text → next"), []);
  assert.deepEqual(getCircledNumberJoinRanges("⓪ ❶ ➀ "), [[0, 2], [2, 4], [4, 6]]);
});

test("ranges use UTF-16 offsets after Japanese, emoji and repeated headings", () => {
  assert.deepEqual(getCircledNumberJoinRanges("日本✅① 見出し 👩‍💻② 次"), [[3, 5], [14, 16]]);
});

test("compact fallback applies only to an entire span of circled numbers", () => {
  assert.equal(getCompactCircledNumberCount("①②⑳"), 3);
  assert.equal(getCompactCircledNumberCount("⓪❶➀"), 3);
  for (const text of ["", "① ", "① text", "㉑", "123", "✅", "日本語"]) {
    assert.equal(getCompactCircledNumberCount(text), null);
  }
});

test("only a single circled number and ASCII space receive the wide span style", () => {
  assert.equal(isSpacedCircledNumber("① "), true);
  for (const text of ["①", "①② ", "①　", "1 ", "① title", "㉑ "]) {
    assert.equal(isSpacedCircledNumber(text), false);
  }
});
