# AI Agent CLI Cockpit

[日本語](https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/README.md) · English

A Windows terminal app that brings your Claude Code and Codex CLI sessions into one window, with tabs and split panes.

Keep work on different projects separate, see which sessions need attention, and switch between them without hunting through terminal windows. Cockpit manages the workspace; you control the CLIs and their approvals.

## Download and install

Choose **English** on the [Releases page](https://github.com/quest-stack/ai-agent-cli-cockpit/releases), then select the installer for your PC:

| Windows PC | English installer |
| --- | --- |
| Intel or AMD (x64) | `CLI-Cockpit-0.2.8-en-win-x64.exe` |
| ARM64 | `CLI-Cockpit-0.2.8-en-win-arm64.exe` |

Check **Settings → System → About → System type** if you are unsure. The Japanese edition is a separate download. There is no language switch inside the app.

### Requirements

- Windows 11, ARM64 or x64.
- Node.js 22.12.0 or later.
- The CLI you want to use, installed and working in PowerShell. Check with `claude --version` or `codex --version`.

Cockpit does not bundle the AI CLIs or their subscriptions. Install and sign in to each CLI separately before starting it here.

Run the installer and follow the prompts. These installers are unsigned, so Windows SmartScreen may warn you. Only proceed if you trust the download's source. Compare its SHA-256 hash with the release checksums when available.

Updates are manual. Close Cockpit, then run the newer installer for the **same language and CPU architecture**. Your saved workspace and settings are retained. The Japanese and English editions share the same application identity and settings; they are alternatives, not separate apps to run together.

## Start a session

1. Choose **New Session**.
2. Select a project folder with **Browse**, enter its path, or choose a recent folder. Pin folders you use often.
3. Choose `claude`, `codex`, or **PowerShell (shell only)**.
4. Optionally name the session after the task. The CLI name is used if you leave this blank.
5. Choose **Start Session** or press Enter.

Every session has its own process and working directory. The sidebar, tabs, and recent-session cards show the task name first and the folder name underneath or beside it. Double-click a session name in the sidebar to rename it.

Closing a running session or a tab containing running sessions asks for confirmation, including when a session is idle. Cancel or press Esc to keep working. Use ↻ beside an exited session to restart it with the same settings.

## Tabs, panes, and search

Split a tab to keep multiple sessions visible. Use the pane's zoom button to temporarily show it alone; restore it to return to the original split sizes. Other sessions keep running while a pane is zoomed.

Search looks through the current scrollback of all open sessions. The workspace layout, session names, folders, and launch commands are saved locally. **Restoring a workspace starts new processes; it does not restore the old terminal output or conversation.** Use your CLI's own resume feature when you need to continue a conversation.

## Copy, paste, and multiline input

- **Ctrl+V** or **Ctrl+Shift+V** pastes text or a screenshot. Images are saved as temporary PNG files and their paths are inserted into the CLI. The selected CLI must support image input.
- Dropping files onto a terminal inserts their paths.
- By default, **Ctrl+C interrupts the CLI**. Use the **Ctrl+C: Interrupt / Copy** button in the title bar to change it. In Copy mode, Ctrl+C copies the selection; with nothing selected, it does nothing. This prevents accidental interruption, and your choice is saved.
- **Ctrl+Shift+C** copies selected text in either mode.
- Normally, **Enter sends** and **Shift+Enter inserts a newline** in Claude Code and Codex. Enable **Enter inserts a newline** in Settings to reverse those two keys. This changes Cockpit's input handling, not your CLI configuration files.

Pasted text is passed through the terminal's bracketed-paste handling. How a multiline command is interpreted still depends on the receiving shell or CLI; review it before submitting.

## Status and notifications

| Dot | Meaning |
| --- | --- |
| Blue | Idle, ready for the next task |
| Yellow | Working |
| Red | Needs approval or attention |
| Gray | Exited |

These indicators are estimates based on terminal output. They do not approve requests or send responses. Use the bell icon to turn Windows attention notifications on or off.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+T | New tab |
| Ctrl+Shift+W | Close the current tab |
| Ctrl+Shift+D | Split right |
| Ctrl+Shift+E | Split down |
| Ctrl+Shift+Enter | Zoom or restore the active pane |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Alt+arrow keys | Focus an adjacent pane |
| Ctrl+Shift+F | Search all panes |
| Ctrl+V / Ctrl+Shift+V | Paste text or an image |
| Ctrl+C | Interrupt or copy, as selected in the title bar |
| Ctrl+Shift+C | Copy selected text |
| Shift+Enter | Insert a newline, unless swapped in Settings |
| Ctrl+Shift+R | Refresh the terminal display |
| F1 | Help and shortcuts |

## If the display glitches

Cockpit automatically refreshes the display to recover from blank areas, missing glyphs, or misaligned borders. Press **Ctrl+Shift+R** to refresh immediately. This only redraws the screen and sends no input to the CLI.

GPU rendering falls back when needed. If an input or display problem persists, report the Cockpit version, CLI and version, the keys you pressed, and what you expected versus what happened. Do not include credentials or private project data in reports.

## Start sessions from incoming requests

This optional feature is **off by default**. In Settings, enable **Start sessions from incoming requests** and copy the inbox folder path. A JSON file placed there can start a Claude session:

```json
{
  "cwd": "C:\\work\\project",
  "title": "Review changes",
  "prompt": "Review the current changes and summarize your findings."
}
```

The folder must exist. The title and initial prompt are optional. Requests always launch Claude; they cannot supply an arbitrary executable. Use a `.json` filename. The request file is removed after processing.

Anyone who can write to the inbox can cause work to start on this PC. Cockpit does not open a network port for this feature. Arrange delivery yourself, and only enable it when that access is appropriate.

## Privacy and local storage

- Cockpit does not collect telemetry or upload session content. Settings and the workspace stay on this PC.
- It checks a release manifest on GitHub for available updates. Downloads and links open in your browser when you choose them.
- Claude Code, Codex, and other commands you run retain their own network behavior, accounts, permissions, and data policies.
- Settings are stored in `%APPDATA%\claude-cli-cockpit`. This folder name is retained for compatibility.
- Pasted images are written to your Windows temporary folder. Treat them like the screenshots they contain.

## Known limitations

- Windows only. Use the installer that matches your CPU architecture.
- The app's minimum supported window width is 760 px; it is not a mobile interface.
- Session status detection is approximate.
- IME and terminal rendering behavior may vary across CLI and Windows versions. Version 0.2.9 fixes the reported IME positioning and committed-text loss cases. Native Japanese IME input was checked in Claude and Codex; long sessions, heavy output, and other Windows IME setups still need validation.
- Restoring a workspace does not restore the previous process or terminal scrollback.
- Cockpit never makes approval decisions on a CLI's behalf.

## Development

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

Build both fixed-language editions without packaging:

```powershell
npm run build:editions
```

Build the four Windows installers (Japanese/English × ARM64/x64):

```powershell
npm run package:editions
```

For just one target, use `npm run package:editions -- --language=en --arch=x64`. Build outputs are isolated under `dist/editions/<language>`; installers are under `release/<version>/<language>`. Packaging requires the appropriate Electron/node-pty native binaries. No language-setting preference is stored in the workspace.

## License

[MIT](LICENSE). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency notices.

## Bug reports and feature requests

Cockpit was built for our own work and is shared as-is. We welcome bug reports but cannot promise fixes or support. We generally do not accept feature requests. You are welcome to fork it under the MIT license.
