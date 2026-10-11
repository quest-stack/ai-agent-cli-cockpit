# SignPath CIの自動公開抑止

作成日: 2026-10-11 / 作成者: Codex

- 作業場所: `clients/_internal/cockpit-signpath-ci-20261011`
- ブランチ: `fix/signpath-ci-no-publish-20261011`
- ベース: main `1cb07e279200fe2d2b5d5dd6448b71d98108277e`（PR #14統合済み）
- commit・push・PR・CI成功後の統合は、SignPath準備のユーザー承認範囲。

## 原因と修正

PR #14の両Windowsジョブは成功し、公開文書5件の内容一致を確認済み。
mainのrun 38139283595ではelectron-builderがCI環境を見て自動公開を試み、
GitHubトークン未設定でパッケージ工程が失敗した。
`scripts/build-editions.mjs`から`--publish never`を常に渡し、通常の
パッケージ作成をGitHub Releaseへの公開から切り離す。
トークン設定やRelease公開は行わない。

## 検証と次のアクション

- typecheck / lint / build: 成功。
- CI=true・GITHUB_ACTIONS=true・GITHUB_REF=refs/heads/mainで、日英ARM64の
  パッケージが成功。自動公開の開始・トークン要求はなく、終了コード0。
- UTF-8/BOMなし・文字化け/秘密値パターン・git diff --check: 成功。
- 次はPRでx64/ARM64の両ジョブが成功後に統合し、mainでもインストーラー生成と
  artifact保存を確認する。

SignPathフォームのBuild SystemはGitHub Actions。
Privacy Policy URLは`https://github.com/quest-stack/ai-agent-cli-cockpit/blob/main/docs/PRIVACY.md`。
Download URLは`https://github.com/quest-stack/ai-agent-cli-cockpit`。
同意・CAPTCHA・申請送信と、採択後の署名設定は次の工程。

他のworktree・インストール済みCockpit・利用中セッションは操作していない。
