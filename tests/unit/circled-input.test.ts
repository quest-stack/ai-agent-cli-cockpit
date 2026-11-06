import assert from "node:assert/strict";
import test from "node:test";

import { getCircledInputLayout, logicalInputColumn } from "../../src/renderer/circled-input";

import type { InputCell } from "../../src/renderer/circled-input";

function cells(text: string): InputCell[] {
  return Array.from(text, text => ({ text, width: 1 }));
}

test("an adjacent draft pair gets readable visual cells without inserting input spaces", () => {
  const input = cells("› ①②");
  const before = JSON.stringify(input);
  const plan = getCircledInputLayout(input, 20, 4)!;
  assert.deepEqual(plan.symbols, [2, 3]);
  assert.equal(plan.cursor, 6);
  assert.deepEqual(plan.boundaries.slice(0, 5), [0, 1, 2, 4, 6]);
  assert.equal(JSON.stringify(input), before);
});

test("mouse and selection coordinates map both halves back to the same logical character", () => {
  const plan = getCircledInputLayout(cells("› ①②"), 20, 4)!;
  assert.equal(logicalInputColumn(plan, 2), 2);
  assert.equal(logicalInputColumn(plan, 3), 2.5);
  assert.equal(logicalInputColumn(plan, 4), 3);
  assert.equal(logicalInputColumn(plan, 5), 3.5);
  assert.equal(logicalInputColumn(plan, 6), 4);
});

test("editing before and after a circle keeps wide text and cursor coordinates coherent", () => {
  const input: InputCell[] = [...cells("› ①② "), { text: "日", width: 2 }, { text: "", width: 0 }];
  assert.equal(getCircledInputLayout(input, 20, 3)!.cursor, 4);
  assert.equal(getCircledInputLayout(input, 20, 7)!.cursor, 9);
  assert.equal(getCircledInputLayout(input, 20, 7)!.end, 7);
});

test("ordinary output and rows without sufficient unused cells retain native rendering", () => {
  assert.equal(getCircledInputLayout(cells("Result ①②"), 20, 9), null);
  assert.equal(getCircledInputLayout(cells("› plain"), 20, 7), null);
  assert.equal(getCircledInputLayout(cells("› ①②A"), 5, 5), null);
});

test("wrapped composer rows accept their indentation only after the prompt block is identified", () => {
  const input = cells("  ①②");
  assert.equal(getCircledInputLayout(input, 20, 4), null);
  const plan = getCircledInputLayout(input, 20, 4, true)!;
  assert.deepEqual(plan.symbols, [2, 3]); assert.equal(plan.cursor, 6);
  assert.equal(plan.normalScale, 1);
});

test("full prose rows retain two-cell circles by fitting other text within the existing row", () => {
  const input = cells(`› ${"A".repeat(26)}①②`);
  const plan = getCircledInputLayout(input, 30, 30)!;
  assert.equal(plan.normalScale, 26 / 28);
  assert.ok(Math.abs(plan.boundaries[30] - 30) < 0.001);
  for (const column of plan.symbols) assert.equal(plan.boundaries[column + 1] - plan.boundaries[column], 2);
  for (let column = 0; column < 30; column++) {
    const middle = (plan.boundaries[column] + plan.boundaries[column + 1]) / 2;
    assert.ok(Math.abs(logicalInputColumn(plan, middle) - column - 0.5) < 0.001);
  }
  assert.equal(getCircledInputLayout(cells(`› ${"①".repeat(15)}`), 17, 17), null);
});
