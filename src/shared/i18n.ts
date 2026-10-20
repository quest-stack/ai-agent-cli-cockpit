import { englishMessages, macMessageReplacements } from "./messages.en";
import { formatShortcutLabel } from "./platform";

// Vite fixes the renderer language at build time. Electron configures its
// language once at startup from the packaged edition's metadata.
declare const __COCKPIT_LANGUAGE__: string | undefined;

export type AppLanguage = "ja" | "en";
export type MessageKey = keyof typeof englishMessages;
type MessageValues = Readonly<Record<string, string | number>>;

export function resolveAppLanguage(value: unknown): AppLanguage {
  return value === "en" ? "en" : "ja";
}

let appLanguage = resolveAppLanguage(
  typeof __COCKPIT_LANGUAGE__ === "undefined" ? "ja" : __COCKPIT_LANGUAGE__,
);
let appPlatform = "win32";

export function configureAppPlatform(platform: string): void {
  appPlatform = platform;
}

/** Startup only; there is no language-switching UI or saved language setting. */
export function configureAppLanguage(language: AppLanguage): void {
  appLanguage = language;
}

export function getAppLanguage(): AppLanguage {
  return appLanguage;
}

export function translate(
  language: AppLanguage,
  key: MessageKey,
  values: MessageValues = {},
  platform = "win32",
): string {
  const source = language === "en" ? englishMessages[key] : key;
  let message: string = source;
  if (platform === "darwin") {
    message = formatShortcutLabel(source, platform);
    for (const [from, to] of Object.entries(macMessageReplacements)) message = message.replaceAll(from, to);
  }
  return message.replace(/\{(\w+)\}/gu, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}

export function t(key: MessageKey, values?: MessageValues): string {
  return translate(appLanguage, key, values, appPlatform);
}
