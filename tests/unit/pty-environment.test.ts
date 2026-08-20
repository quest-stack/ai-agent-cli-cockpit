import assert from "node:assert/strict";
import test from "node:test";

import {
  isColorSuppressionVar,
  isInheritedCliSessionVar,
} from "../../src/electron/pty-manager";

test("inherited Claude/Codex CLI session vars are filtered out of pty env", () => {
  // 親セッション由来（トランスクリプトOFF / resume不可の原因）→ 除去対象
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CODEX_COMPANION_SESSION_ID",
    "ANTHROPIC_API_KEY",
    "AI_AGENT",
  ]) {
    assert.equal(isInheritedCliSessionVar(key), true, `${key} should be filtered`);
  }
});

test("normal environment vars are preserved", () => {
  // ターミナルとして必要な一般変数は残す
  for (const key of ["PATH", "SystemRoot", "TERM", "LANG", "USERPROFILE", "TEMP"]) {
    assert.equal(isInheritedCliSessionVar(key), false, `${key} should be kept`);
  }
});

test("color suppression vars are filtered out of pty env", () => {
  // Cockpit を CLI から起動すると親の NO_COLOR=1 が pty へ継承され、
  // ペイン内の claude だけ色が消える（PowerShell は NO_COLOR に従わないため
  // 原因が分かりにくい）。色を止める系は伝播させない。
  for (const key of ["NO_COLOR", "no_color", "CLICOLOR", "clicolor"]) {
    assert.equal(isColorSuppressionVar(key), true, `${key} should be filtered`);
  }
});

test("color-related vars that should be kept are preserved", () => {
  // COLORTERM / FORCE_COLOR は色を「出す」側なので残す
  for (const key of ["COLORTERM", "FORCE_COLOR", "TERM", "PATH"]) {
    assert.equal(isColorSuppressionVar(key), false, `${key} should be kept`);
  }
});
