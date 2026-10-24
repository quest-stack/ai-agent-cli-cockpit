import assert from "node:assert/strict";
import { test } from "node:test";

import { ContextPreviewInput, requestedContextPaths } from "../../src/shared/preview-context-input";

test("explicit Japanese and English document requests identify only named context files", () => {
  assert.deepEqual(requestedContextPaths("AGENTS.mdを確認して"), ["AGENTS.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.mdを治して"), ["AGENTS.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.mdを見て"), ["AGENTS.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.mdの内容を変更して"), ["AGENTS.md"]);
  assert.deepEqual(requestedContextPaths("CLAUDE.md自体を直して、DESIGN.mdもレビューして"), ["CLAUDE.md", "DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.md、CLAUDE.mdを確認して"), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(requestedContextPaths('Please review "docs/project notes/AGENTS.md" and README.en.md'), ["docs/project notes/AGENTS.md", "README.en.md"]);
  assert.deepEqual(requestedContextPaths("Get-Content C:\\work\\DESIGN.md"), ["C:\\work\\DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("Read /work/CLAUDE.local.md and docs/AGENTS.override.md"), ["/work/CLAUDE.local.md", "docs/AGENTS.override.md"]);
  assert.deepEqual(requestedContextPaths("Review myAGENTS.md and design-proposal.md"), []);
  assert.deepEqual(requestedContextPaths("AGENTS.md"), []);
  assert.deepEqual(requestedContextPaths(`Review ${"/".repeat(4000)}xAGENTS.md`), []);
});

test("negative display or edit instructions do not request those documents", () => {
  assert.deepEqual(requestedContextPaths("AGENTS.mdは開かなくていい"), []);
  assert.deepEqual(requestedContextPaths("AGENTS.mdを読まないで"), []);
  assert.deepEqual(requestedContextPaths("Do not open AGENTS.md"), []);
  assert.deepEqual(requestedContextPaths("Do not change AGENTS.md"), []);
  assert.deepEqual(requestedContextPaths("AGENTS.mdは触らないで、DESIGN.mdを修正して"), ["DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("Don't edit CLAUDE.md but review README.md"), ["README.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.mdはそのままで、DESIGN.mdを確認して"), ["DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("Leave AGENTS.md alone but inspect DESIGN.md"), ["DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("前回はAGENTS.mdでした。今回はDESIGN.mdを修正して"), ["DESIGN.md"]);
  assert.deepEqual(requestedContextPaths("AGENTS.mdを確認して。ただしAGENTS.mdは開かないで"), []);
});

test("typed requests wait for submission, reset per turn and support Unicode backspace", () => {
  const input = new ContextPreviewInput();
  for (const character of "AGENTS.mdを確認して") assert.deepEqual(input.push(character), []);
  assert.deepEqual(input.push("\r"), ["AGENTS.md"]);
  assert.deepEqual(input.push("通常の作業です\r"), []);
  assert.deepEqual(input.push("Review CLAUDE.mdX\u007f\r"), ["CLAUDE.md"]);
  assert.deepEqual(input.push("Review DESIGN.md😀\b\r"), ["DESIGN.md"]);
  assert.deepEqual(new ContextPreviewInput().push("\r"), []);
});

test("bracketed paste and multiline input are not treated as submitted mid-paste", () => {
  const input = new ContextPreviewInput();
  for (const part of ["\u001b[20", "0~AGENTS.md\n", "を確認して\u001b[201~"]) assert.deepEqual(input.push(part), []);
  assert.deepEqual(input.push("\r"), ["AGENTS.md"]);
  assert.deepEqual(input.push("Review\u001b[13;2uDESIGN.md"), []);
  assert.deepEqual(input.push("\r"), ["DESIGN.md"]);
});

test("cancelled, over-limit or untracked cursor edits cannot cause an accidental preview", () => {
  const input = new ContextPreviewInput();
  assert.deepEqual(input.push("Review AGENTS.md\u0003\r"), []);
  assert.deepEqual(input.push("Review CLAUDE.md\u001b[D\r"), []);
  assert.deepEqual(input.push("Review DESIGN.md\t\r"), []);
  assert.deepEqual(input.push("Do not edit \u0017Review AGENTS.md\r"), []);
  assert.deepEqual(input.push("Review CLAUDE.md\u0015Review DESIGN.md\r"), []);
  assert.deepEqual(input.push("\u001b[200~Review AGENTS.md\u0003Review DESIGN.md\r"), ["DESIGN.md"]);
  assert.deepEqual(input.push(`Review AGENTS.md${"x".repeat(4096)}\r`), []);
  assert.deepEqual(input.push("Review DESIGN.md\r"), ["DESIGN.md"]);
  assert.deepEqual(input.push("Review\u001b[1;1R AGENTS.md\r"), ["AGENTS.md"]);
});
