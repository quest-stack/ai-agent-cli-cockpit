import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { t } from "../shared/i18n";

const managedServerSettingsSchema = z.object({
  remoteControlEnabled: z.boolean(),
});

/** Read the CLI's existing opt-in without changing its settings or credentials. */
export function isCodexRemoteControlEnabled(userHome = homedir()): boolean {
  try {
    const settings: unknown = JSON.parse(readFileSync(
      join(userHome, ".codex", "app-server-daemon", "settings.json"),
      "utf8",
    ));
    const result = managedServerSettingsSchema.safeParse(settings);
    return result.success && result.data.remoteControlEnabled;
  } catch {
    return false;
  }
}

export function createBootstrapCommand(command: string, sharedCodex = false): string {
  const encodingSetup = [
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding=[Console]::OutputEncoding",
    "chcp.com 65001 | Out-Null",
    "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force",
  ].join("; ");

  if (command === "powershell") return `${encodingSetup}\r`;

  if (command === "codex" && sharedCodex) {
    const failure = t("Codexの共有サーバーを起動できませんでした。codex app-server daemon start でエラーを確認してください。")
      .replaceAll("'", "''");
    // Explicit --cd avoids adopting the daemon's own workdir. Keep a failed
    // shared startup visible instead of silently creating an independent writer.
    return `${encodingSetup}; codex.cmd app-server daemon start | Out-Null; `
      + "if ($LASTEXITCODE -eq 0) { codex.cmd --remote unix:// --cd (Get-Location).Path -c tui.whimsy=false } "
      + `else { Write-Error '${failure}' }\r`;
  }

  // Disable only Codex's idle decoration; preserve its progress animations.
  const argumentsText = command === "codex" ? " -c tui.whimsy=false" : "";
  return `${encodingSetup}; ${command}${argumentsText}\r`;
}
