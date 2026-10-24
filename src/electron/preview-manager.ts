import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { dialog, session, WebContentsView, webContents } from "electron";

import { localPreviewUrl, previewCaptureMetricsSchema, previewPdfMetricsSchema, previewSavedSchema, previewViewportSchema } from "../shared/preview";
import { ContextPreviewInput } from "../shared/preview-context-input";
import { cacheGrant, createGrant, createPreviewCache, escapeHtml, fileResponse, grantDocument, PREVIEW_SCHEME, previewKind, resolvePreviewAsset, resolvePreviewCandidates, signature } from "./preview-files";
import { PreviewPageReview } from "./preview-page-review";
import { releasePreviewCache } from "./preview-cache";

import type { BrowserWindow, Rectangle } from "electron";
import type { PreviewCapture, PreviewRequest, PreviewResult, PreviewSnapshot, PreviewTarget, PreviewVersionComparison, PreviewViewport } from "../shared/preview";
import type { PreviewGrant } from "./preview-files";

interface TargetRecord {
  tabId: string;
  target: PreviewTarget;
  grant?: PreviewGrant;
  view?: WebContentsView;
  pendingStamp?: string;
  loadedRevision?: number;
  loading?: boolean;
  loadPromise?: Promise<void>;
  scroll?: { x: number; y: number; time: number; zoom: boolean };
  fullscreen?: boolean;
  emulation?: string;
}

export class PreviewManager {
  private readonly records = new Map<string, TargetRecord>();
  private readonly previewSession = session.fromPartition(`cockpit-preview-${randomUUID()}`);
  // Chromium blocks PDF extension modules in an in-memory partition. Keep only
  // the built-in PDF viewer in its own persistent partition, with no preload.
  private readonly pdfSession = session.fromPartition("persist:cockpit-preview-pdf");
  private window: BrowserWindow | null = null;
  private active: { id: string; tabId: string; bounds: Rectangle; viewport?: PreviewViewport } | null = null;
  private cacheDirectory = "";
  private pageReview?: PreviewPageReview;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private disposed = false;
  private saving: Promise<void> = Promise.resolve();
  private requestedOpening: Promise<void> = Promise.resolve();
  private pendingRequests = 0;
  private readonly contextInputs = new Map<string, ContextPreviewInput>();
  private readonly generatedCaches = new Set<string>();
  private readonly retiredCaches = new Set<string>();
  private readonly cacheVersions = new Map<string, string[]>();

  constructor(private readonly dataDirectory: string, private readonly changed: (snapshot: PreviewSnapshot) => void,
    private readonly sessionDirectory: (tabId: string, sessionId: string) => string | undefined = () => undefined) {}

  forgetInput(sessionId: string): void { this.contextInputs.delete(sessionId); }

  handleInput(tabId: string, sessionId: string, data: string): void {
    if (this.disposed || !this.sessionDirectory(tabId, sessionId)) return;
    if (!this.contextInputs.has(sessionId)) {
      if (this.contextInputs.size >= 128) this.contextInputs.delete(this.contextInputs.keys().next().value!);
      this.contextInputs.set(sessionId, new ContextPreviewInput());
    }
    const paths = this.contextInputs.get(sessionId)!.push(data);
    if (!paths.length || this.pendingRequests >= 16) return;
    this.pendingRequests++;
    this.requestedOpening = this.requestedOpening.then(async () => {
      if (this.disposed) return;
      const directory = this.sessionDirectory(tabId, sessionId);
      const discovery = await resolvePreviewCandidates(directory, paths, true);
      for (const file of discovery.files) {
        if (this.disposed || this.sessionDirectory(tabId, sessionId) !== directory) return;
        const result = await this.request({ action: "add", tabId, source: file.source });
        if (result.ok && !this.disposed) this.changed({ ...result.value, requestedOpen: true });
      }
    }).catch(() => undefined).finally(() => { this.pendingRequests--; });
  }

