import assert from "node:assert/strict";
import test from "node:test";

import {
  type CaptureKeydownTarget,
  getTerminalManualNewlineSequence,
  isPlausibleCharacterWidth,
  isTerminalLineFeedKey,
  rebindCaptureKeydown,
  resolveTerminalEnterDisposition,
  resolveTerminalKeyAction,
  scheduleTerminalFitAfterReveal,
  shouldReportTerminalResize,
  shouldSendTerminalResize,
  TERMINAL_MANUAL_NEWLINE_SEQUENCE,
} from "../../src/renderer/terminal-behavior";

interface PendingFrame {
  callback: () => void;
  id: number;
}

function keyEvent(
  overrides: Partial<Parameters<typeof resolveTerminalKeyAction>[0]> = {},
): Parameters<typeof resolveTerminalKeyAction>[0] {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    isComposing: false,
    key: "",
    keyCode: 0,
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...overrides,
  };
}

test("only unmodified Shift+Enter is handled by the textarea listener", () => {
  assert.equal(
    isTerminalLineFeedKey(keyEvent({ key: "Enter", shiftKey: true })),
    true,
  );
  // IME 変換中（確定前）の Shift+Enter は「変換の確定」であって改行ではない。
  // ここで改行を送ると、確定した文字が入力欄に残ったまま改行/送信まで走る
  // （実機で発生。isComposing=true かつ shiftKey=true の keydown を観測）。
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({
        code: "Enter",
        isComposing: true,
        key: "Process",
        keyCode: 229,
        shiftKey: true,
      }),
    ),
    false,
  );
  // isComposing が立たない環境向けに keyCode 229 / key:"Process" でも弾く。
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ code: "Enter", keyCode: 229, shiftKey: true }),
    ),
    false,
  );
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ code: "NumpadEnter", key: "Process", shiftKey: true }),
    ),
    false,
  );
  // 変換を伴わない NumpadEnter は従来どおり改行として扱う。
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ code: "NumpadEnter", key: "Enter", shiftKey: true }),
    ),
    true,
  );
  assert.equal(isTerminalLineFeedKey(keyEvent({ key: "Enter" })), false);
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({
        code: "Enter",
        isComposing: true,
        key: "Process",
        keyCode: 229,
      }),
    ),
    false,
  );
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ ctrlKey: true, key: "Enter", shiftKey: true }),
    ),
    false,
  );
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ altKey: true, key: "Enter", shiftKey: true }),
    ),
    false,
  );
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ key: "Enter", metaKey: true, shiftKey: true }),
    ),
    false,
  );
  assert.equal(
    isTerminalLineFeedKey(
      keyEvent({ key: "Enter", shiftKey: true, type: "keyup" }),
    ),
    false,
  );
});

