# Codexを携帯と共有する（0.2.13以降）

CockpitのCLIと携帯が別々のサーバーで同じ会話を開くと、書き込みの競合で再開できません。
共有サーバーへ接続すると、Cockpitで開いた会話を携帯からも継続できます。

1. Codex CLIでRemote Controlを設定します。起動・ペアリングの手順は[公式CLIリファレンス](https://learn.chatgpt.com/docs/cli/reference#codex-remote-control)を参照してください。検証に使ったCLIは0.162.1です。
2. Cockpitで通常どおり「Codex」を選んで起動します。CLIの共有接続設定が有効なPCでは、共有サーバーを起動してから接続します。作業フォルダーは選択したペインの場所になります。
3. 携帯から同じPCの会話を開いて確認します。

`Remote app server already online` やブラウザ接続のエラーが出た場合は、エラー全文とCLI・アプリの版を確認してください。アプリの接続許可を一律にオフにする手順は案内しません。動作している接続設定・ペアリングを保持し、原因に合った対処を確認します。

Cockpitは既存のCodex設定から共有接続の有効・無効だけを読み取ります。リモートアクセスの有効化、ペアリング、認証情報の取得や設定変更は行いません。
共有サーバーの起動に失敗した場合はエラーを表示し、別の独立セッションへ切り替えません。

更新前から動いているCLIはそのまま動き続けます。同じ会話を別のサーバーへ移すときは、元の処理と未送信入力を保護し、元のCLIが会話の書き込みを解放してから再開してください。使用中の会話のロック削除や共有サーバー全体の再起動で移行を強制しないでください。
設定が無い・無効・読み取れない場合、またはClaude・PowerShell・独自コマンドを使う場合は従来の起動方法を保ちます。

## English

Starting in 0.2.13, standard Codex launches and pane restarts automatically attach to the shared managed server when the CLI's existing remote-control setting is enabled. This lets the terminal and phone use the same conversation without competing writers.

Set up CLI remote control using the [official reference](https://learn.chatgpt.com/docs/cli/reference#codex-remote-control). CLI 0.162.1 was used for verification. For `Remote app server already online` or browser connection errors, record the exact error and CLI/app versions. Preserve working connection settings and device pairings; disabling the desktop app's connection allowance is not a general troubleshooting step.

Cockpit reads the existing opt-in; it does not enable remote access, create pairings, read credentials, or write Codex settings. The selected working directory is passed explicitly. A failed daemon start shows an error rather than opening an independent session. Existing processes are not migrated automatically. Missing, disabled or unreadable settings, other CLIs, and custom commands retain their previous behavior.

When moving a conversation to another server, protect running work and unsent input, and let the original CLI release its writer before resuming. Do not remove conversation locks or restart the shared daemon to force ownership.
