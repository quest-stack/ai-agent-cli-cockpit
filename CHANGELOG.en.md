# Changelog

## 0.2.11 — 2026-09-30

- **Fixed terminal links opening twice from one click.** Cockpit now handles link clicks without forwarding the same gesture to the CLI. Ordinary mouse input, dragging, and Shift text selection remain available.
- Includes the 0.2.10 Japanese IME, full-width space, and Ctrl+C copy setting fixes, along with the existing Codex duplicate-screenshot fix.

## 0.2.10 — 2026-09-30

- **Japanese input after cancellation:** fixed input stopping after cancelling IME composition. You can continue typing Japanese without switching to alphanumeric mode. Empty commit events now use the change in the input field to deliver committed text.
- **Full-width spaces:** fixed a path that sent the same space twice when pressing Space with IME enabled after a Japanese commit.
- **Ctrl+C copy setting:** moved to **Settings > KEYS**. Copy mode still does nothing when no text is selected, and your existing setting is retained.
- **Terminal links:** clicking an HTTP/HTTPS link opens it directly in the default browser.
- **Diagnostic logs:** new input diagnostics record lengths and types rather than typed text or CLI output fragments. Existing logs are unchanged.

Native IME comparisons and user trials on Windows ARM64 confirmed recovery from the input-stopping case. Automated regression tests cover Claude and Codex input, cancellation, full-width spaces, copy, and paste.

## 0.2.9 — 2026-09-25

- **Japanese input on Windows:** fixed cases where the IME composition appeared away from the input field or committed text did not reach the CLI. Native IME candidate selection, consecutive input, and input after switching tabs were checked with Claude and Codex.
- **Includes the 0.2.8 copy and paste fixes:** the Ctrl+C Interrupt / Copy toggle, the duplicate screenshot paste fix in Codex, and multiline paste remain available.

Validation on long sessions, heavy terminal output, and other Windows IME setups is ongoing.

## 0.2.8 — 2026-09-24

- **English edition:** separate English installers for Windows ARM64 and x64. The UI, help, tour, dialogs, and notifications are translated. Update downloads stay in the same language. There is no in-app language switch.
- **Recent sessions:** task names now take priority over folder names on the launcher cards.
- **Screenshot paste:** fixed an input path that could attach the same screenshot twice in Codex. Cockpit now intercepts Ctrl+V before it reaches the CLI, then pastes the image path once.
- **Command paste:** removed the same extra Ctrl+V input that preceded pasted text. Clipboard failures now show a message. A tester's broader report of command-paste failures still needs confirmation because the original steps are unknown.
- **Safer copying:** a title-bar button switches Ctrl+C between Interrupt and Copy. Copy mode never interrupts a CLI, even when nothing is selected, and the setting is saved.
- **Terminal links:** confirmed HTTP/HTTPS links open through the default browser, with a visible error if opening fails.

## Earlier releases

The English edition starts with 0.2.8. Earlier release history is available in the [Japanese changelog](https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/CHANGELOG.md).