  async initialize(): Promise<void> {
    this.cacheDirectory = await createPreviewCache();
    this.pageReview = new PreviewPageReview(this.cacheDirectory);
    const fullscreenAllowed = (wc: Electron.WebContents | null, permission: string): boolean => permission === "fullscreen"
      && this.active !== null && this.records.get(this.active.id)?.view?.webContents.id === wc?.id;
    this.previewSession.setPermissionRequestHandler((wc, permission, callback) => callback(fullscreenAllowed(wc, permission)));
    this.previewSession.setPermissionCheckHandler((wc, permission) => fullscreenAllowed(wc, permission));
    this.previewSession.on("will-download", (event) => event.preventDefault());
    this.pdfSession.setPermissionRequestHandler((wc, permission, callback) => callback(fullscreenAllowed(wc, permission)));
    this.pdfSession.setPermissionCheckHandler((wc, permission) => fullscreenAllowed(wc, permission));
    this.pdfSession.on("will-download", (event) => event.preventDefault());
    this.pdfSession.webRequest.onBeforeRequest((details, callback) => {
      let fileUrl = details.url;
      try { const url = new URL(details.url); url.hash = ""; fileUrl = url.href; } catch { /* Other URLs are denied below. */ }
      const allowed = details.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")
        || details.url.startsWith("chrome://resources/") || details.url.startsWith("chrome-untrusted://pdf-viewer/")
        || details.url.startsWith("blob:") || details.url.startsWith("data:") || details.url === "about:blank"
        || [...this.records.values()].some((record) => record.target.kind === "pdf" && record.grant?.cached && fileUrl === pathToFileURL(record.grant.cached).href);
      callback({ cancel: !allowed });
    });
    this.previewSession.protocol.handle(PREVIEW_SCHEME, (request) => this.respond(request));
    this.previewSession.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        const record = this.records.get(url.hostname);
        if (url.protocol === `${PREVIEW_SCHEME}:`) allowed = Boolean(record);
        else if (url.protocol === "file:") allowed = [...this.records.values()].some((item) => item.target.kind === "pdf" && item.grant?.cached && url.href === pathToFileURL(item.grant.cached).href);
        else if (["data:", "blob:", "about:", "chrome-extension:"].includes(url.protocol)) allowed = true;
        else {
          const owner = [...this.records.values()].find((item) => item.view?.webContents.id === details.webContentsId);
          const source = owner ? localPreviewUrl(owner.target.source) : null;
          if (source) {
            if (url.protocol === "ws:" || url.protocol === "wss:") url.protocol = url.protocol === "ws:" ? "http:" : "https:";
            allowed = localPreviewUrl(url.href) !== null && url.origin === new URL(source).origin;
          }
        }
      } catch { /* Reject malformed URLs. */ }
      callback({ cancel: !allowed });
    });
    try {
      const parsed = previewSavedSchema.safeParse(JSON.parse(await readFile(join(this.dataDirectory, "preview.json"), "utf8")));
      if (parsed.success) for (const tab of parsed.data) for (const item of tab.targets) {
        const kind = previewKind(item.source);
        if (kind && !this.records.has(item.id)) this.records.set(item.id, { tabId: tab.tabId,
          target: { ...item, name: localPreviewUrl(item.source) ? new URL(item.source).host : basename(item.source), kind, revision: 0, updated: false } });
      }
    } catch { /* First launch or invalid saved preview state. */ }
    this.pollTimer = setInterval(() => { void this.poll(); }, 750);
    this.pollTimer.unref();
  }

  attach(window: BrowserWindow): void {
    this.window = window;
    this.pageReview?.attach(window);
    window.on("resize", () => { if (this.active) this.clampBounds(); });
    window.on("closed", () => { this.dispose(); });
  }

  snapshot(tabId: string): PreviewSnapshot {
    return { tabId, targets: [...this.records.values()].filter((item) => item.tabId === tabId).map((item) => ({ ...item.target })) };
  }
  private emit(record: TargetRecord): void { if (!this.disposed) this.changed(this.snapshot(record.tabId)); }
  private save(): void {
    const tabs = new Map<string, Array<{ id: string; source: string }>>();
    for (const record of this.records.values()) {
      const items = tabs.get(record.tabId) ?? [];
      items.push({ id: record.target.id, source: record.target.source }); tabs.set(record.tabId, items);
    }
    const contents = JSON.stringify([...tabs].map(([tabId, targets]) => ({ tabId, targets })));
    this.saving = this.saving.catch(() => undefined).then(async () => {
      const temporary = join(this.dataDirectory, `preview-${randomUUID()}.tmp`);
      try { await writeFile(temporary, contents, "utf8"); await rename(temporary, join(this.dataDirectory, "preview.json")); }
      catch { await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }

  async request(request: PreviewRequest): Promise<PreviewResult> {
    try {
      if (this.disposed) return { ok: false, error: "failed" };
      if (request.action === "discover") {
        const discovery = await resolvePreviewCandidates(this.sessionDirectory(request.tabId, request.sessionId), request.paths);
        return { ok: true, value: this.snapshot(request.tabId), discovery };
      } else if (request.action === "pick") {
        if (!this.window) return { ok: false, error: "failed" };
        const result = await dialog.showOpenDialog(this.window, { properties: ["openFile"], filters: [{ name: "Preview", extensions: ["html", "htm", "md", "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "mp4"] }] });
        if (!result.canceled && result.filePaths[0]) return this.request({ action: "add", tabId: request.tabId, source: result.filePaths[0] });
      } else if (request.action === "add") {
        const url = localPreviewUrl(request.source);
        if (!url && !previewKind(request.source)) return { ok: false, error: "unsupported" };
        if (/^\w+:\/\//u.test(request.source) && !url) return { ok: false, error: "invalid" };
        const grant = url ? undefined : await createGrant(randomUUID(), request.source);
        const source = url ?? grant!.source;
        const existing = [...this.records.values()].find((item) => item.tabId === request.tabId && (process.platform === "win32" ? item.target.source.toLowerCase() === source.toLowerCase() : item.target.source === source));
        let focusId = existing?.target.id;
        if (!existing) {
          if (this.snapshot(request.tabId).targets.length >= 20 || new Set([...this.records.values()].map((item) => item.tabId)).size >= 32 && ![...this.records.values()].some((item) => item.tabId === request.tabId)) return { ok: false, error: "failed" };
          const id = grant?.id ?? randomUUID();
          focusId = id;
          const record: TargetRecord = { tabId: request.tabId, target: { id, kind: grant?.kind ?? "web", name: url ? new URL(url).host : basename(source), source, revision: 0, updated: false }, grant };
          this.records.set(id, record);
          if (grant) await this.prepare(record);
          this.save(); this.emit(record);
        }
        return { ok: true, value: { ...this.snapshot(request.tabId), focusId } };
      } else if (request.action === "hide") {
        if (this.active?.tabId === request.tabId) this.hide();
      } else if (request.action === "clear") {
        if (this.active?.tabId === request.tabId) this.hide();
        for (const [id, record] of this.records) if (record.tabId === request.tabId) {
          this.pageReview?.remove(id);
          if (record.view) { this.window?.contentView.removeChildView(record.view); record.view.webContents.close(); }
          for (const path of this.cacheVersions.get(id) ?? []) this.retiredCaches.add(path);
          this.cacheVersions.delete(id); this.records.delete(id);
        }
        this.save(); this.changed(this.snapshot(request.tabId));
      } else if (request.action !== "list") {
        const record = this.records.get(request.targetId);
        if (!record || record.tabId !== request.tabId) return { ok: false, error: "invalid" };
        if (request.action === "history") {
          return { ok: true, value: this.snapshot(request.tabId), versions: this.pageReview?.list(record.target.id) ?? [] };
        } else if (request.action === "compare-versions") {
          const comparison = await this.pageReview?.compare(record.target.id, request.beforeId, request.afterId);
          return comparison ? { ok: true, value: this.snapshot(request.tabId), comparison, versions: this.pageReview?.list(record.target.id) } : { ok: false, error: "invalid" };
        } else if (request.action === "review-pages") {
          this.hide();
          const shown = await this.pageReview?.present(record.target.id, [request.before, request.after], request.highlight);
          return shown ? { ok: true, value: this.snapshot(request.tabId) } : { ok: false, error: "failed" };
        } else if (request.action === "hide-review") {
          this.pageReview?.hide(record.target.id);
        } else if (request.action === "capture") {
          if (record.target.kind === "video" || this.active?.id !== record.target.id || !record.view || record.loading || record.target.error) return { ok: false, error: "invalid" };
          const wc = record.view.webContents;
          if (request.viewport && record.target.kind === "web") {
            const current: unknown = await wc.executeJavaScript("({width:innerWidth,height:innerHeight})");
            const actual = previewViewportSchema.safeParse(current);
            if (!this.active || this.active.id !== record.target.id) return { ok: false, error: "invalid" };
            if (!actual.success || actual.data.width !== request.viewport.width || actual.data.height !== request.viewport.height) {
              this.active.viewport = request.viewport; record.emulation = undefined; this.clampBounds();
            }
          }
          const position = request.position;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const readMetrics = async (): Promise<{ root: unknown; pdf: unknown }> => {
              const root: unknown = await wc.executeJavaScript(`new Promise(resolve=>{${position ? `scrollTo(${position.x},${position.y});` : ""}requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({viewport:{width:Math.round(innerWidth),height:Math.round(innerHeight)},position:{x:Math.max(0,Math.round(scrollX)),y:Math.max(0,Math.round(scrollY))}})))})`);
              let pdf: unknown;
              if (record.target.kind === "pdf") {
                const deadline = Date.now() + 2400;
                const findViewer = () => wc.mainFrame.framesInSubtree.find((item) => item.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"));
                let frame = findViewer();
                while (!frame && Date.now() < deadline && !wc.isDestroyed() && this.active?.id === record.target.id) {
                  await new Promise<void>((resolve) => setTimeout(resolve, 25)); frame = findViewer();
                }
                pdf = await frame?.executeJavaScript(`new Promise(resolve=>{
                  const deadline=performance.now()+${Math.max(0, deadline - Date.now())};let last='',stable=0;
                  const read=()=>{const toolbar=document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar');
                    const value={toolbarBottom:Math.max(0,toolbar?.getBoundingClientRect().bottom||0),ready:toolbar?.loadProgress>=100,page:typeof toolbar?.pageNo==='number'&&toolbar.pageNo>=1?toolbar.pageNo:undefined,zoom:typeof toolbar?.viewportZoom==='number'?toolbar.viewportZoom:undefined};
                    const key=JSON.stringify(value);stable=key===last?stable+1:0;last=key;
                    if((value.page!==undefined&&value.zoom>0&&toolbar?.loadProgress>=100&&stable>=2)||performance.now()>deadline){resolve(value);return}
                    requestAnimationFrame(read)};read()})`).catch(() => undefined);
              }
              return { root, pdf };
            };
            const raw = await Promise.race([readMetrics(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Preview capture timeout")), 3000); })]);
            const metrics = previewCaptureMetricsSchema.safeParse(raw.root);
            const pdfMetrics = previewPdfMetricsSchema.safeParse(raw.pdf);
            if (!metrics.success || this.active?.id !== record.target.id || wc.isDestroyed()) return { ok: false, error: "failed" };
            if (record.target.kind === "pdf" && (!pdfMetrics.success || !pdfMetrics.data.ready)) return { ok: false, error: "failed" };
            let image = await wc.capturePage();
            const size = image.getSize();
            if (image.isEmpty() || size.width < 1 || size.height < 1) return { ok: false, error: "failed" };
            const scale = Math.min(1, 1600 / size.width, 1600 / size.height);
            if (scale < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)), quality: "best" });
            const imageSize = image.getSize(); const encoded = image.toPNG();
            if (encoded.length > 12 * 1024 * 1024 || this.active?.id !== record.target.id) return { ok: false, error: "failed" };
            const capture: PreviewCapture = { ...metrics.data, width: imageSize.width, height: imageSize.height,
              image: `data:image/png;base64,${encoded.toString("base64")}`, capturedAt: Date.now(),
              pdf: record.target.kind === "pdf" ? { page: pdfMetrics.success ? pdfMetrics.data.page : undefined, zoom: pdfMetrics.success ? pdfMetrics.data.zoom : undefined,
                ignoredTop: pdfMetrics.success ? Math.min(imageSize.height, Math.ceil(pdfMetrics.data.toolbarBottom / metrics.data.viewport.height * imageSize.height)) : 0 } : undefined };
            let comparison: PreviewVersionComparison | undefined;
            if (["web", "markdown"].includes(record.target.kind) && request.baseline !== undefined) {
              if (request.baseline) {
                capture.page = await this.pageReview?.baseline(record.target.id, wc, capture);
              } else {
                comparison = await this.pageReview?.current(record.target.id, wc, capture);
                capture.page = comparison?.after.page;
              }
            }
            return { ok: true, value: this.snapshot(request.tabId), capture, comparison, versions: this.pageReview?.list(record.target.id) };
          } finally { if (timeout) clearTimeout(timeout); }
        } else if (request.action === "remove") {
          this.pageReview?.remove(record.target.id);
          if (this.active?.id === request.targetId) this.hide();
          if (record.view) { this.window?.contentView.removeChildView(record.view); record.view.webContents.close(); }
          this.records.delete(request.targetId); this.save(); this.emit(record);
        } else if (request.action === "refresh") {
          if (localPreviewUrl(record.target.source)) { record.target.revision++; record.target.error = undefined; }
          else await this.prepare(record);
          if (this.active?.id === record.target.id) await this.load(record);
          this.emit(record);
        } else {
          if (this.active?.id !== record.target.id) this.hide();
          this.active = { id: record.target.id, tabId: record.tabId, bounds: request.bounds, viewport: record.target.kind === "web" ? request.viewport : undefined };
          if (record.target.revision === 0 && !localPreviewUrl(record.target.source)) await this.prepare(record);
          else if (record.target.updated && !["pdf", "video"].includes(record.target.kind)) {
            await this.prepare(record);
            if (record.grant) for (const path of record.grant.dependencies.keys()) record.grant.dependencies.set(path, await signature(path));
          }
          await this.load(record);
          if (this.active?.id === record.target.id && record.view) {
            this.clampBounds(); record.view.setVisible(true); record.view.webContents.setAudioMuted(false);
          }
        }
      }
      return { ok: true, value: this.snapshot(request.tabId) };
    } catch { return { ok: false, error: "missing" }; }
  }

  private async prepare(record: TargetRecord): Promise<void> {
    try {
      if (!record.grant) record.grant = await createGrant(record.target.id, record.target.source);
      await cacheGrant(record.grant, this.cacheDirectory);
      if (record.grant.cached) {
        this.generatedCaches.add(record.grant.cached);
        const versions = this.cacheVersions.get(record.target.id) ?? [];
        versions.push(record.grant.cached);
        while (versions.length > 2) this.retiredCaches.add(versions.shift()!);
        this.cacheVersions.set(record.target.id, versions);
      }
      record.target.revision = record.grant.revision;
      record.target.updated = false; record.target.error = undefined;
    } catch { record.target.error = "missing"; }
    this.emit(record);
  }
  private clampBounds(): void {
    if (!this.active || !this.window) return;
    const record = this.records.get(this.active.id);
    if (!record?.view) return;
    const view = record.view;
    const [width, height] = this.window.getContentSize();
    if (record?.fullscreen) {
      view.setBounds({ x: 0, y: 0, width, height });
      if (record.emulation) { view.webContents.disableDeviceEmulation(); record.emulation = undefined; }
      return;
    }
    const box = this.active.bounds;
    const x = Math.max(0, Math.min(box.x, width - 1)); const y = Math.max(0, Math.min(box.y, height - 1));
    view.setBounds({ x, y, width: Math.max(1, Math.min(box.width, width - x)), height: Math.max(1, Math.min(box.height, height - y)) });
    const viewport = this.active.viewport;
    if (viewport) {
      const visible = view.getBounds();
      const scale = Math.min(1, visible.width / viewport.width, visible.height / viewport.height);
      const key = `${viewport.width}:${viewport.height}:${scale}`;
      if (record.emulation !== key) {
        view.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: viewport, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: viewport, scale });
        record.emulation = key;
      }
    } else if (record.emulation) { view.webContents.disableDeviceEmulation(); record.emulation = undefined; }
  }
  private hide(): void {
    const old = this.active ? this.records.get(this.active.id) : undefined;
    this.active = null;
    if (!old?.view || old.view.webContents.isDestroyed()) return;
    old.view.setVisible(false);
    old.view.webContents.setAudioMuted(true);
    void old.view.webContents.executeJavaScript(`(()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});document.querySelectorAll('video,audio').forEach(v=>v.pause());return {x:scrollX,y:scrollY,time:document.querySelector('video')?.currentTime||0,zoom:document.getElementById('image')?.classList.contains('zoomed')||false}})()`)
      .then((value: unknown) => { if (value && typeof value === "object" && "time" in value) old.scroll = value as TargetRecord["scroll"]; }).catch(() => undefined);
  }
  private load(record: TargetRecord): Promise<void> {
    if (record.loadPromise) return record.loadPromise;
    const operation = (async (): Promise<void> => {
      while (this.window && !this.disposed) {
        const revision = record.target.revision;
        await this.loadOne(record);
        if (record.target.revision === revision) break;
        // A refresh arriving during navigation belongs to a newer revision.
        // All joined callers must wait for that revision, including when the
        // superseded navigation failed after refresh cleared its old error.
        record.target.error = undefined;
      }
    })(); record.loadPromise = operation;
    const clear = (): void => { if (record.loadPromise === operation) record.loadPromise = undefined; };
    void operation.then(clear, clear);
    return operation;
  }

  private async loadOne(record: TargetRecord): Promise<void> {
    if (!this.window || record.loading || this.disposed) return;
    if (record.target.error && !record.grant?.cached) return;
    if (record.view && record.loadedRevision === record.target.revision) return;
    const revision = record.target.revision;
    record.loading = true;
    try {
      if (!record.view) {
        const view = new WebContentsView({ webPreferences: { session: record.target.kind === "pdf" ? this.pdfSession : this.previewSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, plugins: true, devTools: false, backgroundThrottling: true, navigateOnDragDrop: false } });
        record.view = view; view.setVisible(false);
        this.window.contentView.addChildView(view);
        view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        const navigationAllowed = (url: string): boolean => {
          try {
            const candidate = new URL(url);
            if (record.target.kind === "pdf" && url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")) return true;
            if (record.target.kind === "pdf" && record.grant?.cached) {
              candidate.hash = "";
              if (candidate.href === pathToFileURL(record.grant.cached).href) return true;
            }
            const source = localPreviewUrl(record.target.source);
            if (source) return localPreviewUrl(url) !== null && candidate.origin === new URL(source).origin;
            return candidate.protocol === `${PREVIEW_SCHEME}:` && candidate.hostname === record.target.id;
          } catch { return false; }
        };
        view.webContents.on("will-navigate", (event, url) => { if (!navigationAllowed(url)) event.preventDefault(); });
        view.webContents.on("will-frame-navigate", (event) => { if (!navigationAllowed(event.url) && !event.url.startsWith("about:")) event.preventDefault(); });
        view.webContents.on("will-redirect", (event, url) => { if (!navigationAllowed(url)) event.preventDefault(); });
        view.webContents.on("will-attach-webview", (event) => event.preventDefault());
        view.webContents.on("enter-html-full-screen", () => { record.fullscreen = true; this.clampBounds(); });
        view.webContents.on("leave-html-full-screen", () => { record.fullscreen = false; this.clampBounds(); });
        view.webContents.on("render-process-gone", () => { record.target.error = "unsupported"; this.emit(record); });
        view.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame && code !== -3) { record.target.error = "missing"; this.emit(record); }
        });
        view.webContents.on("did-finish-load", () => {
          // Navigation can reset Chromium's emulation even when its key is unchanged.
          record.emulation = undefined;
          if (this.active?.id === record.target.id) this.clampBounds();
          record.target.error = undefined; this.emit(record);
          if (record.scroll) {
            const state = record.scroll;
            void view.webContents.executeJavaScript(`(()=>{scrollTo(${Number(state.x) || 0},${Number(state.y) || 0});const v=document.querySelector('video');if(v){v.pause();const restore=()=>{v.currentTime=Math.min(${Number(state.time) || 0},v.duration||0);v.pause()};if(v.readyState>=1)restore();else v.addEventListener('loadedmetadata',restore,{once:true})}if(${Boolean(state.zoom)})document.getElementById('image')?.classList.add('zoomed')})()`).catch(() => undefined);
          }
          if (this.active?.id !== record.target.id) {
            view.setVisible(false); view.webContents.setAudioMuted(true);
            void view.webContents.executeJavaScript("document.querySelectorAll('video,audio').forEach(v=>v.pause())").catch(() => undefined);
          }
        });
      }
      if (record.view.webContents.getURL()) {
        const old = await record.view.webContents.executeJavaScript(`(()=>{const v=document.querySelector('video');if(v)v.pause();return {x:scrollX,y:scrollY,time:v?.currentTime||0,zoom:document.getElementById('image')?.classList.contains('zoomed')||false}})()`).catch(() => undefined) as TargetRecord["scroll"];
        if (old) record.scroll = old;
      }
      // Chromium's PDF extension does not reliably inject into a custom-scheme
      // document. Grant exactly this immutable PDF cache URL in the isolated session.
      const url = record.target.kind === "pdf" && record.grant?.cached ? `${pathToFileURL(record.grant.cached).href}#view=FitH&navpanes=0`
        : localPreviewUrl(record.target.source) ?? `${PREVIEW_SCHEME}://${record.target.id}/${encodeURIComponent(basename(record.target.source))}?v=${record.target.revision}`;
      const focusedBeforeLoad = webContents.getFocusedWebContents();
      await record.view.webContents.loadURL(url);
      if (record.target.kind === "image") await record.view.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const image=document.querySelector('img');if(!image){reject(new Error('Image preview unavailable'));return}
        const timer=setTimeout(()=>reject(new Error('Image decode timeout')),3000);
        image.decode().then(()=>{clearTimeout(timer);if(image.naturalWidth)resolve(true);else reject(new Error('Image preview unavailable'))},error=>{clearTimeout(timer);reject(error)})
      })`);
      if (focusedBeforeLoad && focusedBeforeLoad !== record.view.webContents && !focusedBeforeLoad.isDestroyed()
        && webContents.getFocusedWebContents() === record.view.webContents) focusedBeforeLoad.focus();
      record.loadedRevision = revision;
    } catch { record.target.error = "missing"; this.emit(record); }
    finally { record.loading = false; }
  }

  private async respond(request: globalThis.Request): Promise<globalThis.Response> {
    try {
      const url = new URL(request.url);
      const record = this.records.get(url.hostname);
      const grant = record?.grant;
      if (!grant || !grant.cached || !["GET", "HEAD"].includes(request.method)) return new globalThis.Response(null, { status: 403 });
      const mainPath = `/${encodeURIComponent(basename(grant.source))}`;
      const isMain = url.pathname === mainPath;
      if (isMain && !url.searchParams.has("asset")) {
        if (grant.kind === "pdf") return fileResponse(grant.cached, request, "application/pdf");
        if (grant.kind === "web") {
          const response = await fileResponse(grant.cached, request, "text/html; charset=utf-8");
          response.headers.set("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-src 'none'; form-action 'none'");
          return response;
        }
        return new globalThis.Response(await grantDocument(grant), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'none'; frame-src 'none'; form-action 'none'" } });
      }
      const asset = isMain ? grant.cached : await resolvePreviewAsset(grant, url.pathname);
      if (!asset) return new globalThis.Response(escapeHtml("Asset unavailable"), { status: 403 });
      if (asset !== grant.cached && grant.dependencies.size < 200) grant.dependencies.set(asset, await signature(asset));
      const response = await fileResponse(asset, request);
      if (extname(asset).toLowerCase() === ".svg") response.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      return response;
    } catch { return new globalThis.Response(null, { status: 404 }); }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      for (const record of this.records.values()) {
        if (!record.grant || record.loading) continue;
        const parts: string[] = [];
        let changed = false;
        try {
          for (const [path, previous] of record.grant.dependencies) { const current = await signature(path); parts.push(current); if (current !== previous) changed = true; }
          const fingerprint = parts.join("|");
          if (record.target.error === "missing") { record.target.error = undefined; changed = true; }
          if (changed && record.pendingStamp === fingerprint) {
            const firstUpdate = !record.target.updated;
            record.target.updated = true;
            if (this.active?.id === record.target.id && !["pdf", "video"].includes(record.target.kind)) {
              await this.prepare(record);
              for (const path of record.grant.dependencies.keys()) record.grant.dependencies.set(path, await signature(path));
              await this.load(record);
            }
            if (firstUpdate || !record.target.updated) this.emit(record);
          }
          record.pendingStamp = changed ? fingerprint : undefined;
        } catch { if (record.target.error !== "missing") { record.target.error = "missing"; this.emit(record); } }
      }
      for (const path of this.retiredCaches) {
        try { await rm(path, { force: true }); this.retiredCaches.delete(path); this.generatedCaches.delete(path); }
        catch { /* A still-streaming version will be retried on the next poll. */ }
      }
    } finally { this.polling = false; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contextInputs.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.hide();
    this.pageReview?.dispose();
    for (const record of this.records.values()) if (record.view && !record.view.webContents.isDestroyed()) record.view.webContents.close();
    // Delete only the exact temporary files this instance created; no recursive filesystem operation.
    for (const path of this.generatedCaches) void rm(path, { force: true }).catch(() => undefined);
    void releasePreviewCache(this.cacheDirectory);
  }
}
