# Code signing policy

AI Agent CLI Cockpit is maintained by QUEST LLC under the
[quest-stack GitHub organization](https://github.com/quest-stack).

## Current status

SignPath Foundation integration is being prepared. Acceptance, a signing
certificate, and production signing are not yet configured. Existing releases
and artifacts from the Windows build workflow are **unsigned**. This policy
does not mean that SignPath Foundation has endorsed or accepted the project.

After acceptance and successful production signing, the attribution will be:

> Free code signing provided by [SignPath.io](https://about.signpath.io/),
> certificate by [SignPath Foundation](https://signpath.org/).

Only releases explicitly identified as signed, with a valid Authenticode
signature, will use that attribution as a statement about their installers.
Unsigned historical releases will remain identified as unsigned.

## Team roles

The following roles are assigned to the
[quest-stack organization owners](https://github.com/orgs/quest-stack/people?query=role%3Aowner)
responsible for this repository:

- **Authors / committers:** maintain the project's source code and build scripts.
- **Reviewers:** review contributions before merging them into the release source.
- **Approvers:** decide whether a verified build may be signed and distributed.

Production signing will be enabled only after these accounts are assigned the
corresponding SignPath permissions and use multi-factor authentication for
both GitHub and SignPath. Every production signing request requires a human
approver; the workflow will not approve itself.

## Build and release rules

1. Build from the public source repository using GitHub-hosted Windows runners.
   Build ARM64 and x64 installers on their respective native architectures.
2. Use the committed dependency lockfile. Require type checks, lint, unit tests,
   and the PowerShell / language-edition checks before collecting installers.
3. Upload the generated installers as GitHub Actions artifacts. Preserve the
   originating commit, workflow run, version, architecture, and SHA-256 hashes.
   These metadata files document the build; GitHub / SignPath origin verification,
   rather than a self-reported JSON file, will establish signing provenance.
4. Submit only this project's installers for signing. Upstream OSS binaries may
   be included with their licenses; they are not signed as this project's code.
   Claude Code and Codex CLI are installed separately and are not bundled.
5. After manual approval and signing, verify the installers' Authenticode
   signatures and calculate new SHA-256 hashes of the signed files. The unsigned
   workflow's hashes must not be reused for signed downloads.
6. Publish releases and change the update manifest only after release approval.
   Include a **Code signing policy** link and the applicable attribution in each
   signed release's download notes. The build workflow currently publishes no
   releases and performs no signing.

A code signature identifies the signing publisher and protects file integrity.
It does not guarantee that Windows SmartScreen will suppress every warning.

## Privacy policy

See [Privacy policy](PRIVACY.md) for local storage, the automatic update check,
and the separate data policies of CLIs and services chosen by the user.

## Reference

- [SignPath Foundation conditions](https://signpath.org/terms.html)
- [SignPath GitHub build integration](https://docs.signpath.io/trusted-build-systems/github)

---

## 日本語

現在はSignPath Foundationの導入準備中です。採択・証明書・本番署名は未設定で、
既存の配布物と自動ビルドの成果物は未署名です。

署名の承認者は、このリポジトリを管理するquest-stackの組織所有者です。
GitHubとSignPathの多要素認証、GitHub上でのビルド、成果物の出所確認、
署名ごとの人による承認を整えてから本番署名を開始します。
署名後は署名の有効性を確認し、署名済みファイルのハッシュ値を計算し直します。

利用者の情報の扱いは[プライバシー方針](PRIVACY.md)を参照してください。
