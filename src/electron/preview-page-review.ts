import { randomUUID, createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { session, WebContentsView } from "electron";
import { z } from "zod";

import { archiveFingerprint, historyVictims, PREVIEW_HISTORY_BYTES } from "./preview-history";

import type { BrowserWindow, Rectangle, WebContents } from "electron";
import type { PreviewCapture, PreviewVersion, PreviewVersionComparison } from "../shared/preview";

const itemSchema = z.object({ selector: z.string().max(1200), signature: z.string().max(6000), content: z.string().max(32 * 1024 * 1024) });
const itemsSchema = z.array(itemSchema).max(5000);
type PageMarks = Map<string, string>;
interface SavedPage extends PreviewVersion { targetId: string; path: string; png: string; bytes: number; fingerprint: string; marks: PageMarks; capture: Omit<PreviewCapture, "image" | "page"> }
interface PagePair { before: SavedPage; after?: SavedPage; changes?: [string[], string[]]; views?: [WebContentsView, WebContentsView]; css?: [string, string]; highlighted?: boolean }

// Only metadata is returned; page scripts and values never reach the trusted renderer.
const MARKS = `(()=>{
  if(document.documentElement.outerHTML.length>10485760)throw new Error('Page too large');
  const result=[],encoder=new TextEncoder();let metadataSize=0;
  for(const node of [...document.body.querySelectorAll('*')].slice(0,5000)){
    if(['SCRIPT','STYLE','LINK','META','NOSCRIPT','IFRAME','OBJECT','EMBED'].includes(node.tagName.toUpperCase()))continue;
    const r=node.getBoundingClientRect();if(r.width<1||r.height<1)continue;
    const s=getComputedStyle(node),raw=[...node.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('');
    const text=['pre','pre-wrap','break-spaces'].includes(s.whiteSpace)?raw:s.whiteSpace==='pre-line'?raw.replace(/[ \\t\\f]+/g,' ').replace(/^ +| +$/g,''):raw.replace(/[ \\t\\r\\n\\f]+/g,' ').replace(/^ +| +$/g,'');
    const svg=node.namespaceURI==='http://www.w3.org/2000/svg';
    const style=['color','backgroundColor','backgroundImage','fontSize','fontWeight','fontFamily','lineHeight','whiteSpace','borderColor','borderWidth','textDecorationLine','display','flexDirection','padding','margin','gap','textAlign','position','transform',...(svg?['stroke','fill','strokeWidth','strokeDasharray','strokeDashoffset','opacity']:[])].map(k=>s[k]).join('|');
    const computed=node.computedStyleMap?.();
    const layout=['width','height','min-width','min-height','max-width','max-height','top','right','bottom','left','grid-template-columns','grid-template-rows','flex-basis','object-fit','object-position'].map(k=>computed?.get(k)?.toString()??s.getPropertyValue(k)).join('|');
    if(!svg&&!text&&!['IMG','INPUT','BUTTON','TEXTAREA','SELECT'].includes(node.tagName)&&s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.backgroundImage==='none'&&s.borderWidth==='0px')continue;
    let selector='',part=node;
    for(let depth=0;part&&part!==document.body&&depth<16;depth++,part=part.parentElement){
      const tag=part.tagName.toLowerCase(),siblings=[...part.parentElement.children].filter(n=>n.tagName===part.tagName);
      selector=tag+':nth-of-type('+(siblings.indexOf(part)+1)+')'+(selector?' > '+selector:'');
    }
    if(part!==document.body)continue;
    const geometry=svg?['d','points','x','y','cx','cy','r','rx','ry','width','height','x1','x2','y1','y2','viewBox','transform'].map(k=>[k,node.getAttribute(k)]):[];
    const item={selector:'body > '+selector,signature:JSON.stringify([style,layout,node.tagName==='IMG'?node.currentSrc.slice(0,1024):'']),content:JSON.stringify([text,geometry])};
    if(item.selector.length>1200||item.signature.length>6000||item.content.length>33554432)throw new Error('Page metadata too large');
    metadataSize+=encoder.encode(item.selector+item.signature+item.content).byteLength;if(metadataSize>33554432)throw new Error('Page metadata too large');
    result.push(item);
  }return result;
})()`;

export function pageChanges(before: PageMarks, after: PageMarks): [string[], string[]] {
  // Match equal content/style occurrences across sibling insertions and reflow.
  // Selectors locate outlines in each saved page; their indices are not identities.
  const identity = (selector: string, signature: string): string => `${selector.split(" > ").at(-1)!.replace(/:nth-of-type\(\d+\)/gu, "")}\0${signature}`;
  const available = new Map<string, Array<{ selector: string; index: number }>>();
  let rightIndex = 0;
  for (const [selector, signature] of after) {
    const key = identity(selector, signature), items = available.get(key) ?? [];
    items.push({ selector, index: rightIndex++ }); available.set(key, items);
  }
  const cursors = new Map<string, number>();
  const changedBefore = new Set<string>(), changedAfter = new Set(after.keys());
  const matched: Array<{ left: string; right: string; index: number }> = [];
  for (const [selector, signature] of before) {
    const key = identity(selector, signature), cursor = cursors.get(key) ?? 0;
    const match = available.get(key)?.[cursor];
    if (!match) { changedBefore.add(selector); continue; }
    cursors.set(key, cursor + 1); changedAfter.delete(match.selector);
    matched.push({ left: selector, right: match.selector, index: match.index });
  }
  // Keep the longest ordered sequence of equal elements. Insertions/reflow do
  // not move every later sibling; an actual reorder still marks moved elements.
  const tails: number[] = [], tailMatches: number[] = [], previous: number[] = [];
  for (const [index, match] of matched.entries()) {
    let low = 0, high = tails.length;
    while (low < high) { const middle = (low + high) >>> 1; if (tails[middle] < match.index) low = middle + 1; else high = middle; }
    previous[index] = low ? tailMatches[low - 1] : -1;
    tails[low] = match.index; tailMatches[low] = index;
  }
  const stable = new Set<number>();
  for (let index = tailMatches.at(-1) ?? -1; index >= 0; index = previous[index]) stable.add(index);
  for (const [index, match] of matched.entries()) if (!stable.has(index)) { changedBefore.add(match.left); changedAfter.add(match.right); }
  return [[...before.keys()].filter((selector) => changedBefore.has(selector)).slice(0, 500), [...after.keys()].filter((selector) => changedAfter.has(selector)).slice(0, 500)];
}

/** Immutable complete-page archives; they have no terminal API, script execution or network access. */
export class PreviewPageReview {
  private readonly pairs = new Map<string, PagePair>();
  private readonly files = new Map<string, number>();
  private readonly versions = new Map<string, SavedPage[]>();
  private readonly sequences = new Map<string, number>();
  private order = 0;
  private readonly orders = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();
  private readonly allowedUrls = new Set<string>();
  private readonly isolated = session.fromPartition(`cockpit-page-review-${randomUUID()}`);
  private window?: BrowserWindow;
  private activeId?: string;
  private disposed = false;

  constructor(private readonly directory: string) {
    this.isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.isolated.setPermissionCheckHandler(() => false);
    this.isolated.on("will-download", (event) => event.preventDefault());
    this.isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !this.allowedUrls.has(details.url) && !details.url.startsWith("data:") && details.url !== "about:blank" });
    });
  }

  attach(window: BrowserWindow): void {
    this.window = window;
    window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) this.hide(); });
  }

  private save(id: string, contents: WebContents, capture: PreviewCapture): Promise<SavedPage> {
    const operation = this.saving.then(() => this.saveOne(id, contents, capture));
    this.saving = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveOne(id: string, contents: WebContents, capture: PreviewCapture): Promise<SavedPage> {
    if (this.disposed) throw new Error("Comparison closed");
    const raw: unknown = await contents.executeJavaScript(MARKS);
    const items = itemsSchema.safeParse(raw);
    if (!items.success) throw new Error("Page metadata unavailable");
    const marks = new Map(items.data.map((item) => [item.selector, createHash("sha256").update(item.signature).update("\0").update(item.content).digest("hex")]));
    const path = join(this.directory, `page-${randomUUID()}.mhtml`);
    const png = path.replace(/\.mhtml$/u, ".png");
    this.files.set(path, 0);
    try {
      await contents.savePage(path, "MHTML");
      if (this.disposed) throw new Error("Comparison closed");
      const bytes = (await stat(path)).size;
      this.files.set(path, bytes);
      if (bytes > 32 * 1024 * 1024) throw new Error("Page archive too large");
      const fingerprint = archiveFingerprint(await readFile(path), marks);
      // Equal page content can have a different pixel capture after resizing or scrolling.
      const duplicate = this.versions.get(id)?.find((version) => version.fingerprint === fingerprint
        && version.capture.viewport.width === capture.viewport.width && version.capture.viewport.height === capture.viewport.height
        && version.capture.position.x === capture.position.x && version.capture.position.y === capture.position.y
        && version.capture.width === capture.width && version.capture.height === capture.height);
      if (duplicate) { await this.removeFile(path); return duplicate; }
      const image = Buffer.from(capture.image.slice(capture.image.indexOf(",") + 1), "base64");
      this.files.set(png, image.length);
      await writeFile(png, image, { flag: "wx" });
      const sequence = (this.sequences.get(id) ?? 0) + 1;
      const metadata = { width: capture.width, height: capture.height, viewport: capture.viewport, position: capture.position, capturedAt: capture.capturedAt, pdf: capture.pdf };
      const version: SavedPage = { id: randomUUID(), targetId: id, sequence, capturedAt: capture.capturedAt, path, png, bytes: bytes + image.length, fingerprint, marks, capture: metadata };
      this.sequences.set(id, sequence);
      this.orders.set(version.id, ++this.order);
      this.versions.set(id, [...(this.versions.get(id) ?? []), version]);
      await this.prune();
      if ([...this.files.values()].reduce((sum, size) => sum + size, 0) > PREVIEW_HISTORY_BYTES) {
        await this.discard(version); throw new Error("Preview history cache is full");
      }
      this.allowedUrls.add(pathToFileURL(path).href);
      return version;
    } catch (error: unknown) { await this.removeFile(path); await this.removeFile(png); throw error; }
  }

  list(id: string): PreviewVersion[] {
    return (this.versions.get(id) ?? []).map(({ id, sequence, capturedAt }) => ({ id, sequence, capturedAt }));
  }

  private async discard(version: SavedPage): Promise<void> {
    for (const [id, pair] of this.pairs) if (pair.before === version || pair.after === version) { this.hide(id); this.closeViews(pair); this.pairs.delete(id); }
    this.versions.set(version.targetId, (this.versions.get(version.targetId) ?? []).filter((item) => item !== version));
    this.orders.delete(version.id);
    await this.removeFile(version.path); await this.removeFile(version.png);
  }

  private async prune(): Promise<void> {
    const versions = [...this.versions.values()].flat();
    const victims = new Set(historyVictims(versions.map((version) => ({ id: version.id, targetId: version.targetId, bytes: version.bytes, order: this.orders.get(version.id)! }))));
    for (const version of versions) if (victims.has(version.id)) await this.discard(version);
    const retained = new Set([...this.versions.values()].flatMap((items) => items.flatMap((version) => [version.path, version.png])));
    for (const path of this.files.keys()) if (!retained.has(path)) await this.removeFile(path);
  }

  private async readCapture(version: SavedPage, changedElements: number): Promise<PreviewCapture> {
    return { ...version.capture, image: `data:image/png;base64,${(await readFile(version.png)).toString("base64")}`, page: { changedElements, versionId: version.id } };
  }

  async compare(id: string, beforeId: string, afterId: string): Promise<PreviewVersionComparison | undefined> {
    const versions = this.versions.get(id) ?? [];
    const before = versions.find((item) => item.id === beforeId), after = versions.find((item) => item.id === afterId);
    if (!before || !after || this.disposed) return undefined;
    const old = this.pairs.get(id);
    if (old) { this.hide(id); this.closeViews(old); }
    const changes = pageChanges(before.marks, after.marks);
    const changedElements = new Set([...changes[0], ...changes[1]]).size;
    this.pairs.set(id, { before, after, changes });
    return { before: await this.readCapture(before, changedElements), after: await this.readCapture(after, changedElements), changedElements };
  }

  async baseline(id: string, contents: WebContents, capture: PreviewCapture): Promise<{ changedElements: number; versionId: string } | undefined> {
    try {
      const before = await this.save(id, contents, capture);
      const old = this.pairs.get(id);
      if (old) { this.hide(id); this.closeViews(old); }
      this.pairs.set(id, { before });
      return { changedElements: 0, versionId: before.id };
    } catch { return undefined; }
  }

  async current(id: string, contents: WebContents, capture: PreviewCapture): Promise<PreviewVersionComparison | undefined> {
    const pair = this.pairs.get(id);
    try {
      const after = await this.save(id, contents, capture);
      const versions = this.versions.get(id) ?? [];
      const before = versions.find((version) => version === pair?.before) ?? versions.filter((version) => version !== after).at(-1);
      if (!before) return undefined;
      return await this.compare(id, before.id, after.id);
    } catch { return undefined; }
  }

  async present(id: string, boxes: [Rectangle, Rectangle], highlight: boolean): Promise<boolean> {
    const pair = this.pairs.get(id);
    const window = this.window;
    if (!pair?.after || !window || this.disposed) return false;
    if (this.activeId !== id) this.hide();
    this.activeId = id;
    try {
      if (!pair.views) {
        const create = (): WebContentsView => {
          const view = new WebContentsView({ webPreferences: { session: this.isolated, javascript: false, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, navigateOnDragDrop: false } });
          view.setVisible(false); window.contentView.addChildView(view);
          view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          view.webContents.on("will-navigate", (event) => event.preventDefault());
          view.webContents.on("will-redirect", (event) => event.preventDefault());
          view.webContents.on("before-input-event", (event, input) => {
            if (input.type === "keyDown" && input.key === "Escape" && !window.isDestroyed()) {
              event.preventDefault(); window.webContents.focus();
              window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
            }
          });
          return view;
        };
        pair.views = [create(), create()];
        for (const [index, page] of [pair.before, pair.after].entries()) {
          pair.views[index].setBounds(boxes[index]);
          await pair.views[index].webContents.loadURL(pathToFileURL(page.path).href);
        }
      }
      if (this.activeId !== id || this.disposed) return false;
      const [windowWidth, windowHeight] = window.getContentSize();
      const width = Math.max(240, Math.min(...boxes.map((box) => box.width)));
      const height = Math.max(240, Math.min(...boxes.map((box) => box.height)));
      for (const [index, view] of pair.views.entries()) {
        const box = boxes[index];
        view.setBounds({ x: Math.min(box.x, windowWidth - 1), y: Math.min(box.y, windowHeight - 1), width: Math.max(1, Math.min(box.width, windowWidth - box.x)), height: Math.max(1, Math.min(box.height, windowHeight - box.y)) });
        view.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width, height }, deviceScaleFactor: 0, viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, scale: Math.min(1, box.width / width, box.height / height) });
        view.setVisible(true);
      }
      if (pair.highlighted !== highlight) {
        pair.css ??= ["", ""];
        for (const [index, view] of pair.views.entries()) {
          if (pair.css[index]) await view.webContents.removeInsertedCSS(pair.css[index]);
          const selectors = pair.changes?.[index] ?? [];
          pair.css[index] = highlight && selectors.length ? await view.webContents.insertCSS(`${selectors.join(",")}{outline:2px solid #f5a623!important;outline-offset:2px!important}`) : "";
        }
        pair.highlighted = highlight;
      }
      return true;
    } catch { this.hide(); return false; }
  }

  hide(id = this.activeId): void {
    const pair = id ? this.pairs.get(id) : undefined;
    if (pair) this.closeViews(pair);
    if (this.activeId === id) this.activeId = undefined;
  }

  private closeViews(pair: PagePair): void {
    for (const view of pair.views ?? []) {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    pair.views = undefined; pair.css = undefined; pair.highlighted = undefined;
  }

  remove(id: string): void {
    const pair = this.pairs.get(id);
    if (pair) { this.hide(id); this.closeViews(pair); }
    for (const version of this.versions.get(id) ?? []) { void this.removeFile(version.path); void this.removeFile(version.png); this.orders.delete(version.id); }
    this.versions.delete(id); this.sequences.delete(id);
    this.pairs.delete(id);
  }

  private async removeFile(path: string): Promise<void> {
    this.allowedUrls.delete(pathToFileURL(path).href);
    try { await rm(path, { force: true }); this.files.delete(path); } catch { /* Retry during disposal. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.pairs.keys()) this.remove(id);
    for (const path of this.files.keys()) void this.removeFile(path);
  }
}
