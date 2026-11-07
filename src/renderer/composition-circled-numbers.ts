/** Decorate IME display only; textContent and the native textarea stay exact. */
export function renderCompositionText(target: HTMLElement, text: string): void {
  const matches = [...text.matchAll(/[\u2460-\u2473\u24ea-\u24ff]/gu)];
  if (target.textContent === text && Boolean(target.querySelector(".cockpit-composition-circle")) === Boolean(matches.length)) return;
  if (!matches.length) { target.textContent = text; return; }
  const document = target.ownerDocument, fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of matches) {
    if (match.index > offset) fragment.append(document.createTextNode(text.slice(offset, match.index)));
    const symbol = document.createElement("span");
    symbol.className = "cockpit-composition-circle";
    symbol.textContent = match[0];
    // CSS generated content selects the large bundled glyph without inserting
    // the variation selector into composition text, copy results or PTY input.
    symbol.dataset.circledGlyph = `${match[0]}\uFE00`;
    fragment.append(symbol); offset = match.index + match[0].length;
  }
  if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
  target.replaceChildren(fragment);
}
