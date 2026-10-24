import { z } from "zod";

export const previewId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const previewKinds = ["web", "markdown", "image", "pdf", "video"] as const;
export type PreviewKind = (typeof previewKinds)[number];
export function localPreviewUrl(input: string): string | null {
  try {
    const url = new globalThis.URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

const bounds = z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000), width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000) });
const capturePosition = z.object({ x: z.number().int().min(0).max(10000000), y: z.number().int().min(0).max(10000000) });
export const previewCaptureMetricsSchema = z.object({
  viewport: z.object({ width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000) }),
  position: capturePosition,
});
export const previewPdfMetricsSchema = z.object({
  toolbarBottom: z.number().min(0).max(20000),
  ready: z.boolean().optional(),
  page: z.number().int().min(1).max(100000).optional(),
  zoom: z.number().min(0.01).max(100).optional(),
});
export const previewViewportSchema = z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(3840) });
export type PreviewViewport = z.infer<typeof previewViewportSchema>;
export const previewViewportsSchema = z.record(previewId, previewViewportSchema).refine((value) => Object.keys(value).length <= 20);
export const previewViewportPresets = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
] as const;

// The document keeps its CSS viewport size; only its presentation is scaled.
export function previewFrame(box: z.infer<typeof bounds>, viewport?: PreviewViewport): { bounds: z.infer<typeof bounds>; scale: number } {
  if (!viewport) return { bounds: box, scale: 1 };
  const scale = Math.min(1, Math.max(1, box.width - 24) / viewport.width, Math.max(1, box.height - 24) / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * scale)); const height = Math.max(1, Math.floor(viewport.height * scale));
  return { bounds: { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width, height }, scale };
}
export const previewRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), tabId: previewId }),
  z.object({ action: z.literal("pick"), tabId: previewId }),
  z.object({ action: z.literal("add"), tabId: previewId, source: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("remove"), tabId: previewId, targetId: previewId }),
  z.object({ action: z.literal("refresh"), tabId: previewId, targetId: previewId }),
  z.object({ action: z.literal("capture"), tabId: previewId, targetId: previewId, position: capturePosition.optional(), baseline: z.boolean().optional(), viewport: previewViewportSchema.optional() }),
  z.object({ action: z.literal("review-pages"), tabId: previewId, targetId: previewId, before: bounds, after: bounds, highlight: z.boolean() }),
  z.object({ action: z.literal("hide-review"), tabId: previewId, targetId: previewId }),
  z.object({ action: z.literal("history"), tabId: previewId, targetId: previewId }),
  z.object({ action: z.literal("compare-versions"), tabId: previewId, targetId: previewId, beforeId: previewId, afterId: previewId }),
  z.object({ action: z.literal("discover"), tabId: previewId, sessionId: previewId, paths: z.array(z.string().min(1).max(2048)).min(1).max(12) }),
  z.object({ action: z.literal("present"), tabId: previewId, targetId: previewId, bounds, viewport: previewViewportSchema.optional() }),
  z.object({ action: z.literal("hide"), tabId: previewId }),
  z.object({ action: z.literal("clear"), tabId: previewId }),
]);
export type PreviewRequest = z.infer<typeof previewRequestSchema>;
export interface PreviewTarget {
  id: string;
  kind: PreviewKind;
  name: string;
  source: string;
  revision: number;
  updated: boolean;
  error?: "missing" | "loading" | "unsupported";
}
export interface PreviewSnapshot { tabId: string; targets: PreviewTarget[]; focusId?: string; requestedOpen?: boolean }
export interface PreviewCapture {
  image: string;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  position: { x: number; y: number };
  capturedAt: number;
  page?: { changedElements: number; versionId?: string };
  pdf?: { page?: number; zoom?: number; ignoredTop: number };
}
export interface PreviewFileCandidate { source: string; label: string; kind: PreviewKind }
export interface PreviewVersion { id: string; sequence: number; capturedAt: number }
export interface PreviewVersionComparison { before: PreviewCapture; after: PreviewCapture; changedElements: number }
export type PreviewResult = { ok: true; value: PreviewSnapshot; capture?: PreviewCapture; versions?: PreviewVersion[]; comparison?: PreviewVersionComparison; discovery?: { files: PreviewFileCandidate[]; unresolved: boolean } } | { ok: false; error: "invalid" | "unsupported" | "missing" | "failed" };
export interface PreviewApi {
  request: (request: PreviewRequest) => Promise<PreviewResult>;
  onChanged: (listener: (snapshot: PreviewSnapshot) => void) => () => void;
}

export const previewSavedSchema = z.array(z.object({
  tabId: previewId,
  targets: z.array(z.object({ id: previewId, source: z.string().min(1).max(2048) })).max(20),
})).max(32);
