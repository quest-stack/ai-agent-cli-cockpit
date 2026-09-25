# Changelog

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
