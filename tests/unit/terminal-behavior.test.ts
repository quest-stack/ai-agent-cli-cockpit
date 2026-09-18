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
  getNewlineSequenceForCommand,
  shouldReportTerminalResize,
  shouldSendTerminalResize,
  TERMINAL_CODEX_NEWLINE_SEQUENCE,
  TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  TERMINAL_SUBMIT_SEQUENCE,
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

test("寸法が同じなら force でも resize を送らない（ちらつき防止）", () => {
  const size = { cols: 159, rows: 37 };

  // 全画面 TUI は寸法が変わらない resize でも画面全体を描き直す。
  // タブを表示するたび force で送ると入力中のちらつきになるため送らない。
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: true,
      next: size,
      previous: { ...size },
    }),
    false,
  );

  // まだ一度も通知していないなら force は効く（非表示解除後の初回通知）。
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: true,
      next: size,
      previous: undefined,
    }),
    true,
  );

  // 寸法が実際に変わったときは従来どおり送る。
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: false,
      next: size,
      previous: { cols: 92, rows: 28 },
    }),
    true,
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
  // 以前はここが true だった（force なら同一寸法でも送る）。
  // 全画面 TUI が寸法の変わらない resize でも全画面を描き直し、タブ表示のたびに
  // ちらつく原因になっていたため、通知済みの寸法は force でも送らないよう変えた。
  // 起動時のブートストラップ解除は sizeSettled:true を別経路
  // （scheduleSizeStableNotification → cockpitApi.resizeSession 直接呼び出し）
  // で送っており、このガードを通らないので影響しない。
  assert.equal(
    shouldSendTerminalResize({
      fontsReady: true,
      force: true,
      next: size,
      previous: size,
    }),
    false,
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
  enterRole: "newline" | "submit" = "submit",
): { dispositions: string[]; writes: string[] } {
  let pending = false;
  const dispositions: string[] = [];
  const writes: string[] = [];
  for (const event of events) {
    const disposition = resolveTerminalEnterDisposition(
      event,
      pending,
      enterRole,
    );
    dispositions.push(disposition);
    if (disposition === "ime-first-keydown") {
      pending = true;
    } else {
      if (disposition === "manual-newline") {
        // 実際に送るバイトは割り当てで変わるため、判定側と同じ関数から取る。
        const sequence = getTerminalManualNewlineSequence(event, enterRole);
        if (sequence !== undefined) {
          writes.push(sequence);
        }
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

test("Codex への改行は ESC+CR、それ以外は CSI-u を使う", () => {
  // Codex は CSI-u では改行にならない（実測。terminal-behavior.ts のコメント参照）。
  assert.equal(
    getNewlineSequenceForCommand("codex"),
    TERMINAL_CODEX_NEWLINE_SEQUENCE,
  );
  assert.equal(TERMINAL_CODEX_NEWLINE_SEQUENCE, "\r");

  // Claude Code は CSI-u で改行できているので変えない。
  assert.equal(
    getNewlineSequenceForCommand("claude"),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
  assert.equal(
    getNewlineSequenceForCommand("powershell"),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
  // command 不明（復元直後など）は従来どおり。
  assert.equal(
    getNewlineSequenceForCommand(undefined),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
});

test("Codex ペインの Shift+Enter は ESC+CR を送る", () => {
  const sequence = getTerminalManualNewlineSequence(
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13, shiftKey: true }),
    "submit",
    "codex",
  );

  assert.equal(sequence, TERMINAL_CODEX_NEWLINE_SEQUENCE);
});

test("Enter を改行へ入れ替えた Codex ペインでも ESC+CR を送る", () => {
  const newline = getTerminalManualNewlineSequence(
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13 }),
    "newline",
    "codex",
  );
  assert.equal(newline, TERMINAL_CODEX_NEWLINE_SEQUENCE);

  // 入れ替え時、Shift 付きは送信のまま（CLI を問わない）。
  const submit = getTerminalManualNewlineSequence(
    keyEvent({ code: "Enter", key: "Enter", keyCode: 13, shiftKey: true }),
    "newline",
    "codex",
  );
  assert.equal(submit, TERMINAL_SUBMIT_SEQUENCE);
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

test("入れ替えを有効にすると、Enter が改行・Shift+Enter が送信になる", () => {
  // 素の Enter は CLI へ改行として送る。xterm に委ねると CR になり送信されて
  // しまうため、こちらで横取りする必要がある。
  assert.equal(
    getTerminalManualNewlineSequence(keyEvent({ key: "Enter" }), "newline"),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
  // Shift+Enter は送信。xterm と同じ CR を明示的に送る。
  assert.equal(
    getTerminalManualNewlineSequence(
      keyEvent({ key: "Enter", shiftKey: true }),
      "newline",
    ),
    TERMINAL_SUBMIT_SEQUENCE,
  );
  // テンキーの Enter も同じ扱いにする。
  assert.equal(
    getTerminalManualNewlineSequence(
      keyEvent({ code: "NumpadEnter", key: "Enter" }),
      "newline",
    ),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
});

test("既定では素の Enter を横取りしない", () => {
  // 既定の割り当てを変えていないことを固定する。ここが崩れると、設定を
  // 触っていない利用者の送信が壊れる。
  assert.equal(
    getTerminalManualNewlineSequence(keyEvent({ key: "Enter" })),
    undefined,
  );
  assert.equal(
    getTerminalManualNewlineSequence(keyEvent({ key: "Enter" }), "submit"),
    undefined,
  );
  assert.equal(
    getTerminalManualNewlineSequence(
      keyEvent({ key: "Enter", shiftKey: true }),
      "submit",
    ),
    TERMINAL_MANUAL_NEWLINE_SEQUENCE,
  );
});

test("入れ替え時も、修飾キー付きの Enter は横取りしない", () => {
  // Ctrl+Enter は CLI 側の割り当てに任せる。ここで横取りすると、CLI が
  // 用意している別の動作を潰してしまう。
  for (const modifiers of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    assert.equal(
      getTerminalManualNewlineSequence(
        keyEvent({ key: "Enter", ...modifiers }),
        "newline",
      ),
      undefined,
    );
  }
});

test("入れ替え時、変換確定の Enter は端末へ届かない", () => {
  // 日本語を変換中に Enter を押すと、IME は確定させるだけで改行の意図はない。
  // 既定では xterm に委ねてよい（確定 → CR → 送信、が期待どおり）が、
  // 入れ替え時に委ねると「Enter では送信しない」設定と食い違う。
  const { dispositions, writes } = drainEnterSequence(
    [
      keyEvent({
        code: "Enter",
        isComposing: true,
        key: "Process",
        keyCode: 229,
      }),
      keyEvent({ code: "Enter", key: "Enter" }),
    ],
    "newline",
  );

  assert.deepEqual(dispositions, ["ime-first-keydown", "ime-second-keydown"]);
  assert.deepEqual(writes, []);
});

test("入れ替え時、変換を伴わない Enter は改行を 1 回だけ送る", () => {
  const { dispositions, writes } = drainEnterSequence(
    [keyEvent({ code: "Enter", key: "Enter" })],
    "newline",
  );

  assert.deepEqual(dispositions, ["manual-newline"]);
  assert.deepEqual(writes, [TERMINAL_MANUAL_NEWLINE_SEQUENCE]);
});

test("入れ替え時、変換確定のあとの Shift+Enter は送信を 1 回だけ送る", () => {
  // 変換を確定してから、あらためて送信する流れ。確定ぶんの Enter を送らず、
  // 送信だけが 1 回届くこと。
  const { writes } = drainEnterSequence(
    [
      keyEvent({
        code: "Enter",
        isComposing: true,
        key: "Process",
        keyCode: 229,
      }),
      keyEvent({ code: "Enter", key: "Enter" }),
      keyEvent({ code: "Enter", key: "Enter", shiftKey: true }),
    ],
    "newline",
  );

  assert.deepEqual(writes, [TERMINAL_SUBMIT_SEQUENCE]);
});

test("入れ替え時、日本語入力中の文字キーは端末に委ねる（横取りしない）", () => {
  // 0.2.2〜0.2.3 の「入力できない」の再現。
  //
  // Windows の IME は変換中、Enter に限らずすべてのキーを
  // keyCode 229 / key "Process" で通知する。Enter かどうかを見ずに
  // 「変換中 かつ 入れ替え有効」だけで抑止すると、日本語を打つあいだ
  // 文字キーが軒並み preventDefault され、IME に何も入らなくなる。
  //
  // 「あいさつ」と打つ想定（KeyA / KeyI / KeyS / Space）。
  const composingKeys = ["KeyA", "KeyI", "KeyS", "Space"].map((code) =>
    keyEvent({ code, isComposing: true, key: "Process", keyCode: 229 }),
  );

  const { dispositions, writes } = drainEnterSequence(
    composingKeys,
    "newline",
  );

  // すべて xterm（＝IME）に委ねる。1つでも横取りすると入力できなくなる。
  assert.deepEqual(
    dispositions,
    composingKeys.map(() => "delegate-to-xterm"),
  );
  assert.deepEqual(writes, []);
});

test("既定（Enter=送信）でも日本語入力中の文字キーは端末に委ねる", () => {
  const composingKeys = ["KeyN", "KeyO"].map((code) =>
    keyEvent({ code, isComposing: true, key: "Process", keyCode: 229 }),
  );

  const { dispositions } = drainEnterSequence(composingKeys, "submit");

  assert.deepEqual(
    dispositions,
    composingKeys.map(() => "delegate-to-xterm"),
  );
});
