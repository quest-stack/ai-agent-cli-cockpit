interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function isPrimaryShortcut(event: ModifierKeys, platform: string): boolean {
  return !event.altKey && (platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey);
}

/** Ctrl+Tab stays Ctrl+Tab: Command+Tab belongs to macOS. */
export function formatShortcutLabel(text: string, platform: string): string {
  return platform === "darwin"
    ? text.replace(/Ctrl(?=\s*\+\s*(?:Shift|[Vv]))/gu, "⌘")
    : text;
}

export function normalizeShellCommand(command: string, platform: string): string {
  if (platform === "darwin" && command === "powershell") return "shell";
  if (platform === "win32" && command === "shell") return "powershell";
  return command;
}
