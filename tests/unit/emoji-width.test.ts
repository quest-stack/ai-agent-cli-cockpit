import assert from "node:assert/strict";
import test from "node:test";

import { getEmojiCellCount } from "../../src/renderer/emoji-width";

test("既知の絵文字を1グラフェムあたり2セルとして数える", () => {
  assert.equal(getEmojiCellCount("✅"), 2);
  assert.equal(getEmojiCellCount("❌"), 2);
  assert.equal(getEmojiCellCount("✅❌"), 4);
  assert.equal(getEmojiCellCount("👩‍💻"), 2);
  assert.equal(getEmojiCellCount("🇯🇵"), 2);
  assert.equal(getEmojiCellCount("1️⃣"), 2);
  assert.equal(getEmojiCellCount("❤️"), 2);
});

test("ASCII・罫線・全角・絵文字との混在 span は対象外にする", () => {
  assert.equal(getEmojiCellCount("W i 5 │ ─"), null);
  assert.equal(getEmojiCellCount("あ"), null);
  assert.equal(getEmojiCellCount("©"), null);
  assert.equal(getEmojiCellCount("✅ ok"), null);
  assert.equal(getEmojiCellCount(""), null);
});
