import assert from "node:assert/strict";
import test from "node:test";

import { pageChanges } from "../../src/electron/preview-page-review";
import { previewRequestSchema } from "../../src/shared/preview";

test("page highlights distinguish additions, deletions and changes without marking unchanged elements", () => {
  const before = new Map([["body > h1", "old"], ["body > p", "same"], ["body > aside", "deleted"]]);
  const after = new Map([["body > h1", "new"], ["body > p", "same"], ["body > footer", "added"]]);
  assert.deepEqual(pageChanges(before, after), [["body > h1", "body > aside"], ["body > h1", "body > footer"]]);
  assert.deepEqual(pageChanges(before, before), [[], []]);
});

test("page comparison requests accept bounded views and reject invalid ownership IDs and sizes", () => {
  const box = { x: 10, y: 20, width: 640, height: 480 };
  const request = { action: "review-pages", tabId: "work", targetId: "page", before: box, after: box, highlight: true };
  assert.equal(previewRequestSchema.safeParse(request).success, true);
  assert.equal(previewRequestSchema.safeParse({ ...request, targetId: "../page" }).success, false);
  assert.equal(previewRequestSchema.safeParse({ ...request, before: { ...box, x: -1 } }).success, false);
  assert.equal(previewRequestSchema.safeParse({ ...request, after: { ...box, height: 20001 } }).success, false);
  assert.equal(previewRequestSchema.safeParse({ action: "capture", tabId: "work", targetId: "page", viewport: { width: 1440, height: 900 }, baseline: false }).success, true);
  assert.equal(previewRequestSchema.safeParse({ action: "capture", tabId: "work", targetId: "page", viewport: { width: 5000, height: 900 } }).success, false);
  const history = { action: "compare-versions", tabId: "work", targetId: "page", beforeId: "version-1", afterId: "version-2" };
  assert.equal(previewRequestSchema.safeParse(history).success, true);
  assert.equal(previewRequestSchema.safeParse({ ...history, beforeId: "../outside" }).success, false);
});

test("inserted and removed siblings do not mark unchanged paragraphs as changed", () => {
  const before = new Map([["body > p:nth-of-type(1)", "one"], ["body > p:nth-of-type(2)", "two"], ["body > p:nth-of-type(3)", "two"]]);
  const after = new Map([["body > p:nth-of-type(1)", "new"], ["body > p:nth-of-type(2)", "one"], ["body > p:nth-of-type(3)", "two"], ["body > p:nth-of-type(4)", "two"]]);
  assert.deepEqual(pageChanges(before, after), [[], ["body > p:nth-of-type(1)"]]);
  assert.deepEqual(pageChanges(after, before), [["body > p:nth-of-type(1)"], []]);
});

test("equal signatures on different tags remain changes and output stays bounded", () => {
  assert.deepEqual(pageChanges(new Map([["body > h1", "same"]]), new Map([["body > p", "same"]])), [["body > h1"], ["body > p"]]);
  const before = new Map(Array.from({ length: 5000 }, (_, i) => [`body > p:nth-of-type(${i + 1})`, `before-${i}`]));
  const after = new Map(Array.from({ length: 5000 }, (_, i) => [`body > p:nth-of-type(${i + 1})`, `after-${i}`]));
  assert.deepEqual(pageChanges(before, after).map((side) => side.length), [500, 500]);
});

test("reordering highlights the moved paragraph without flagging its displaced siblings", () => {
  const before = new Map([["body > p:nth-of-type(1)", "first"], ["body > p:nth-of-type(2)", "second"], ["body > p:nth-of-type(3)", "third"]]);
  const after = new Map([["body > p:nth-of-type(1)", "third"], ["body > p:nth-of-type(2)", "first"], ["body > p:nth-of-type(3)", "second"]]);
  assert.deepEqual(pageChanges(before, after), [["body > p:nth-of-type(3)"], ["body > p:nth-of-type(1)"]]);
});
