import assert from "node:assert/strict";
import test from "node:test";

import { getStyledCircledNumberRanges, joinStyledCircledNumbers } from "../../src/renderer/styled-circled-number-joining";

import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";

interface Cell {
  text: string;
  width?: number;
  background?: number;
  backgroundMode?: number;
  foreground?: number;
  bold?: boolean;
  decoration?: "underline" | "overline" | "strike" | "invisible" | "inverse";
}

function cell(): IBufferCell {
  const data = { text: "", width: 1, background: 0, backgroundMode: 0, foreground: 0, bold: false, decoration: "" };
  return Object.assign(data, {
    getChars: () => data.text,
    getWidth: () => data.width,
    getBgColor: () => data.background,
    getBgColorMode: () => data.backgroundMode,
    getFgColor: () => data.foreground,
    getFgColorMode: () => 0,
    isBold: () => Number(data.bold),
    isDim: () => 0,
    isItalic: () => 0,
    isBlink: () => 0,
    isUnderline: () => Number(data.decoration === "underline"),
    isOverline: () => Number(data.decoration === "overline"),
    isStrikethrough: () => Number(data.decoration === "strike"),
    isInvisible: () => Number(data.decoration === "invisible"),
    isInverse: () => Number(data.decoration === "inverse"),
  }) as unknown as IBufferCell;
}

function line(cells: Cell[]): IBufferLine {
  return {
    length: cells.length,
    translateToString: () => cells.map((entry) => entry.text).join(""),
    getCell: (index: number, target: IBufferCell) => {
      if (!cells[index]) return undefined;
      Object.assign(target, { text: cells[index].text, width: cells[index].width ?? 1,
        background: cells[index].background ?? 0, backgroundMode: cells[index].backgroundMode ?? 0,
        foreground: cells[index].foreground ?? 0, bold: cells[index].bold ?? false,
        decoration: cells[index].decoration ?? "" });
      return target;
    },
  } as unknown as IBufferLine;
}

function ranges(cells: Cell[], columns = cells.length): [number, number][] {
  return getStyledCircledNumberRanges(line(cells), columns, cell(), cell());
}

test("styled joining uses cell columns after Japanese and emoji", () => {
  assert.deepEqual(ranges([{ text: "日", width: 2 }, { text: "", width: 0 },
    { text: "✅", width: 2 }, { text: "", width: 0 }, { text: "①" }, { text: " " }, { text: "A" }]), [[4, 6]]);
});

test("fullwidth blanks retain all three original cells", () => {
  assert.deepEqual(ranges([{ text: "①" }, { text: "　", width: 2 }, { text: "", width: 0 }, { text: "A" }]), [[0, 3]]);
  assert.deepEqual(ranges([{ text: "①" }, { text: "　", width: 2 }, { text: "", width: 0 }], 2), []);
});

test("the reported adjacent pair uses its existing fullwidth blank for two large circles", () => {
  assert.deepEqual(ranges([{ text: "①" }, { text: "②" }, { text: "　", width: 2 }, { text: "", width: 0 }]), [[0, 4]]);
  assert.deepEqual(ranges([{ text: "①" }, { text: "②" }, { text: " " }, { text: " " }, { text: "A" }]), [[0, 4]]);
  for (const style of [{ foreground: 1 }, { bold: true }, { background: 1 }]) {
    assert.deepEqual(ranges([{ text: "①" }, { text: "②", ...style }, { text: "　", width: 2 }, { text: "", width: 0 }]), []);
  }
  assert.deepEqual(ranges([{ text: "①" }, { text: "②" }, { text: " " }, { text: "A" }]), []);
});

test("different backgrounds and visible decorations are not borrowed", () => {
  for (const decoration of ["underline", "overline", "strike", "invisible", "inverse"] as const) {
    assert.deepEqual(ranges([{ text: "①", decoration }, { text: " " }]), []);
    assert.deepEqual(ranges([{ text: "①" }, { text: " ", decoration }]), []);
  }
  assert.deepEqual(ranges([{ text: "①" }, { text: " ", background: 1 }]), []);
  assert.deepEqual(ranges([{ text: "①" }, { text: " ", backgroundMode: 1 }]), []);
});

test("occupied, implicit, dingbat and wide-number cells are left intact", () => {
  for (const text of ["A", "②", "", "\t"]) assert.deepEqual(ranges([{ text: "①" }, { text }]), []);
  for (const text of ["❶", "㉑", "A"]) assert.deepEqual(ranges([{ text }, { text: " " }]), []);
});

test("joiner adapter combines existing ranges, preserves the buffer and restores on dispose", () => {
  const bufferLine = line([{ text: "①" }, { text: " " }, { text: "B" }, { text: "C" }]);
  const original = () => [[2, 4]] as [number, number][];
  const service = { getJoinedCharacters: original };
  const terminal = { cols: 4, buffer: { active: { getNullCell: cell, getLine: () => bufferLine } },
    _core: { _characterJoinerService: service } } as unknown as Terminal;
  const dispose = joinStyledCircledNumbers(terminal);
  assert.deepEqual(service.getJoinedCharacters(), [[0, 2], [2, 4]]);
  assert.equal(bufferLine.translateToString(), "① BC");
  dispose();
  assert.equal(service.getJoinedCharacters, original);
});

test("missing xterm internals fail closed", () => {
  const dispose = joinStyledCircledNumbers({} as Terminal);
  assert.doesNotThrow(dispose);
});

test("a native SGR chunk cannot enlarge only the differently colored suffix of a run", () => {
  const bufferLine = line([{ text: "①" }, { text: "②", foreground: 1 }, { text: " ", foreground: 1 }]);
  const service = { getJoinedCharacters: () => [[1, 3]] as [number, number][] };
  const terminal = { cols: 3, buffer: { active: { getNullCell: cell, getLine: () => bufferLine } },
    _core: { _characterJoinerService: service } } as unknown as Terminal;
  const dispose = joinStyledCircledNumbers(terminal);
  try { assert.deepEqual(service.getJoinedCharacters(), []); } finally { dispose(); }
});
