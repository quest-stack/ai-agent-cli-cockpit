import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DiagnosticLogger } from "../../src/electron/diagnostic-log";
import {
  describeDiagnosticPayload,
  DIAGNOSTIC_CATEGORIES,
  ExtendedKeyModeSequenceDetector,
  formatDiagnosticMessage,
} from "../../src/shared/diagnostics";

test("diagnostic.log writes timestamped entries for categories 1 through 4", async () => {
  const userDataDirectory = await mkdtemp(
    join(tmpdir(), "cli-cockpit-diagnostic-"),
  );
  const errors: string[] = [];
  const standardOutput: string[] = [];
  let timestampOffset = 0;
  const logger = new DiagnosticLogger(userDataDirectory, {
    errorOutput: (message, error) => {
      errors.push(`${message}: ${String(error)}`);
    },
    now: () => {
      const timestamp = new Date(
        Date.UTC(2026, 7, 1, 0, 0, timestampOffset),
      );
      timestampOffset += 1;
      return timestamp;
    },
    output: (message) => {
      standardOutput.push(message);
    },
  });

  try {
    await logger.start();
    logger.log(
      "renderer",
      formatDiagnosticMessage(DIAGNOSTIC_CATEGORIES.terminalKeydown, {
        handlerFired: true,
      }),
    );
    logger.log(
      "renderer",
      formatDiagnosticMessage(
        DIAGNOSTIC_CATEGORIES.terminalKeyTranslation,
        {
          branch: "manual-newline-sequence",
        },
      ),
    );
    logger.log(
      "renderer",
      formatDiagnosticMessage(
        DIAGNOSTIC_CATEGORIES.terminalWriteSession,
        {
          invoked: true,
        },
      ),
    );
    logger.log(
      DIAGNOSTIC_CATEGORIES.ptyWrite,
      JSON.stringify({ receivedHex: "1b 0d" }),
    );
    await logger.flush();

    const contents = await readFile(logger.filePath, "utf8");
    const lines = contents.trimEnd().split(/\r?\n/u);

    assert.equal(errors.length, 0);
    assert.equal(lines.length, 5);
    assert.match(lines[0], /\[app\.start\] === APP START/u);
    assert.ok(lines[0].includes(JSON.stringify(logger.filePath)));
    assert.ok(standardOutput[0]?.includes(logger.filePath));
    assert.ok(contents.includes(DIAGNOSTIC_CATEGORIES.terminalKeydown));
    assert.ok(
      contents.includes(DIAGNOSTIC_CATEGORIES.terminalKeyTranslation),
    );
    assert.ok(
      contents.includes(DIAGNOSTIC_CATEGORIES.terminalWriteSession),
    );
    assert.ok(contents.includes(`[${DIAGNOSTIC_CATEGORIES.ptyWrite}]`));
    for (const line of lines) {
      assert.match(line, /^2026-08-01T00:00:0\d\.000Z \[[^\]]+\]/u);
    }
  } finally {
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});

test("diagnostic payloads preserve ESC CR as exact UTF-8 bytes", () => {
  assert.deepEqual(describeDiagnosticPayload("\u001b\r"), {
    escaped: "\\u001b\\r",
    hex: "1b 0d",
    utf8ByteLength: 2,
  });
});

test("extended-key mode detection returns only matching control sequences", () => {
  const detector = new ExtendedKeyModeSequenceDetector();

  assert.deepEqual(
    detector.push(
      `screen text\x1b[>4;2mprivate text\x1b[>1u\x1b[=3u`,
    ),
    [
      {
        mode: "2",
        protocol: "modifyOtherKeys",
        sequence: "\x1b[>4;2m",
      },
      {
        mode: "1",
        protocol: "kitty-keyboard-push",
        sequence: "\x1b[>1u",
      },
      {
        mode: "3",
        protocol: "kitty-keyboard-set",
        sequence: "\x1b[=3u",
      },
    ],
  );
});

test("extended-key mode detection handles sequences split across pty chunks", () => {
  const detector = new ExtendedKeyModeSequenceDetector();

  assert.deepEqual(detector.push("\x1b[>4;"), []);
  assert.deepEqual(detector.push("2m"), [
    {
      mode: "2",
      protocol: "modifyOtherKeys",
      sequence: "\x1b[>4;2m",
    },
  ]);
  assert.deepEqual(detector.push("\x1b[31m\x1b"), []);
  assert.deepEqual(detector.push("[>5u"), [
    {
      mode: "5",
      protocol: "kitty-keyboard-push",
      sequence: "\x1b[>5u",
    },
  ]);
});
