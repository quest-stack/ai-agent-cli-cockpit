# Windows IME input boundary

`src/renderer/composition-input.ts` adapts xterm.js 6.0.0 composition handling.

- Nonempty `compositionend.data` delivers the committed text once. A preceding internal keydown commit is not sent again.
- Empty commit events compare the textarea after the event with its value before composition. Cancellation sends no text.
- After cancellation without an inserted diff, the focused terminal reconnects its input focus. A new composition, another focused field, or a disposed terminal prevents this recovery action.
- A keyCode 229 textarea-diff timer is suppressed only when composition starts from the same key. The composition commit owns delivery; symbol input without composition retains the diff path.
- Internal methods are shape-checked and restored on disposal. Re-run IME lifecycle E2E when updating xterm.js.
- Input diagnostics contain only lengths, types, focus state, and geometry. Existing logs are not rewritten.

Electron E2E covers the observed Windows event ordering in both Claude and Codex panes. Event injection and native Windows IME checks are distinct: native cancellation/refocus comparison and subsequent user trials were performed on Windows ARM64. Other Windows/IME configurations remain additional validation targets.
