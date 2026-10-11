# SignPath Foundation setup

## Status and boundaries

This is preparation for a Foundation application, not a configured signing
service. No SignPath token, certificate, organization, or production policy has
been set up. Current installers remain unsigned. The workflow builds artifacts
but does not publish a GitHub release or change `update-manifest.json`.

The workflow uses standard GitHub-hosted `windows-2025` (x64) and
`windows-11-arm` (ARM64) runners. Standard hosted runners are free for public
repositories. Keep this repository public and use those runners; self-hosted
builds are not accepted for Foundation OSS signing provenance.

## Before submitting the form

1. Review and merge the workflow and policy documents through a PR.
2. Require both Windows build jobs to pass. Open the Actions run, download
   `unsigned-windows-x64` and `unsigned-windows-arm64`, and check that each
   artifact contains both Japanese and English installers, checksums, and
   `build-metadata.json` matching the run's commit.
3. Check the designated repository owners and signing roles. Configure
   multi-factor authentication for all participating accounts before enabling
   production signing.
4. Use **GitHub Actions** for Build System, and the published
   `docs/PRIVACY.md` page for Privacy Policy URL. Use the repository homepage
   as Download URL during onboarding: its README links to the installers and
   the signing policy. Historical release pages do not yet contain that policy.
   Keep the application description
   and reputation statement accurate: this is an early-stage project; do not
   claim that it is already accepted or widely deployed.
5. Agree to the terms and personal-data processing only if you accept them.
   The marketing checkbox is optional. The applicant handles the CAPTCHA and
   submits the form.

Published privacy URL, after merge:

`https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/docs/PRIVACY.md`

## After Foundation acceptance

1. Install the official SignPath GitHub App for this repository only, after
   reviewing its requested permissions. Follow the onboarding instructions to
   link the repository and configure artifact and signing policies.
2. Configure named authors, reviewers, and human approvers in SignPath.
   Require a human approval for each production signing request.
3. Store a narrowly scoped submitter token in GitHub Actions Secrets through
   the approved account setup. Do not paste it into source files, logs, or chat.
4. Extend the build workflow using the official SignPath submit action and the
   `artifact-id` emitted by its upload step. Use SignPath / GitHub's verified
   source and run metadata. Do not upload an installer built on a local PC for
   production signing. Restrict production signing to reviewed release source
   on `main` or approved version tags. Pull-request jobs must not receive the
   production submitter token or trigger production signing.
5. The uploaded artifact is a ZIP containing installers and policy files.
   Configure SignPath to sign only Cockpit's installers; do not re-sign bundled
   upstream OSS binaries as this project's code. Confirm the NSIS signing
   configuration with SignPath during onboarding, including whether they
   require a separate app / uninstaller signing phase before the outer
   installer is built. Signing the outer installer alone does not sign its
   embedded application.
6. Verify signed outputs with `Get-AuthenticodeSignature`, recalculate their
   SHA-256 hashes, and test install / uninstall on the target Windows PCs.
   Update the policy's acceptance status only after signing is working.
7. Publish a signed release with a **Code signing policy** link and the
   Foundation attribution. Explicitly distinguish older unsigned releases.
   Release publishing and changing the update manifest require release approval.

Copy into the download notes only after valid production signing:

```markdown
## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

[Code signing policy](https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/docs/CODE_SIGNING_POLICY.md)
· [Privacy policy](https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/docs/PRIVACY.md)
```

## References

- [Foundation conditions](https://signpath.org/terms.html)
- [SignPath GitHub integration](https://docs.signpath.io/trusted-build-systems/github)
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Windows SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
