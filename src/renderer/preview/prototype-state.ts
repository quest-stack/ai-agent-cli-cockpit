import { z } from "zod";

// Browser-only UI trial. Never enable sample renderers inside the privileged app.
export const previewPrototypeEnabled = window.location.protocol === "http:"
  && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)
  && !window.cockpit
  && new URLSearchParams(window.location.search).get("preview") === "prototype";

export const PREVIEW_SAMPLE_IDS = ["web", "markdown", "image", "pdf", "video"] as const;
export type PreviewSampleId = (typeof PREVIEW_SAMPLE_IDS)[number];

const stateSchema = z.object({
  open: z.boolean(),
  dismissed: z.boolean().default(false),
  ratio: z.number().min(0.3).max(0.65),
  selected: z.enum(PREVIEW_SAMPLE_IDS).nullable(),
  targets: z.array(z.enum(PREVIEW_SAMPLE_IDS)).max(5),
});
export type PreviewTrialState = z.infer<typeof stateSchema>;

export function readPreviewTrialState(tabId: string): PreviewTrialState {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(
      window.localStorage.getItem(`cockpit.previewTrial.${tabId}`) ?? "null",
    ));
    if (parsed.success) {
      const targets = [...new Set(parsed.data.targets)];
      return { ...parsed.data, targets,
        selected: targets.find((id) => id === parsed.data.selected) ?? targets[0] ?? null };
    }
  } catch {
    // Storage may be unavailable or may contain an older trial format.
  }
  return { open: false, dismissed: false, ratio: 0.47, selected: null, targets: [] };
}

export function savePreviewTrialState(tabId: string, state: PreviewTrialState): void {
  try {
    window.localStorage.setItem(`cockpit.previewTrial.${tabId}`, JSON.stringify(state));
  } catch {
    // Opening the preview still works without persistent browser storage.
  }
}
