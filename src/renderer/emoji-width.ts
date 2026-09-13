const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/u;
const emojiVariationSelector = "\ufe0f";
const keycapCombiningMark = "\u20e3";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function isEmojiGrapheme(grapheme: string): boolean {
  if (emojiPresentationPattern.test(grapheme)) {
    return true;
  }

  if (grapheme.includes(keycapCombiningMark)) {
    return true;
  }

  return (
    grapheme.includes(emojiVariationSelector) &&
    extendedPictographicPattern.test(grapheme)
  );
}

/**
 * span 全体が絵文字だけなら、xterm が割り当てるセル数を返す。
 *
 * ASCII や罫線を同じ span ごと縮めないよう、絵文字を「含む」だけの混在文字列は
 * 対象外にする。xterm の DOM レンダラは実描画幅ごとに span を分けるため、
 * 17.85px の絵文字は 7.617px の ASCII・罫線とは別 span になる。
 */
export function getEmojiCellCount(text: string): number | null {
  // 書記素分割（Intl.Segmenter）は重い。DOM レンダラでは入力のたびに全 span へ
  // この関数が呼ばれるため、絵文字を1文字も含まない文字列は分割せずに弾く。
  //
  // ここを通らないと、日本語を連続入力しただけで毎回の変換ごとに画面中の
  // span を総なめして分割することになり、入力中のちらつきとして現れる
  // （セル幅の測定が直って本関数が実際に動き始めたことで表面化した）。
  if (
    !emojiPresentationPattern.test(text) &&
    !extendedPictographicPattern.test(text) &&
    !text.includes(keycapCombiningMark)
  ) {
    return null;
  }

  const graphemes = Array.from(
    graphemeSegmenter.segment(text),
    ({ segment }) => segment,
  );
  if (
    graphemes.length === 0 ||
    !graphemes.every((grapheme) => isEmojiGrapheme(grapheme))
  ) {
    return null;
  }

  return graphemes.length * 2;
}
