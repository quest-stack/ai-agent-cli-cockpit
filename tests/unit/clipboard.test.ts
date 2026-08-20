import assert from "node:assert/strict";
import test from "node:test";

import {
  formatClipboardImagePath,
  formatDroppedFilePaths,
} from "../../src/shared/clipboard";

test("clipboard image paths are normalized and quoted only when needed", () => {
  assert.equal(
    formatClipboardImagePath(
      "C:\\Users\\tester\\AppData\\Local\\Temp\\cockpit-paste-1.png",
    ),
    "C:/Users/tester/AppData/Local/Temp/cockpit-paste-1.png",
  );
  assert.equal(
    formatClipboardImagePath(
      "C:\\Users\\Test User\\Temp\\cockpit-paste-2.png",
    ),
    "\"C:/Users/Test User/Temp/cockpit-paste-2.png\"",
  );
});

test("dropped file paths are normalized, quoted and space-separated", () => {
  const result = formatDroppedFilePaths([
    "C:\\Users\\tester\\notes.txt",
    "C:\\Users\\Test User\\My Files\\brief.pdf",
    "D:\\images\\logo.png",
  ]);

  assert.equal(
    result,
    'C:/Users/tester/notes.txt "C:/Users/Test User/My Files/brief.pdf" D:/images/logo.png',
  );
  assert.doesNotMatch(result, /[\r\n]/u);
});

test("empty dropped file paths are omitted", () => {
  assert.equal(
    formatDroppedFilePaths(["", "C:\\work\\valid.txt", ""]),
    "C:/work/valid.txt",
  );
});
