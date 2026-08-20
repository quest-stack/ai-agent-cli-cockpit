import assert from "node:assert/strict";
import test from "node:test";

import {
  appSettingsSchema,
  remoteLaunchRequestSchema,
  stripByteOrderMark,
} from "../../src/shared/schema";

test("a request written by PowerShell with a BOM still parses", () => {
  // PowerShell の Out-File -Encoding utf8 も Windows のメモ帳も BOM を付ける。
  // BOM が残ったままだと JSON.parse は必ず落ちるため、依頼を書く側が
  // Windows の普通の手段を使っただけで弾かれてしまう。実際に一度弾かれた。
  const withBom = `\ufeff{"cwd":"C:/work/project"}`;

  assert.throws(() => JSON.parse(withBom) as unknown);

  const parsed = remoteLaunchRequestSchema.parse(
    JSON.parse(stripByteOrderMark(withBom)),
  );
  assert.equal(parsed.cwd, "C:/work/project");
});

test("stripping a byte order mark leaves ordinary text untouched", () => {
  assert.equal(stripByteOrderMark('{"cwd":"C:/x"}'), '{"cwd":"C:/x"}');
  assert.equal(stripByteOrderMark(""), "");
});

test("a remote launch request accepts a working directory and prompt", () => {
  const parsed = remoteLaunchRequestSchema.parse({
    cwd: "C:/work/project",
    prompt: "進捗表の集計を直しておいて",
    title: "サンプル案件",
  });

  assert.equal(parsed.cwd, "C:/work/project");
  assert.equal(parsed.prompt, "進捗表の集計を直しておいて");
  assert.equal(parsed.title, "サンプル案件");
});

test("a remote launch request works with only a working directory", () => {
  const parsed = remoteLaunchRequestSchema.parse({ cwd: "C:/work/project" });

  assert.equal(parsed.prompt, undefined);
  assert.equal(parsed.title, undefined);
});

test("a remote launch request cannot choose which command runs", () => {
  // 依頼側でコマンドを選べてしまうと、受付フォルダに書けることが
  // 任意コマンド実行と同義になる。command は受け取らない。
  const parsed = remoteLaunchRequestSchema.parse({
    command: "powershell -c whoami",
    cwd: "C:/work/project",
  });

  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "command"),
    false,
  );
});

test("a remote launch prompt rejects control characters", () => {
  // 端末へそのまま流し込むため、改行は「送信」、ESC は端末制御として
  // 解釈される。指示文の途中に混ぜて別の操作をさせられないよう弾く。
  for (const injected of [
    "ok\rrm -rf /",
    "ok\nrm -rf /",
    "ok\u001b[13;2u",
    "ok\u0000",
    "ok\u007f",
  ]) {
    const result = remoteLaunchRequestSchema.safeParse({
      cwd: "C:/work/project",
      prompt: injected,
    });
    assert.equal(
      result.success,
      false,
      `control character should be rejected: ${JSON.stringify(injected)}`,
    );
  }
});

test("a remote launch title rejects control characters", () => {
  const result = remoteLaunchRequestSchema.safeParse({
    cwd: "C:/work/project",
    title: "tab\r\nname",
  });

  assert.equal(result.success, false);
});

test("a remote launch request rejects a missing or empty working directory", () => {
  assert.equal(remoteLaunchRequestSchema.safeParse({}).success, false);
  assert.equal(
    remoteLaunchRequestSchema.safeParse({ cwd: "" }).success,
    false,
  );
});

test("remote launch stays off for settings written before the feature existed", () => {
  // 既存の利用者が更新しただけで受付口が開いてはいけない。
  const parsed = appSettingsSchema.parse({
    alwaysConfirmClose: false,
    defaultCommand: "claude",
    notificationsEnabled: true,
    pinned: [],
    scanRoots: [],
    sidebarWidth: 240,
    tourCompleted: false,
  });

  assert.equal(parsed.remoteLaunchEnabled, false);
});
