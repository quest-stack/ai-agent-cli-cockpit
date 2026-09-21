import { X } from "lucide-react";

interface HelpPanelProps {
  onClose: () => void;
  version?: string;
}

interface ShortcutEntry {
  keys: string;
  note?: string;
  what: string;
}

/**
 * ショートカットと、困ったときの対処をアプリ内で読めるようにする。
 *
 * README は配布物を開かないと読めないため、Cockpit 固有の操作
 * （素の端末では効かない Shift+Enter や、表示が崩れたときの
 * Ctrl+Shift+R）に気づけない。ツアーは一度見たら終わりなので、
 * いつでも開ける常設のリファレンスとして分けている。
 */
const SHORTCUTS: ShortcutEntry[] = [
  {
    keys: "Shift + Enter",
    note: "Cockpit が変換しています。素の端末では効きません",
    what: "送信せずに改行する（複数行の指示を書く）",
  },
  {
    keys: "Ctrl + V",
    note: "スクリーンショットを撮ってそのまま貼れます",
    what: "画像・文字列を貼り付ける",
  },
  { keys: "Ctrl + Shift + T", what: "新しいタブ" },
  { keys: "Ctrl + Shift + W", what: "今のタブを閉じる" },
  { keys: "Ctrl + Shift + D", what: "ペインを左右に分割" },
  { keys: "Ctrl + Shift + E", what: "ペインを上下に分割" },
  { keys: "Ctrl + Shift + Enter", what: "選択中のペインを最大化／元の分割表示に戻す" },
  { keys: "Ctrl + Shift + F", what: "全ペインを横断検索" },
  { keys: "Ctrl + Tab", what: "次のタブへ（Shift 併用で前へ）" },
  { keys: "Alt + ← → ↑ ↓", what: "隣のペインへ移動" },
  {
    keys: "Ctrl + Shift + C",
    note: "選択していないときは従来どおり中断（SIGINT）",
    what: "選択範囲をコピー",
  },
];

export function HelpPanel({ onClose, version }: HelpPanelProps) {
  return (
    <div className="help-overlay" role="dialog">
      <div className="help-panel">
        <header className="help-header">
          <div className="help-heading">
            <h2>使い方とショートカット</h2>
            <p className="help-version">
              現在のバージョン
              <strong>{version ? `v${version}` : "確認中…"}</strong>
            </p>
          </div>
          <button aria-label="閉じる" onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        {/*
          表示崩れは頻繁に起きるため、ショートカット一覧に埋もれさせず
          最初に置く。利用者が自力で回復できることが分かれば、
          「壊れた」と誤解して閉じてしまうのを防げる。
        */}
        <section className="help-callout">
          <h3>表示が崩れたとき</h3>
          <p>
            画面が真っ黒になる、文字が欠ける、枠と中身がずれる。これらは
            <strong> アプリが自動で直します</strong>
            。何もしなくても数分以内に戻ります。すぐ直したいときは
            <strong> Ctrl + Shift + R </strong>
            を押してください。
          </p>
          <p className="help-note">
            自動でも手動でも CLI には何も送りません。画面を描き直すだけなので、
            作業中でも安全です。崩れているのは表示だけで、CLI 側は
            動いています。
          </p>
        </section>

        <section>
          <h3>ショートカット</h3>
          <dl className="help-shortcuts">
            {SHORTCUTS.map((entry) => (
              <div className="help-shortcut" key={entry.keys}>
                <dt>
                  <kbd>{entry.keys}</kbd>
                </dt>
                <dd>
                  {entry.what}
                  {entry.note ? (
                    <span className="help-note">{entry.note}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3>外出先からセッションを立ち上げる</h3>
          <p>
            設定（歯車）で「受け取った依頼でセッションを起動する」を
            オンにすると、受付フォルダに置かれた JSON から Claude を
            起動します。フォルダの場所は同じ設定画面に出ます。
          </p>
          <pre className="help-code">
{`{
  "cwd": "C:\\Users\\you\\project",
  "title": "見出し",
  "prompt": "最初に伝えたいこと"
}`}
          </pre>
          <p className="help-note">
            ファイル名は何でも構いません（拡張子は .json）。
            起動すると読み取ったファイルは消えます。
            Cockpit はネットワークを開きません。外から届ける経路は、
            この PC で動いている別のセッションに書かせるなど、
            利用者ご自身で用意していただく必要があります。
          </p>
        </section>

        <p className="help-footer">
          設定（歯車）から使い方ツアーを見直せます。
        </p>
      </div>
    </div>
  );
}
