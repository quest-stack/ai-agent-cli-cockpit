export function formatTerminalFilePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

export function formatDroppedFilePaths(filePaths: readonly string[]): string {
  return filePaths
    .filter((filePath) => filePath.length > 0)
    .map(formatTerminalFilePath)
    .join(" ");
}

export function formatClipboardImagePath(filePath: string): string {
  return formatTerminalFilePath(filePath);
}
