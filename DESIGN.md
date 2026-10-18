# Cockpit build and signing boundaries

## macOS trial

The Mac trial reuses the renderer, workspace format and Electron IPC boundary.
`shell-launch.ts` selects an interactive login zsh/bash and adds common local
CLI locations for Finder/Dock launches. POSIX bootstrap commands preserve the
pane directory and Codex's existing opt-in behavior; Windows retains PowerShell,
UTF-8 initialization and ConPTY settings. No shell profiles or CLI settings change.
The legacy `powershell` workspace command remains readable; Mac launchers offer
`shell` for an empty terminal instead.

The sandboxed preload exposes only the host platform alongside the existing
restricted API. Mac app shortcuts use Command; Control+C remains terminal input
unless the existing user setting explicitly changes it, and Control+Tab stays
Control+Tab because Command+Tab belongs to macOS. Native Edit-menu clipboard
events and keyboard paste converge on one image-aware paste path. POSIX dropped
paths are single-quoted, including literal shell metacharacters.

Mac windows reserve room for native traffic lights and provide native app/edit/
window menus. As on Windows, closing the last window quits the app and its CLIs.
Mac trials skip the Windows-only public update manifest entirely. The Windows
release, version, manifest, app-data location and dependencies are unchanged.

`macos-trial.yml` runs on native Apple Silicon and Intel GitHub runners. It checks
types/lint/unit tests, rebuilds node-pty for Electron, tests real shell startup,
Command+V/native-menu image paste, pane restoration and opted-in Codex bootstrap,
then packages and repeats those checks in the packaged app. `build-macos-trial.mjs`
generates an ICNS icon from the committed ICO and builds Japanese DMG/ZIP packages
with `--publish never`. They use ad-hoc signing, without Developer ID credentials
or notarization. `collect-macos-trial.mjs` collects only packages, user guidance,
license/privacy documents, checksums and source metadata into CI artifacts.
There is no automatic GitHub release, signing-secret addition or public update.
The trial must still be checked with real Japanese IME and the actual AI CLIs on
the recipient's Mac; stub tests do not claim to cover those providers' behavior.

## Windows build

`.github/workflows/windows-build.yml` builds Japanese and English installers
on GitHub-hosted x64 and ARM64 Windows runners. Each target uses native Node.js
and the committed dependency lockfile, including node-pty's upstream Windows
prebuilds. Type checks, lint, unit tests, and the existing PowerShell / language
edition E2E checks must pass before collecting artifacts.
Shared Codex startup is tested through the real PowerShell PTY and again in the
packaged application on each native architecture before uploading installers.
Electron 42's lazy runtime download is performed in a separate setup step
before timed Playwright tests. The test timeout remains unchanged.
Edition packaging explicitly passes `--publish never` to electron-builder so
main-branch CI cannot trigger its implicit GitHub release publishing.

`scripts/collect-ci-artifacts.mjs` accepts only the runner's native Windows
architecture. It collects exactly the two expected installer names, checks
their executable headers, and writes SHA-256 checksums and source / run metadata.
Outputs are under the ignored `release/ci/<architecture>` directory. GitHub's
artifact ID and origin metadata, rather than the JSON file alone, will be the
source of SignPath provenance verification.

The workflow has read-only repository permissions, no persisted checkout
credentials, no signing secrets, and no release-publishing step. GitHub Actions
files use pinned upstream commits. Artifact retention is 14 days.

## SignPath preparation

The public policy documents clearly identify the current unsigned state.
Both language-edition packages include the policy and privacy documents under
`resources/docs`, so the bundled README's relative links have local targets.
Foundation acceptance and installation of its GitHub App are separate account
operations. Production signing will be added after onboarding, with explicit
human approval and verification of signed outputs. Signed hashes differ from
the unsigned build hashes and must be calculated after signing.

The NSIS installer includes upstream Electron / node-pty binaries. Signing the
outer installer does not also sign its payload or uninstaller. Confirm the
required signing phases and artifact configuration with SignPath before the
first production signed release.

## Privacy

The policy documents the existing automatic GitHub update request accurately;
it does not claim that all network access is user-initiated. Session content and
diagnostics are not automatically uploaded to the maintainer. Third-party CLI
processes have their own network behavior and data policies.

Signing preparation does not change saved settings, dependency versions,
the update manifest, or existing releases.

## Circled-number rendering

A circled number immediately followed by an ASCII space is joined for drawing
within its existing two cells. The terminal buffer, Unicode width rules, cursor
reports and copied text are unchanged. Compact circled numbers in DOM use the
existing Sarasa symbol font; WebGL rescales oversized one-cell glyphs to avoid
overlap. xterm excludes emoji from that rescaling. Joined numbers use the OS
symbol font, including Hiragino on
Mac. DOM spans use screen-grid measurements rather than xterm's shared character
measurement element, which can contain an arbitrary cached glyph. Tests cover
DOM/WebGL geometry, raster width, cursor reporting and copied text.
The Intel macOS hosted VM's WebGL fixture explicitly uses SwiftShader because
that VM has no hardware WebGL. This is limited to the trusted test process;
normal app launches retain the existing automatic DOM fallback.

## Subagent activity detection

On Windows, standard Claude and independent Codex launches receive per-invocation
observational hooks. The PowerShell hook saves only validated lifecycle IDs and
event types locally, never stdin text, prompts, paths or transcripts. Atomic
files, session directories, ownership locks and bounded polling isolate sessions.
Hooks stay silent and never change approval, sandbox or trust settings; Codex's
own hook review remains required.

Active child IDs keep an otherwise idle terminal busy. Approval prompts take
priority, and one child's lifecycle cannot clear siblings. Exit and disposal
clear activity and reject late events. Output heuristics remain the fallback
when hooks are disabled, untrusted or unavailable. Mac does not run PowerShell
hooks. Shared Codex also keeps output detection: its existing daemon owns server
configuration, and client overrides are not assumed to reconfigure that daemon.
Shared startup and phone opt-in are preserved.

## Codex shared-server startup

For the standard `codex` session command, Cockpit reads the existing boolean
`remoteControlEnabled` from the user's Codex managed-daemon settings. An explicit
true value selects shared startup; missing, disabled or malformed settings retain
the existing independent CLI startup. Cockpit does not enable remote access,
create pairings, read credentials, or write Codex configuration.

Shared startup first starts the existing managed daemon, then runs the terminal
client with `--remote unix://` and the pane's explicit current directory. A failed
daemon start leaves an actionable error in the shell and does not fall back to an
independent writer. This selection happens for new or restarted panes; existing
processes are not migrated or interrupted. Claude, PowerShell and custom commands
retain their existing startup behavior.
