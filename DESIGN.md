# Cockpit build and signing boundaries

## Windows build

`.github/workflows/windows-build.yml` builds Japanese and English installers
on GitHub-hosted x64 and ARM64 Windows runners. Each target uses native Node.js
and the committed dependency lockfile, including node-pty's upstream Windows
prebuilds. Type checks, lint, unit tests, and the existing PowerShell / language
edition E2E checks must pass before collecting artifacts.
Electron 42's lazy runtime download is performed in a separate setup step
before timed Playwright tests. The test timeout remains unchanged.

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
