import { getCliKind } from "../shared/cli-launch";

import type { IBufferCell, Terminal } from "@xterm/xterm";

const circle = /^[\u2460-\u2473\u24ea-\u24ff]$/u;
export interface InputCell { text: string; width: number }
export interface CircledInputLayout {
  end: number;
  boundaries: number[];
  cursor: number;
  symbols: number[];
  normalScale: number;
}

/** Display coordinates only. The terminal buffer and every PTY byte stay untouched. */
export function getCircledInputLayout(cells: readonly InputCell[], columns: number, cursor: number, continuation = false, displayColumns = columns): CircledInputLayout | null {
  const text = cells.map(cell => cell.text || " ").join("");
  if (!/^[›❯>] /u.test(text) && !(continuation && /^ {2}/u.test(text))) return null;
  let end = Math.min(cursor, columns);
  const symbols: number[] = [];
  for (let column = 0; column < Math.min(cells.length, columns); column++) {
    const cell = cells[column];
    if (cell.width === 0) continue;
    if (cell.text && cell.text !== " ") end = Math.max(end, column + cell.width);
    if (cell.width === 1 && circle.test(cell.text)) symbols.push(column);
  }
  if (!symbols.length) return null;
  const ordinary = end - symbols.length;
  const normalScale = end + symbols.length <= displayColumns ? 1 : (displayColumns - symbols.length * 2) / ordinary;
  // Dense all-symbol rows cannot be expanded without changing terminal rows.
  // Normal wrapped prose only needs a slight horizontal adjustment.
  if (!Number.isFinite(normalScale) || normalScale < 0.8) return null;
  const boundaries = [0];
  for (let column = 0; column < columns; column++) boundaries.push(boundaries[column] + (symbols.includes(column) ? 2 : normalScale));
  return { end, boundaries, cursor: boundaries[Math.min(cursor, columns)], symbols, normalScale };
}

export function logicalInputColumn(layout: CircledInputLayout, visual: number): number {
  const values = layout.boundaries;
  for (let column = 0; column < values.length - 1; column++) {
    if (visual < values[column + 1]) return column + Math.max(0, visual - values[column]) / (values[column + 1] - values[column]);
  }
  return values.length - 1;
}

type BrowserMouseEvent = InstanceType<typeof window.MouseEvent>;
interface MouseService {
  getCoords: (event: { clientX: number; clientY: number }, element: HTMLElement, columns: number, rows: number, selection?: boolean) => [number, number] | undefined;
  getMouseReportCoords: (event: BrowserMouseEvent, element: HTMLElement) => { col: number; row: number; x: number; y: number } | undefined;
}
interface Core {
  _mouseService?: MouseService;
  coreService?: { isCursorHidden: boolean; isCursorInitialized: boolean };
  _renderService?: { dimensions: { css: { cell: { width: number; height: number } } } };
}

