import assert from "node:assert/strict";
import test from "node:test";

import { circledNumberCanvasText } from "../../src/renderer/circled-number-canvas";

test("only the joined drawing string in the bundled font gets its wide variant", () => {
  assert.equal(circledNumberCanvasText("① ", '13px "Cockpit Circled Numbers"'), "①\uFE00");
  assert.equal(circledNumberCanvasText("⑳ ", 'bold 13px "Cockpit Mac Circled Numbers"'), "⑳\uFE00");
  assert.equal(circledNumberCanvasText("①　", '13px "Cockpit Circled Numbers"'), "①\uFE00 ");
  assert.equal(circledNumberCanvasText("①②　", '13px "Cockpit Circled Numbers"'), "①\uFE00②\uFE00");
  for (const value of ["①", "①②", "① A", "①② ", "A ", "❶ ", "㉑ "]) {
    assert.equal(circledNumberCanvasText(value, '13px "Cockpit Circled Numbers"'), value);
  }
  assert.equal(circledNumberCanvasText("① ", "13px Arial"), "① ");
});