test("Shift+Enter resolves to Claude Code's CSI-u manual newline", () => {
  const shiftEnter = keyEvent({ key: "Enter", shiftKey: true });
  const composingShiftEnter = keyEvent({
    code: "Enter",
    isComposing: true,
    key: "Process",
    keyCode: 229,
    shiftKey: true,
  });
  assert.equal(
    getTerminalManualNewlineSequence(shiftEnter),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
  // IME 変換中の Shift+Enter では改行を送らない。
  //
  // Windows の IME は変換中に Shift+Enter を押すと keydown を 2 回発火させる:
  //   1回目 keyCode:229 / key:"Process"（IME が変換確定に消費）
  //   2回目 通常の Enter
  // 以前は 1 回目でも CSI-u を送っていたため、「変換確定 + 改行」が同時に起き、
  // さらに 2 回目の Enter で送信まで走っていた（実機で確認）。
  // 1 回目を抑止しても 2 回目の Enter は残るので、IME 外の Shift+Enter は不変。
  assert.equal(
    getTerminalManualNewlineSequence(composingShiftEnter),
    undefined,
  );
  assert.deepEqual(
    Array.from(TERMINAL_MANUAL_NEWLINE_SEQUENCE, (character) =>
      character.charCodeAt(0),
    ),
    [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75],
  );
  assert.equal(
    getTerminalManualNewlineSequence(
      keyEvent({
        code: "Enter",
        isComposing: true,
        key: "Process",
        keyCode: 229,
      }),
    ),
    undefined,
  );
});

test("custom key handling leaves Enter variants to the textarea or xterm", () => {
  assert.equal(
    resolveTerminalKeyAction(keyEvent({ key: "Enter" }), false),
    "passthrough",
  );
  assert.equal(
    resolveTerminalKeyAction(
      keyEvent({ key: "Enter", shiftKey: true }),
      false,
    ),
    "passthrough",
  );
});

test("only Ctrl+Shift+C with a selection copies", () => {
  assert.equal(
    resolveTerminalKeyAction(
      keyEvent({ ctrlKey: true, key: "c", shiftKey: true }),
      true,
    ),
    "copy-selection",
  );
  assert.equal(
    resolveTerminalKeyAction(keyEvent({ ctrlKey: true, key: "c" }), true),
    "passthrough",
  );
  assert.equal(
    resolveTerminalKeyAction(
      keyEvent({ ctrlKey: true, key: "c", shiftKey: true }),
      false,
    ),
    "passthrough",
  );
});

test("terminal reveal waits for two visible frames before fitting", () => {
  const frames: PendingFrame[] = [];
  const cancelledFrames = new Set<number>();
  let fitCount = 0;
  let height = 0;
  let nextFrameId = 0;
  let width = 0;

  const cancel = scheduleTerminalFitAfterReveal({
    cancelFrame: (frameId) => {
      cancelledFrames.add(frameId);
    },
    getHostSize: () => ({ height, width }),
    onReady: () => {
      fitCount += 1;
    },
    requestFrame: (callback) => {
      nextFrameId += 1;
      frames.push({ callback, id: nextFrameId });
      return nextFrameId;
    },
  });

  const runNextFrame = (): void => {
    const frame = frames.shift();
    assert.ok(frame);
    if (!cancelledFrames.has(frame.id)) {
      frame.callback();
    }
  };

  runNextFrame();
  assert.equal(fitCount, 0);

  width = 800;
  height = 500;
  runNextFrame();
  assert.equal(fitCount, 0);

  runNextFrame();
  assert.equal(fitCount, 1);
  assert.equal(frames.length, 0);
  cancel();
});

test("terminal resize reports only changed sizes unless forced", () => {
  const size = { cols: 120, rows: 40 };
  assert.equal(shouldReportTerminalResize(undefined, size, false), true);
  assert.equal(shouldReportTerminalResize(size, size, false), false);
  assert.equal(shouldReportTerminalResize(size, size, true), true);
  assert.equal(
    shouldReportTerminalResize(size, { cols: 121, rows: 40 }, false),
    true,
  );
});

test("terminal resize is never sent before fonts are ready", () => {
  const next = { cols: 120, rows: 40 };

  assert.equal(
    shouldSendTerminalResize({
      fontsReady: false,
      force: false,
      next,
      previous: undefined,
    }),
    false,
  );
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: false,
      force: false,
      next,
      previous: { cols: 119, rows: 40 },
    }),
    false,
  );
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: false,
      force: true,
      next,
      previous: next,
    }),
    false,
  );
});

test("terminal resize uses the existing report rules after fonts are ready", () => {
  const size = { cols: 120, rows: 40 };

  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: false,
      next: size,
      previous: size,
    }),
    false,
  );
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: true,
      next: size,
      previous: size,
    }),
    true,
  );
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: false,
      next: { cols: 121, rows: 40 },
      previous: size,
    }),
    true,
  );
});

/**
 * IME 変換中の Shift+Enter は keydown が 2 回来る。
 * 「1回目=IMEが確定に消費 / 2回目=通常のEnter」の並びを再現し、
 * どちらも端末へ書き込まれないこと（＝送信されないこと）を検証する。
 *
 * 実機で3回修正して3回とも失敗した箇所なので、イベント列として固定する。
 */
function drainEnterSequence(
  events: Parameters<typeof resolveTerminalEnterDisposition>[0][],
): { dispositions: string[]; writes: string[] } {
  let pending = false;
  const dispositions: string[] = [];
  const writes: string[] = [];
  for (const event of events) {
    const disposition = resolveTerminalEnterDisposition(event, pending);
    dispositions.push(disposition);
    if (disposition === "ime-first-keydown") {
      pending = true;
    } else {
      if (disposition === "manual-newline") {
        writes.push(TERMINAL_MANUAL_NEWLINE_SEQUENCE);
      }
      pending = false;
    }
  }
  return { dispositions, writes };
}

test("IME Shift+Enter emits two keydowns and neither reaches the terminal", () => {
  const { dispositions, writes } = drainEnterSequence([
    // 1回目: IME が変換確定に消費する keydown
    keyEvent({
      code: "Enter",
      isComposing: true,
      key: "Process",
      keyCode: 229,
      shiftKey: true,
    }),
    // 2回目: 確定に伴って飛んでくる通常の Enter
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13 }),
  ]);

  assert.deepEqual(dispositions, [
    "ime-first-keydown",
    "ime-second-keydown",
  ]);
  // どちらの keydown でも端末への書き込みは 0 回。
  assert.deepEqual(writes, []);
});

test("IME Shift+Enter whose second keydown still holds Shift is also suppressed", () => {
  // 2回目で Shift が押されたままでも、CSI-u を送ってはならない
  // （旧実装ではここで通常の Shift+Enter と誤判定して改行を送っていた）。
  const { dispositions, writes } = drainEnterSequence([
    keyEvent({
      code: "Enter",
      isComposing: true,
      key: "Process",
      keyCode: 229,
      shiftKey: true,
    }),
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13, shiftKey: true }),
  ]);

  assert.deepEqual(dispositions, [
    "ime-first-keydown",
    "ime-second-keydown",
  ]);
  assert.deepEqual(writes, []);
});

