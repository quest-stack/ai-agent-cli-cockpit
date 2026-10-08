# Sarasa Term J（記号だけを切り出した版）

端末で ①②③・◔◑◕・→ などの「東アジアの曖昧幅」の記号を、1マスに収まる字形で
描くために同梱している。これらの記号は Claude Code など多くの CLI が1マス幅として
扱うが、Windows 標準のフォントでは全角の字形しかなく、1マスに押し込まれて潰れていた。

## 出どころ

| 項目 | 内容 |
|---|---|
| フォント | Sarasa Gothic（更紗ゴシック）の Sarasa Term J |
| 作者 | Renzhi Li（Belleve Invis） |
| 配布元 | https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.42 |
| 元ファイル | `SarasaTermJ-TTF-Unhinted-1.0.42.7z` |
| 元ファイルの sha256 | `0e754ca33fd6628cc0e4e0a56c15d38c34d8f7a5eed4f26b37855278e2c74f38`（GitHub 記載値と一致を確認） |
| 取得日 | 2026-10-07（Windows Defender で脅威なし、中身は .ttf のみを確認） |
| ライセンス | SIL Open Font License 1.1（同じフォルダの `LICENSE`） |

## 照合用のハッシュ（sha256）

| ファイル | sha256 |
|---|---|
| 元 `SarasaTermJ-Regular.ttf`（7z 内） | `3ddde4991e9d570b586799a96355bcd5cfe9e65a4a83c66c21fe1bd187cf0ee0` |
| 元 `SarasaTermJ-Bold.ttf`（7z 内） | `20d25bbbd0005caa513017c5dbd327520795f11473b74a590d58132e4a32138a` |
| 同梱 `SarasaTermJ-Symbols-Regular.ttf` | `219f2f83aa95b16319af0342eb5daaa21edb1b471b769ac45ab39036de7a8a75` |
| 同梱 `SarasaTermJ-Symbols-Bold.ttf` | `0b2061340b98e39617bb7c43f505c1b1e60b134b2b1ed8f03d89b08a855d6fa2` |

- 同梱ファイルは `src/renderer/assets/fonts/` にある。Vite のビルドでファイル名にハッシュが付く
  （例 `SarasaTermJ-Symbols-Regular-B3rMx2K8.ttf`）が、中身は上の同梱ファイルと同じ。
- 切り出した文字数は Regular・Bold とも 796。

## 切り出し（OFL 上の「改変版」）

`SarasaTermJ-Regular.ttf` / `SarasaTermJ-Bold.ttf` から、次の範囲だけを fontTools の
`pyftsubset` で切り出した。日本語・英数字は含まない（それぞれ既存のフォントで描く）。

```
U+00A7,U+00B0-00B1,U+00B4,U+00B6,U+00D7,U+00F7,U+2010-2027,U+2030-205E,
U+2103,U+2116,U+2121,U+2122,U+2150-218F,U+2190-21FF,U+2200-22FF,
U+2460-24FF,U+25A0-25FF,U+2605-2606,U+2640,U+2642,U+2660-266F
```

実際に実行したコマンド（Git Bash、Python 3.12.10、fontTools 4.66.1）。出力名はあとで
`CockpitSymbols-*.ttf` → `SarasaTermJ-Symbols-*.ttf` に変えた（中身は同じ）。

```bash
RANGES="U+00A7,U+00B0-00B1,U+00B4,U+00B6,U+00D7,U+00F7,U+2010-2027,U+2030-205E,U+2103,U+2116,U+2121,U+2122,U+2150-218F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+25A0-25FF,U+2605-2606,U+2640,U+2642,U+2660-266F"
for w in Regular Bold; do
  pyftsubset SarasaTermJ-$w.ttf --unicodes="$RANGES" --layout-features='*' \
    --name-IDs='*' --name-languages='*' --notdef-outline \
    --output-file=CockpitSymbols-$w.ttf
done
```

- 予約フォント名は Adobe の「Source」のみ。フォント名「Sarasa Term J」には含まれないため、
  改変版でも名前を変えずに配布できる（LICENSE 3行目と OFL 第3条）。
- 著作権表示とライセンス本文は THIRD-PARTY-NOTICES.md に自動で載る
  （scripts/generate-third-party-notices.mjs が third_party/fonts/*/LICENSE を読む）。
- 範囲を変えるときは、`src/renderer/styles.css` の `unicode-range` も同じ値にそろえる。
