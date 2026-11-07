import { getCircledRunLayout } from "./circled-number-rendering";

const ownedFont = /Cockpit (?:Mac )?Circled Numbers/u;

/** Drawing string only: buffer, selection, cursor reports and copy stay intact. */
export function circledNumberCanvasText(text: string, font: string): string {
  if (!ownedFont.test(font)) return text;
  return getCircledRunLayout(text)?.drawing ?? text;
}

let owners = 0;
let restore: (() => void) | undefined;

/**
 * Chromium Canvas splits an ASCII space out of its shaping run, unlike DOM.
 * xterm gives its atlas the joined drawing string. Select each number's wide
 * variant and consume only the borrowed blank cells, in that owned font only.
 * No hidden xterm atlas API, terminal data or other canvas text is changed.
 */
export function synchronizeCircledNumberCanvas(): () => void {
  const prototype = window.CanvasRenderingContext2D?.prototype;
  if (!prototype) return () => undefined;
  if (owners === 0) {
    const original = prototype.fillText;
    const wrapped: typeof original = function (this: typeof window.CanvasRenderingContext2D.prototype, text, x, y, maxWidth) {
      const drawing = circledNumberCanvasText(text, this.font);
      if (maxWidth === undefined) original.call(this, drawing, x, y);
      else original.call(this, drawing, x, y, maxWidth);
    };
    prototype.fillText = wrapped;
    restore = () => {
      if (prototype.fillText === wrapped) prototype.fillText = original;
    };
  }
  owners += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    owners -= 1;
    if (owners === 0) {
      restore?.();
      restore = undefined;
    }
  };
}
