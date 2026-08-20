export interface PreventiveRedrawConditions {
  isHidden: boolean;
  lastRedrawAgoMs: number;
  minGapMs: number;
  paneCount: number;
}

export function shouldRunPreventiveRedraw({
  isHidden,
  lastRedrawAgoMs,
  minGapMs,
  paneCount,
}: PreventiveRedrawConditions): boolean {
  return (
    !isHidden && lastRedrawAgoMs >= minGapMs && paneCount > 0
  );
}
