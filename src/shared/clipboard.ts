export function formatTerminalFilePath(filePath: string, platform = "win32"): string {
  if (platform !== "win32") {
    // File paths are data, including spaces, quotes, $, backticks and newlines.
    // Single quoting prevents POSIX-shell expansion when users paste a path.
    return `'${filePath.replaceAll("'", "'\\''")}'`;
  }
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

export function formatDroppedFilePaths(filePaths: readonly string[], platform = "win32"): string {
  return filePaths
    .filter((filePath) => filePath.length > 0)
    .map((filePath) => formatTerminalFilePath(filePath, platform))
    .join(" ");
}

export function formatClipboardImagePath(filePath: string, platform = "win32"): string {
  return formatTerminalFilePath(filePath, platform);
}
