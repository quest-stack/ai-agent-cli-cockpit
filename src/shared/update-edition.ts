import type { AppLanguage } from "./i18n";
import type { UpdateManifest } from "./types";

export function getUpdateForEdition(
  manifest: UpdateManifest,
  language: AppLanguage,
  architecture: string,
): { downloadUrl: string; notes: string } {
  // Old manifests only describe Japanese downloads. Never send English users
  // to those installers when an English edition has not been published yet.
  const edition = manifest.editions?.[language] ?? (language === "ja" ? manifest : undefined);
  return {
    downloadUrl: architecture === "arm64" || architecture === "x64"
      ? edition?.urls[architecture] ?? ""
      : "",
    notes: edition?.notes ?? "A new version is available. Check GitHub Releases for the English edition.",
  };
}
