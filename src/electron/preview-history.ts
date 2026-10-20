import { createHash } from "node:crypto";

export const PREVIEW_HISTORY_BYTES = 100 * 1024 * 1024;
export const PREVIEW_HISTORY_VERSIONS = 3;

/** Chromium regenerates MIME dates, boundaries and frame/style IDs on every save. */
export function archiveFingerprint(bytes: Buffer, marks: Map<string, string>): string {
  let document = bytes.toString("latin1").replace(/=\r?\n/gu, "");
  const boundary = /boundary="([^"\r\n]+)"/u.exec(document)?.[1];
  if (boundary) document = document.split(boundary).join("COCKPIT_MIME_BOUNDARY");
  const split = document.search(/\r?\n\r?\n/u);
  if (split >= 0) document = document.slice(0, split).replace(/^Date:.*\r?\n/gmu, "") + document.slice(split);
  const generated = new Map<string, string>();
  document = document.replace(/\b(?:frame|css)-[a-f0-9-]+@mhtml\.blink\b/giu, (value) => {
    if (!generated.has(value)) generated.set(value, `resource-${generated.size}@mhtml.blink`);
    return generated.get(value)!;
  });
  return createHash("sha256").update(document, "latin1").update(JSON.stringify([...marks])).digest("hex");
}

export interface HistoryEntry { id: string; targetId: string; bytes: number; order: number }

/** Oldest versions go first; the just-created version must fit by itself. */
export function historyVictims(entries: HistoryEntry[], maxBytes = PREVIEW_HISTORY_BYTES): string[] {
  const kept = [...entries].sort((left, right) => left.order - right.order);
  const victims: string[] = [];
  const counts = new Map<string, number>();
  for (const entry of kept) counts.set(entry.targetId, (counts.get(entry.targetId) ?? 0) + 1);
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of kept) {
    if (counts.get(entry.targetId)! <= PREVIEW_HISTORY_VERSIONS && total <= maxBytes) continue;
    victims.push(entry.id); total -= entry.bytes;
    counts.set(entry.targetId, counts.get(entry.targetId)! - 1);
  }
  return victims;
}
