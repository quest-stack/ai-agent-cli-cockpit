# Cockpit build and signing boundaries

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

This change does not alter app behavior, saved settings, dependency versions,
the update manifest, or existing releases. Other worktrees hold the separate
session-status and circled-number changes.

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
