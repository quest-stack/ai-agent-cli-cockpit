import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";

const circledNumber = /^[\u2460-\u2473\u24ea-\u24ff]$/u;
const containsCircledNumber = /[\u2460-\u2473\u24ea-\u24ff]/u;

interface JoinerService {
  getJoinedCharacters(row: number): [number, number][];
}

function hasVisibleDecoration(cell: IBufferCell): boolean {
  return Boolean(cell.isUnderline() || cell.isOverline() || cell.isStrikethrough() ||
    cell.isInvisible() || cell.isInverse());
}

function sameNumberStyle(first: IBufferCell, next: IBufferCell): boolean {
  return first.getBgColorMode() === next.getBgColorMode() && first.getBgColor() === next.getBgColor() &&
    first.getFgColorMode() === next.getFgColorMode() && first.getFgColor() === next.getFgColor() &&
    first.isBold() === next.isBold() && first.isDim() === next.isDim() &&
    first.isItalic() === next.isItalic() && first.isBlink() === next.isBlink();
}

/** A foreground/bold change on a blank has no ink; background/decorations do. */
export function getStyledCircledNumberRanges(
  line: IBufferLine,
  columns: number,
  first: IBufferCell,
  next: IBufferCell,
): [number, number][] {
  if (!containsCircledNumber.test(line.translateToString(true))) return [];
  const ranges: [number, number][] = [];
  for (let x = 0; x < Math.min(columns - 1, line.length - 1); x += 1) {
    if (!line.getCell(x, first) || first.getWidth() !== 1 ||
      !circledNumber.test(first.getChars()) || hasVisibleDecoration(first)) continue;
    if (x > 0 && line.getCell(x - 1, next) && circledNumber.test(next.getChars())) continue;
    let end = x + 1, count = 1, compatible = true;
    while (end < columns && line.getCell(end, next) && circledNumber.test(next.getChars()) && next.getWidth() === 1) {
      compatible &&= !hasVisibleDecoration(next) && sameNumberStyle(first, next);
      count += 1; end += 1;
    }
    if (!compatible || count > 8) continue;
    let blanks = 0;
    while (end < columns && blanks < count && line.getCell(end, next) && !hasVisibleDecoration(next) &&
      first.getBgColorMode() === next.getBgColorMode() && first.getBgColor() === next.getBgColor()) {
      const text = next.getChars(), width = next.getWidth();
      if (!((text === " " && width === 1) || (text === "　" && width === 2)) || end + width > columns) break;
      blanks += width; end += width;
    }
    if (blanks >= count) ranges.push([x, end]);
  }
  return ranges;
}

/**
 * xterm 6.0.0 splits character joiners at every SGR attribute boundary.
 * Its DOM/WebGL renderers already handle selection/cursor boundaries safely.
 * Extend only the shared range service for a circle plus a real blank with the
 * same background. No buffer cells, Unicode widths or PTY data are changed.
 * The internal dependency is isolated and guarded, like the IME adapters.
 */
export function joinStyledCircledNumbers(terminal: Terminal): () => void {
  const service = (terminal as unknown as {
    _core?: { _characterJoinerService?: JoinerService };
  })._core?._characterJoinerService;
  if (!service || typeof service.getJoinedCharacters !== "function") return () => undefined;
  const original = service.getJoinedCharacters;
  const first = terminal.buffer.active.getNullCell();
  const next = terminal.buffer.active.getNullCell();
  const wrapped = function (this: JoinerService, row: number): [number, number][] {
    let ranges = original.call(this, row);
    const line = terminal.buffer.active.getLine(row);
    if (!line) return ranges;
    // Native SGR chunks can start at the final number of a differently styled
    // run. Avoid enlarging only that suffix and losing consistent sizing.
    ranges = ranges.filter(([start]) => !(start > 0 && line.getCell(start, first) &&
      circledNumber.test(first.getChars()) && line.getCell(start - 1, next) && circledNumber.test(next.getChars())));
    const additional = getStyledCircledNumberRanges(line, terminal.cols, first, next);
    for (const range of additional) {
      if (!ranges.some(([start, end]) => range[0] < end && start < range[1])) ranges.push(range);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
  };
  service.getJoinedCharacters = wrapped;
  return () => {
    if (service.getJoinedCharacters === wrapped) service.getJoinedCharacters = original;
  };
}
