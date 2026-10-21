# Privacy policy

AI Agent CLI Cockpit is a desktop terminal workspace maintained by QUEST LLC,
with Windows editions and a Japanese-language Mac trial.
This document describes Cockpit's own behavior. Programs started inside a
terminal have their own permissions and data handling.

## Local information

- Settings, workspace layouts, session names, launch commands, and recent / pinned
  project paths are saved on your PC under
  `%APPDATA%\claude-cli-cockpit` on Windows or
  `~/Library/Application Support/claude-cli-cockpit/` on Mac, including
  `session.json`. Preview target paths and selected targets are stored locally
  in `preview.json` in the same directory.
- Terminal output is displayed locally and retained in the running terminal's
  scrollback. Cockpit does not upload the workspace, prompts, terminal output,
  clipboard contents, or project files to QUEST LLC.
- A local `diagnostic.log` records operational events, errors, rendering and
  input diagnostics, and update-check results. Entries may include local paths,
  session identifiers, or limited character / output details used to investigate
  display problems. It is not automatically sent to the maintainer. Review and
  redact it before sharing it in a bug report.
- When you paste an image, Cockpit writes a PNG named `cockpit-paste-*.png` to
  your OS temporary directory and passes its path to the selected terminal.
  That program may read or upload the image when you ask it to do so. These
  temporary images are not automatically removed by Cockpit after pasting.
- The optional incoming-request feature reads files in the local inbox folder
  and starts a CLI session. It is off by default and does not open a network
  listening port. Anyone able to write to that folder may initiate work when
  you enable the feature.

Cockpit has no advertising, analytics, or telemetry service and does not require
a Cockpit account. Settings and files stored by the operating system, Electron,
your shell, or your chosen CLI remain subject to their respective behavior.

## Network activity

The Windows editions automatically check for an update once after startup by retrieving
`update-manifest.json` from `raw.githubusercontent.com`. The request does not
include your session contents or project files. As with any HTTPS request,
GitHub receives connection information such as your IP address and request
headers. The current application has no setting to disable this update check;
the Windows app remains usable when that request fails or the PC is offline.
The Mac trial skips this Windows update manifest and is updated manually.

Preview can load local files and pages on `localhost`, `127.0.0.1`, or `[::1]`.
Local-server previews allow requests only to the selected local origin,
including that server's reload connections. External API and CDN requests
from preview content are blocked. Cockpit does not upload preview files or
comparison images to QUEST LLC. A local development server may have its own
network behavior, which this policy does not control.

Download pages and other external links open in your browser when selected.
Your browser and the destination site then handle that connection.

Claude Code, Codex CLI, and other commands run as separate processes under your
operating-system account. They may access files and communicate with their own services
according to their configuration, the task you request, and the permissions you
grant. Cockpit does not bundle those CLIs or override their privacy settings.

Relevant service policies:

- [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  for the update manifest, repository, releases, and issue reports.
- [Anthropic privacy policy](https://www.anthropic.com/legal/privacy) for Claude
  services, subject to the terms and account type you use.
- [OpenAI privacy policy](https://openai.com/policies/privacy-policy/) for OpenAI
  services, subject to the terms and account type you use.
- For other shells, commands, extensions, or service providers, review their
  own documentation and policies.

## Retention and reports

Cockpit does not operate a server for storing user sessions or diagnostic logs.
Settings, diagnostics and pasted screenshots remain until you or a system
cleanup facility remove them. Preview files and saved comparisons use a local
temporary cache. HTML, localhost and Markdown comparison history retains up to
three versions per target, with a 100 MiB overall comparison-data limit.
Preview cache cleanup runs on normal exit and clears owned leftovers from
stopped instances at the next startup after an abnormal exit. Original user
files are not deleted by this cleanup.
Close Cockpit before removing its settings directory; doing so resets the saved
workspace and preferences. Manage CLI histories and credentials separately.
You can uninstall the app through Windows Settings or remove it from Applications
on Mac; do not assume uninstalling
also removes retained settings, temporary screenshots, or a CLI's data.

If you submit an issue or a report, you choose what information to share.
GitHub issues are public. Do not include credentials, personal information,
confidential project content, or unredacted screenshots and logs.
Questions about this policy may be raised through the
[project's issue tracker](https://github.com/quest-stack/ai-agent-cli-cockpit/issues)
without including private data.

---

## 日本語

Cockpitは、設定・作業配置・セッション名・作業フォルダーの履歴をPC内に保存します。
プロンプト、端末出力、画像、プロジェクトファイルをQUESTへ自動送信しません。
広告・分析・テレメトリの機能はありません。

設定と診断ログはWindowsでは`%APPDATA%\claude-cli-cockpit`、Macでは
`~/Library/Application Support/claude-cli-cockpit/`、貼り付け画像はOSの
一時フォルダーに保存されます。診断ログにはパスや表示調査用の文字情報などが
含まれることがあるため、報告に添付する前に確認して機密情報を除いてください。
貼り付け画像は、貼り付け後にCockpitが自動削除する仕組みにはなっていません。

Windows版は起動後にGitHubへ更新情報を1回取りに行きます。セッション内容は含めませんが、
通常のHTTPS通信に伴うIPアドレスやリクエストヘッダーはGitHubへ届きます。
Windows版にこの確認を無効にする設定はありません。通信できなくても利用できます。
Mac試用版はこの更新情報を取得せず、新しい試用版へ手動で入れ替えます。

プレビューはローカルファイルとlocalhostのページを表示します。ページの通信は選んだ
localhostの同一接続先に限り、外部API・CDNへの通信は許可しません。ローカル開発サーバー
自体の通信は別です。プレビューの内容・比較画像をQUESTへアップロードしません。
対象の一覧は設定フォルダーの`preview.json`、表示・比較用のデータは一時領域に保存します。
HTML・localhost・Markdownの比較履歴は対象ごとに最大3世代、全体で100 MiBまでです。
正常終了時に一時データを削除し、異常終了時の残りは次回起動時に所有を確認して掃除します。
元のユーザーファイルは削除しません。

Claude Code・Codexなどで送信する指示・ファイル・画像は、各CLIとサービス側の
設定・権限・規約に従います。Cockpitの方針だけで、各CLIの通信を制限することはできません。
外部サービスの方針へのリンクは上の「Network activity」にあります。

設定・診断ログ・貼り付け画像は、利用者またはOSの清掃機能で削除するまで残ります。
設定を削除する場合は先にCockpitを終了してください。アンインストール後も
設定・一時画像・各CLIの履歴などが残ることがあります。
不具合報告には、個人情報・顧客情報・認証情報を含めないでください。
