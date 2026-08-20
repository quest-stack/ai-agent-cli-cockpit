type ParsedVersion = [major: number, minor: number, patch: number];

function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== "string") {
    return null;
  }

  const fields = value.split(".");
  if (fields.length !== 3) {
    return null;
  }

  const numbers = fields.map((field) =>
    /^\d+$/u.test(field) ? Number(field) : Number.NaN,
  );
  if (numbers.some((field) => !Number.isSafeInteger(field))) {
    return null;
  }

  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

export function isNewerVersion(latest: string, current: string): boolean {
  const latestVersion = parseVersion(latest);
  const currentVersion = parseVersion(current);
  if (!latestVersion || !currentVersion) {
    return false;
  }

  for (let index = 0; index < latestVersion.length; index += 1) {
    const latestField = latestVersion[index] ?? 0;
    const currentField = currentVersion[index] ?? 0;
    if (latestField !== currentField) {
      return latestField > currentField;
    }
  }

  return false;
}
