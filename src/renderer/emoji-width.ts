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
