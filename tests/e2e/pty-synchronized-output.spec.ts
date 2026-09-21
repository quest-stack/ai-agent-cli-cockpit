import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { PtyManager } from "../../src/electron/pty-manager";

test("PTY が同期描画の終了を最後のカーソル移動より先に送らない", async () => {
  const sessionId = "synchronized-output-test";
  let output = "";
  const manager = new PtyManager({
    onData: ({ data }) => {
      output += data;
      // 同梱 ConPTY の端末属性問い合わせに通常の xterm と同じ応答を返す。
      if (output.includes("\x1b[c")) {
        manager.write(sessionId, "\x1b[?1;2c");
        output = output.replace("\x1b[c", "");
      }
    },
    onDiagnostic: () => undefined,
    onStatus: () => undefined,
  });
  const script = [
    "$esc = [char]27",
    "[Console]::Write($esc + '[?2026h' + $esc + '[4;12HFrame body' + $esc + '[20;3H' + $esc + '[?2026l')",
    "[Console]::Write('FRAME_COMPLETE')",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    manager.spawn({
      id: sessionId,
      cols: 120,
      rows: 35,
      cwd: resolve(process.cwd()),
      command: `powershell -NoProfile -EncodedCommand ${encoded}`,
      projectName: "fixture",
      title: "Synchronized output",
    });
    manager.resize(sessionId, 120, 35, true);
    await expect.poll(() => output, { timeout: 15_000 }).toContain("FRAME_COMPLETE");
    const start = output.indexOf("\x1b[?2026h");
    const frame = output.slice(start);
    expect(start).toBeGreaterThanOrEqual(0);
    const finalCursor = frame.indexOf("\x1b[20;3H");
    const end = frame.indexOf("\x1b[?2026l");
    expect(finalCursor).toBeGreaterThanOrEqual(0);
    expect(end, "完了の合図まで全描画を保留できる順序が必要").toBeGreaterThan(finalCursor);
  } finally {
    manager.kill(sessionId);
  }
});
