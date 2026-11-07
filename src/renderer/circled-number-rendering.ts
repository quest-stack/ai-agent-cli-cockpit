/** 半角1セルの丸数字。既に全角2セルの㉑～㊿は対象にしない。 */
const circledNumberOnly = /^[\u2460-\u2473\u24ea-\u24ff\u2776-\u2793]+$/u;
const ownedRun = /^([\u2460-\u2473\u24ea-\u24ff]{1,8})([ \u3000]+)$/u;

/** Use only existing trailing blank cells; every number gets a full two cells. */
export function getCircledRunLayout(text: string): { columns: number; drawing: string } | null {
  const match = ownedRun.exec(text);
  if (!match) return null;
  const numbers = match[1];
  let blanks = 0;
  for (const character of match[2]) {
    if (blanks >= numbers.length) return null;
    blanks += character === "　" ? 2 : 1;
  }
  if (blanks < numbers.length) return null;
  return { columns: numbers.length + blanks,
    drawing: Array.from(numbers, number => `${number}\uFE00`).join("") + " ".repeat(blanks - numbers.length) };
}

export function isSpacedCircledNumber(text: string): boolean {
  return getCircledRunLayout(text) !== null || text.length === 2 &&
    (text.endsWith(" ") || text.endsWith("　")) && circledNumberOnly.test(text[0]);
}

export function getSpacedCircledNumberColumns(text: string): number | null {
  return getCircledRunLayout(text)?.columns ?? (isSpacedCircledNumber(text) ? (text.endsWith("　") ? 3 : 2) : null);
}

/**
 * 同じ装飾の丸数字と直後の空白を、既存のセル数のまま一緒に描く。
 * xtermのbuffer・Unicode幅・コピーする文字列は変更しない。
 * joinerの範囲はセル番号ではなくUTF-16の文字列位置。
 */
export function getCircledNumberJoinRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(/([\u2460-\u2473\u24ea-\u24ff\u2776-\u2793]+)([ \u3000]+)/gu)) {
    const numbers = match[1];
    let blanks = 0, count = 0;
    for (const character of match[2]) {
      blanks += character === "　" ? 2 : 1;
      count += 1;
      if (blanks >= numbers.length) break;
    }
    const joined = numbers + match[2].slice(0, count);
    if (isSpacedCircledNumber(joined)) ranges.push([match.index, match.index + joined.length]);
  }
  return ranges;
}

/** 空白を借りられない連続丸数字用。通常の文字を含むspanは変えない。 */
export function getCompactCircledNumberCount(text: string): number | null {
  return circledNumberOnly.test(text) ? text.length : null;
}
