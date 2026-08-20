interface CloseSessionAfterHidingOptions {
  killSession: (sessionId: string) => Promise<void>;
  onClosingChange: (sessionId: string, closing: boolean) => void;
  onRemove: (sessionId: string) => void;
  sessionId: string;
}

export async function closeSessionAfterHiding({
  killSession,
  onClosingChange,
  onRemove,
  sessionId,
}: CloseSessionAfterHidingOptions): Promise<void> {
  onClosingChange(sessionId, true);
  try {
    await killSession(sessionId);
    onRemove(sessionId);
  } finally {
    onClosingChange(sessionId, false);
  }
}