function cellColor(cell: IBufferCell, foreground: boolean, terminal: Terminal): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, "0")}`;
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    const colors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
    if (value < 16) return terminal.options.theme?.[colors[value]] ?? (foreground ? "#d8dde7" : "#0b0d10");
    if (value >= 232) { const level = 8 + (value - 232) * 10; return `rgb(${level},${level},${level})`; }
    const levels = [0, 95, 135, 175, 215, 255], code = value - 16;
    return `rgb(${levels[Math.floor(code / 36)]},${levels[Math.floor(code / 6) % 6]},${levels[code % 6]})`;
  }
  return foreground ? terminal.options.theme?.foreground ?? "#d8dde7" : terminal.options.theme?.background ?? "#0b0d10";
}

/** Readable Codex composer row, with reversible visual-to-logical mouse mapping. */
export function synchronizeCircledInput(terminal: Terminal, command: () => string | undefined): { refresh: () => void; dispose: () => void } {
  const core = (terminal as unknown as { _core?: Core })._core;
  const mouse = core?._mouseService;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const helpers = terminal.element?.querySelector<HTMLElement>(".xterm-helpers");
  if (!screen || !helpers || !mouse || typeof mouse.getCoords !== "function" ||
    typeof mouse.getMouseReportCoords !== "function" || !core?._renderService) return { refresh: () => undefined, dispose: () => undefined };
  const layer = document.createElement("div");
  layer.className = "cockpit-circled-input"; layer.setAttribute("aria-hidden", "true"); layer.hidden = true;
  screen.append(layer);
  let layout: CircledInputLayout | null = null;
  const layouts = new Map<number, CircledInputLayout>();
  let row = -1, cellWidth = 0, cellHeight = 0, frame = 0, disposed = false;
  const originalTranslate = helpers.style.translate;
  const reset = (): void => { layer.hidden = true; layout = null; layouts.clear(); helpers.style.translate = originalTranslate; };
  const render = (): void => {
    frame = 0;
    if (disposed || terminal.modes.synchronizedOutputMode) return;
    const buffer = terminal.buffer.active;
    const index = buffer.baseY + buffer.cursorY;
    row = index - buffer.viewportY;
    const line = buffer.getLine(index);
    const first = buffer.getNullCell();
    if (getCliKind(command()) !== "codex" || !line || row < 0 || row >= terminal.rows ||
      !line.getCell(0, first) || first.isBgDefault()) { reset(); return; }
    const dimensions = core._renderService!.dimensions.css.cell;
    cellWidth = dimensions.width; cellHeight = dimensions.height;
    if (!cellWidth || !cellHeight) { reset(); return; }
    // DOM font fallback can paint the padded composer narrower than its grid.
    // Match that existing backdrop, rather than adding a protruding gray strip.
    const backdrop = cellColor(line.getCell(0)!, false, terminal);
    let start = index;
    for (let count = 0; count < 32; count++, start--) {
      const candidate = buffer.getLine(start), cell = candidate?.getCell(0);
      if (!candidate || !cell || cell.isBgDefault() || cellColor(cell, false, terminal) !== backdrop) { reset(); return; }
      if (/^[›❯>] /u.test(candidate.translateToString(false))) break;
      if (count === 31 || start === buffer.viewportY) { reset(); return; }
    }
    let end = index;
    for (; end < Math.min(buffer.viewportY + terminal.rows - 1, start + 31); end++) {
      const next = buffer.getLine(end + 1)?.getCell(0);
      if (!next || next.isBgDefault() || cellColor(next, false, terminal) !== backdrop) break;
    }
    layouts.clear(); layout = null;
    line.getCell(0, first);
    layer.hidden = false; layer.replaceChildren();
    layer.style.width = `${screen.getBoundingClientRect().width}px`;
    layer.style.top = `${(start - buffer.viewportY) * cellHeight}px`; layer.style.height = `${(end - start + 1) * cellHeight}px`;
    layer.style.backgroundColor = "transparent"; layer.style.lineHeight = `${cellHeight}px`;
    layer.style.fontSize = `${terminal.options.fontSize ?? 13}px`;
    layer.style.fontFamily = terminal.options.fontFamily ?? "monospace";
    const selected = terminal.getSelectionPosition();
    for (let current = start; current <= end; current++) {
      const inputLine = buffer.getLine(current)!;
      const nativeRow = terminal.element?.querySelector(".xterm-rows")?.children[current - buffer.viewportY];
      const paintedRight = nativeRow ? Math.max(...Array.from(nativeRow.children, span => span.getBoundingClientRect().right)) : 0;
      const width = paintedRight ? Math.min(screen.getBoundingClientRect().width, paintedRight - screen.getBoundingClientRect().left) : screen.getBoundingClientRect().width;
      const rowCells: InputCell[] = [];
      for (let column = 0; column < terminal.cols; column++) { const cell = inputLine.getCell(column)!; rowCells.push({ text: cell.getChars(), width: cell.getWidth() }); }
      const plan = getCircledInputLayout(rowCells, terminal.cols, current === index ? buffer.cursorX : 0, current !== start, width / cellWidth);
      if (!plan) continue;
      layouts.set(current - buffer.viewportY, plan);
      if (current === index) layout = plan;
      const inputRow = document.createElement("div"); inputRow.className = "cockpit-circled-input-row";
      inputRow.style.top = `${(current - start) * cellHeight}px`; inputRow.style.width = `${width}px`; inputRow.style.height = `${cellHeight}px`; inputRow.style.backgroundColor = backdrop;
      layer.append(inputRow);
    for (let column = 0; column < plan.end; column++) {
      const cell = inputLine.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const symbol = plan.symbols.includes(column);
      const span = document.createElement("span");
      span.className = symbol ? "cockpit-circled-input-symbol" : "cockpit-circled-input-cell";
      span.textContent = cell.isInvisible() ? " " : `${cell.getChars() || " "}${symbol ? "\uFE00" : ""}`;
      span.style.left = `${plan.boundaries[column] * cellWidth}px`;
      span.style.width = `${(symbol ? 2 : cell.getWidth()) * cellWidth}px`;
      if (symbol) span.style.fontSize = `${Math.min(cellHeight, (terminal.options.fontSize ?? 13) * 1.2)}px`;
      else if (plan.normalScale < 1) { span.style.transform = `scaleX(${plan.normalScale})`; span.style.transformOrigin = "left center"; }
      span.style.color = cellColor(cell, !cell.isInverse(), terminal);
      span.style.backgroundColor = cellColor(cell, Boolean(cell.isInverse()), terminal);
      span.style.fontWeight = cell.isBold() ? "700" : "400";
      span.style.fontStyle = cell.isItalic() ? "italic" : "normal";
      if (cell.isDim()) span.style.opacity = "0.5";
      if (selected && (current > selected.start.y || current === selected.start.y && column >= selected.start.x) &&
        (current < selected.end.y || current === selected.end.y && column < selected.end.x)) span.style.backgroundColor = terminal.options.theme?.selectionBackground ?? "#f5a62333";
      inputRow.append(span);
    }
    }
    if (!layouts.size) { reset(); return; }
    if (layout && !core.coreService?.isCursorHidden && core.coreService?.isCursorInitialized && !terminal.element?.querySelector(".composition-view.active")) {
      const cursor = document.createElement("i"); cursor.className = "cockpit-circled-input-caret";
      cursor.style.top = `${(index - start) * cellHeight}px`; cursor.style.height = `${cellHeight}px`;
      cursor.style.left = `${layout.cursor * cellWidth}px`;
      cursor.style.backgroundColor = terminal.options.theme?.cursor ?? "#f5a623";
      layer.append(cursor);
    }
    helpers.style.translate = layout ? `${(layout.cursor - buffer.cursorX) * cellWidth}px 0` : originalTranslate;
  };
  const refresh = (): void => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
  const mapEvent = <T extends { clientX: number; clientY: number }>(event: T): T | { clientX: number; clientY: number } => {
    if (layer.hidden) return event;
    const rect = screen.getBoundingClientRect();
    const eventLayout = layouts.get(Math.floor((event.clientY - rect.top) / cellHeight));
    if (!eventLayout) return event;
    const visual = (event.clientX - rect.left) / cellWidth;
    const logical = logicalInputColumn(eventLayout, visual);
    // getCoords only reads these coordinates; no synthetic keyboard/mouse event is sent.
    return { clientX: event.clientX + (logical - visual) * cellWidth, clientY: event.clientY };
  };
  const originalCoords = mouse.getCoords, originalReport = mouse.getMouseReportCoords;
  const coords: MouseService["getCoords"] = function (event, element, columns, rows, selection) {
    return originalCoords.call(mouse, mapEvent(event), element, columns, rows, selection);
  };
  const report: MouseService["getMouseReportCoords"] = function (event, element) {
    return originalReport.call(mouse, mapEvent(event) as BrowserMouseEvent, element);
  };
  mouse.getCoords = coords; mouse.getMouseReportCoords = report;
  const subscriptions = [terminal.onRender(refresh), terminal.onCursorMove(refresh), terminal.onResize(refresh), terminal.onScroll(refresh), terminal.onSelectionChange(refresh)];
  const observer = new window.MutationObserver(refresh);
  observer.observe(helpers, { subtree: true, attributes: true, attributeFilter: ["class"] });
  refresh();
  return { refresh, dispose: () => {
    disposed = true; cancelAnimationFrame(frame); subscriptions.forEach(subscription => subscription.dispose()); observer.disconnect();
    if (mouse.getCoords === coords) mouse.getCoords = originalCoords;
    if (mouse.getMouseReportCoords === report) mouse.getMouseReportCoords = originalReport;
    helpers.style.translate = originalTranslate; layer.remove();
  } };
}
