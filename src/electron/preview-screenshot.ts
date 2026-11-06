import { nativeImage } from "electron";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import type { NativeImage, WebContents } from "electron";

export const MAX_PAGE_SCREENSHOT_PIXELS = 32_000_000;
export const MAX_PAGE_PNG_BYTES = 24 * 1024 * 1024;
const metricsSchema = z.object({ cssContentSize: z.object({ width: z.number().positive(), height: z.number().positive() }) });
type CaptureError = "failed" | "too-large" | "invalid" | "busy";
type DimensionsResult = { ok: true; width: number; height: number } | { ok: false; error: CaptureError };
type CaptureResult = { ok: true; image: NativeImage } | { ok: false; error: CaptureError };

export function fullPageDimensions(raw: unknown): DimensionsResult {
  const parsed = metricsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "failed" };
  const width = Math.ceil(parsed.data.cssContentSize.width), height = Math.ceil(parsed.data.cssContentSize.height);
  if (width > 32768 || height > 32768 || width * height > MAX_PAGE_SCREENSHOT_PIXELS) return { ok: false, error: "too-large" };
  return { ok: true, width, height };
}

/** Atomic replacement can briefly be denied on Windows even after capture succeeds. */
export async function replaceScreenshotFile(temporary: string, destination: string, isCurrent: () => boolean,
  platform: typeof process.platform = process.platform): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (!isCurrent()) return false;
    try { await rename(temporary, destination); return true; }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(String(code))) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

export async function captureFullPage(wc: WebContents, isCurrent: () => boolean, restoreView: () => void): Promise<CaptureResult> {
  if (wc.isDestroyed() || !isCurrent()) return { ok: false, error: "invalid" };
  if (wc.debugger.isAttached()) return { ok: false, error: "busy" };
  let owned = false, aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detached = (): void => { owned = false; aborted = true; };
  const current = (): boolean => !aborted && !wc.isDestroyed() && isCurrent();
  try {
    wc.debugger.attach("1.3"); owned = true;
    wc.debugger.on("detach", detached);
    const take = async (): Promise<CaptureResult> => {
      const raw: unknown = await wc.debugger.sendCommand("Page.getLayoutMetrics");
      if (!current()) return { ok: false, error: "invalid" };
      const size = fullPageDimensions(raw);
      if (!size.ok) return size;
      // Read native DPR in a separate world, unaffected by page-defined globals.
      const viewport: unknown = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "({width:innerWidth,height:innerHeight,ratio:devicePixelRatio})" }]);
      const parsedViewport = z.object({ width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000), ratio: z.number().min(0.1).max(16) }).safeParse(viewport);
      if (!parsedViewport.success || !current()) return { ok: false, error: "failed" };
      // CaptureScreenshot consults CDP's emulation state rather than Electron's.
      // Mirror the existing CSS viewport so scaled previews are not reflowed at
      // the much smaller native view width while the screenshot is rendered.
      await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: parsedViewport.data.width, height: parsedViewport.data.height,
        deviceScaleFactor: parsedViewport.data.ratio, mobile: false, dontSetVisibleSize: true,
      });
      if (!current()) return { ok: false, error: "invalid" };
      let response: unknown;
      try {
        response = await wc.debugger.sendCommand("Page.captureScreenshot", {
          format: "png", fromSurface: true, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 / Math.max(1, parsedViewport.data.ratio) },
        });
      } finally {
        // Chromium restores its CDP emulation state after capture, which may
        // differ from Electron's responsive-view settings. Reapply those even
        // if a timed-out capture completes later.
        restoreView();
      }
      if (!current()) return { ok: false, error: "invalid" };
      await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))" }]);
      if (!current()) return { ok: false, error: "invalid" };
      const encoded = z.object({ data: z.string().min(1) }).safeParse(response);
      if (!encoded.success) return { ok: false, error: "failed" };
      if (encoded.data.data.length > Math.ceil(MAX_PAGE_PNG_BYTES / 3) * 4) return { ok: false, error: "too-large" };
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded.data.data)) return { ok: false, error: "failed" };
      const bytes = Buffer.from(encoded.data.data, "base64");
      if (bytes.length > MAX_PAGE_PNG_BYTES) return { ok: false, error: "too-large" };
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ok: false, error: "failed" };
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 32768 || height > 32768 || width * height > MAX_PAGE_SCREENSHOT_PIXELS) return { ok: false, error: "too-large" };
      const after: unknown = await wc.debugger.sendCommand("Page.getLayoutMetrics");
      const latest = fullPageDimensions(after);
      if (!current() || !latest.ok || latest.width !== size.width || latest.height !== size.height) return { ok: false, error: "invalid" };
      const image = nativeImage.createFromBuffer(bytes);
      return image.isEmpty() ? { ok: false, error: "failed" } : { ok: true, image };
    };
    return await Promise.race([take(), new Promise<CaptureResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: current() ? "failed" : "invalid" }), 5000);
    })]);
  } catch { return { ok: false, error: "failed" }; }
  finally {
    aborted = true;
    if (timer) clearTimeout(timer);
    if (owned && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try { wc.debugger.detach(); } catch { /* The view may have closed. */ }
    }
    wc.debugger.removeListener("detach", detached);
    restoreView();
  }
}
