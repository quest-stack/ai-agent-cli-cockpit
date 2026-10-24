# Changelog

## 0.2.15 — 2026-10-24

- **Fixed automatic Preview opening for generated PDFs and images.** Completed generation/save messages and delivered artifact links are recognized. Reading existing material or startup documents such as AGENTS.md and README no longer opens them automatically.
- **Automatic previews follow newly generated artifacts.** Manual selections, explicitly closed previews and active comparisons are retained. Links with spaces, Japanese completion messages and terminal file hyperlinks are supported.
- **Fixed unchanged paragraphs being highlighted as changes.** Insertions, deletions and reflow no longer mark every displaced element. Comparison checks text, specified CSS, reordered elements, SVG shapes/colors, long text and meaningful whitespace.
- **Fixed capturing a comparison baseline before the preview finished loading.** PDF highlighting requires matching displayed pages and zoom levels.

Automatic discovery relies on CLI wording; use the file picker when an output is not recognized. Comparison uses the saved baseline and the current view, rather than all PDF pages or document semantics.

## 0.2.14 — 2026-10-19

- **CLI selection uses buttons and remembers your choice.** Pick Claude Code, Codex or PowerShell (Shell on Mac) with one click. New tabs, panes and app restarts retain the selection.
- **Added Cancel input and Ctrl+Shift+X.** Send Ctrl+C explicitly while keeping Copy mode enabled. This cancels pending input or interrupts work in progress. Use Command+Shift+X on Mac.
- **Added a Japanese Mac trial for Apple Silicon and Intel.** Command shortcuts, pane splits, copying and screenshot paste are supported. See [the trial guide](docs/MACOS_TRIAL.md) for installation and limitations.
- **Improved circled numbers followed by a space.** The glyph uses the existing two terminal cells without changing text, cursor position or copied content. Adjacent circled numbers retain their compact width.
- **Windows activity indicators can stay busy while subagents work silently.** Supported for standard Claude Code and independent Codex launches with hooks enabled and any required Codex trust review complete. Approval prompts take priority. Shared Codex, Mac and unavailable hooks retain terminal-output detection.
- **Direct Claude Code / Codex calls stay yellow while waiting for results.** Uses the same supported Windows hooks, tracks parallel tool calls separately, and releases them on completion or failure. Explicit input cancellation returns to output-based detection. Detached background work after the launching tool returns is not covered.
- **Added concrete README examples for screenshot requests and parallel work with the same or different AI CLIs.**

Includes the update-notice encoding fix published on October 16. This does not imply that every display issue or unexpected character in an AI CLI's own output is resolved.

## 0.2.13 — 2026-10-16

- **Codex sessions now automatically attach to the shared server when CLI remote control is already enabled.** Standard launches and pane restarts preserve the working directory. PCs without that existing opt-in keep their previous startup behavior. See `docs/CODEX_REMOTE.md` for setup.

## 0.2.12 — 2026-10-08

- **Fixed divider lines shifting on rows that contain emoji.** Emoji such as ⏳✅📌 are now measured as two cells wide, matching how Claude Code and Codex lay out the screen. Vertical dividers beside side panels and table borders now line up.
- **Fixed symbols such as ①②③, ◔◑◕ and → being squashed and unreadable.** These symbols now use glyphs designed to fit a single cell. Only the symbol range of Sarasa Term J (SIL Open Font License 1.1) is bundled; see THIRD-PARTY-NOTICES.md for the license.

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
