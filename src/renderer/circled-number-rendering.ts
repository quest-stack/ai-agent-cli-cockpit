/** 半角1セルの丸数字。既に全角2セルの㉑～㊿は対象にしない。 */
const circledNumberOnly = /^[\u2460-\u2473\u24ea-\u24ff\u2776-\u2793]+$/u;

export function isSpacedCircledNumber(text: string): boolean {
  return text.length === 2 && text.endsWith(" ") && circledNumberOnly.test(text[0]);
}

/**
 * 丸数字と直後のASCII空白を、既存の2セルのまま一緒に描く。
 * xtermのbuffer・Unicode幅・コピーする文字列は変更しない。
 * joinerの範囲はセル番号ではなくUTF-16の文字列位置。
 */
export function getCircledNumberJoinRanges(text: string): [number, number][] {
  return Array.from(
    text.matchAll(/[\u2460-\u2473\u24ea-\u24ff\u2776-\u2793] /gu),
    (match) => [match.index, match.index + 2],
  );
}

/** 空白を借りられない連続丸数字用。通常の文字を含むspanは変えない。 */
export function getCompactCircledNumberCount(text: string): number | null {
  return circledNumberOnly.test(text) ? text.length : null;
}