test("Shift+Enter without IME still sends exactly one newline", () => {
  const { dispositions, writes } = drainEnterSequence([
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13, shiftKey: true }),
  ]);

  assert.deepEqual(dispositions, ["manual-newline"]);
  assert.deepEqual(writes, [TERMINAL_MANUAL_NEWLINE_SEQUENCE]);
});

test("plain Enter is left to xterm so the CLI still receives a submit", () => {
  const { dispositions, writes } = drainEnterSequence([
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13 }),
  ]);

  assert.deepEqual(dispositions, ["delegate-to-xterm"]);
  assert.deepEqual(writes, []);
});

test("IME commit Enter without Shift is not hijacked", () => {
  // Shift なしの変換確定 Enter は IME の仕事。こちらは触らない。
  const { dispositions } = drainEnterSequence([
    keyEvent({
      code: "Enter",
      isComposing: true,
      key: "Process",
      keyCode: 229,
    }),
  ]);

  assert.deepEqual(dispositions, ["delegate-to-xterm"]);
});

test("a stale IME suppression flag does not swallow a later unrelated Enter", () => {
  // 2回目が来ないまま別のキーを挟んだ場合、フラグを持ち越さない。
  let pending = false;
  const first = resolveTerminalEnterDisposition(
    keyEvent({
      code: "Enter",
      isComposing: true,
      key: "Process",
      keyCode: 229,
      shiftKey: true,
    }),
    pending,
  );
  pending = first === "ime-first-keydown";

  // Enter 以外（通常の文字入力）が来たら解除される想定。
  const other = resolveTerminalEnterDisposition(
    keyEvent({ code: "KeyA", key: "a" }),
    pending,
  );
  assert.equal(other, "delegate-to-xterm");
});

/**
 * host は React が作り直すため、EventTarget を差し替えた時に
 * リスナが追随するかを検証する。
 */
function createHost(name: string, log: string[]): CaptureKeydownTarget {
  const listeners = new Set<(event: globalThis.KeyboardEvent) => void>();
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    // テスト用: この host に届いたことにして発火させる。
    dispatch: () => {
      for (const listener of listeners) {
        log.push(name);
        listener({} as globalThis.KeyboardEvent);
      }
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  } as CaptureKeydownTarget & { dispatch: () => void };
}

test("an implausible character width is rejected", () => {
  // xterm の測定用要素は測るたびに中身が変わるため、測定中に読むと
  // 複数文字ぶんの幅を掴む。実測で 243.75px を観測した（本来 7px 前後）。
  // この値を信じると桁数が極端に少なく出て、その幅で CLI が描き始める。
  assert.equal(isPlausibleCharacterWidth(243.75), false);
  assert.equal(isPlausibleCharacterWidth(0), false);
  assert.equal(isPlausibleCharacterWidth(-1), false);
  assert.equal(isPlausibleCharacterWidth(Number.NaN), false);
  assert.equal(isPlausibleCharacterWidth(Number.POSITIVE_INFINITY), false);
});

test("ordinary monospace cell widths are accepted", () => {
  // 実測値: WebGL ロード前 7.616px / ロード後 7.000px。
  assert.equal(isPlausibleCharacterWidth(7.616), true);
  assert.equal(isPlausibleCharacterWidth(7), true);
  // 拡大表示や大きめのフォントサイズでも通る範囲にしておく。
  assert.equal(isPlausibleCharacterWidth(20), true);
});

test("keydown listener follows the host when React swaps it", () => {
  // 実際に起きた不具合: リスナを最初の host にしか張らず、host が
  // 作り直された後は Shift+Enter を永久に拾えなくなっていた。
  const log: string[] = [];
  const oldHost = createHost("old", log) as CaptureKeydownTarget & {
    dispatch: () => void;
  };
  const newHost = createHost("new", log) as CaptureKeydownTarget & {
    dispatch: () => void;
  };
  const listener = (): void => undefined;

  let bound = rebindCaptureKeydown(undefined, oldHost, listener);
  assert.equal(bound, oldHost);

  bound = rebindCaptureKeydown(bound, newHost, listener);
  assert.equal(bound, newHost);

  oldHost.dispatch();
  newHost.dispatch();
  // 新しい host だけが発火する（旧 host からは外れている）。
  assert.deepEqual(log, ["new"]);
});

test("rebinding to the same host does not stack duplicate listeners", () => {
  const log: string[] = [];
  const host = createHost("host", log) as CaptureKeydownTarget & {
    dispatch: () => void;
  };
  const listener = (): void => undefined;

  let bound = rebindCaptureKeydown(undefined, host, listener);
  bound = rebindCaptureKeydown(bound, host, listener);
  bound = rebindCaptureKeydown(bound, host, listener);
  assert.equal(bound, host);

  host.dispatch();
  // 何度 attach されても 1 回だけ。二重送信を防ぐ。
  assert.deepEqual(log, ["host"]);
});
