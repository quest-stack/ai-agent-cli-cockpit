import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { t } from "../shared/i18n";
import { createCliLaunchCommand, getCliInvocation } from "../shared/cli-launch";
import { CODEX_OBSERVER_TOKEN_ENV } from "./codex-conversation-proxy";

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

export function createBootstrapCommand(
  command: string, sharedCodex = false, platform = process.platform, activityArguments = "", codexEndpoint?: string,
): string {
  if (codexEndpoint && !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(codexEndpoint)) {
    throw new Error("Invalid local Codex observation endpoint.");
  }
  const invocation = getCliInvocation(command);
  const cli = invocation?.cli;
  const launch = invocation?.conversationId ? `${createCliLaunchCommand(invocation.cli, "resume")} ${invocation.conversationId}`
    : invocation ? createCliLaunchCommand(invocation.cli, invocation.mode) : command;
  const codexResume = cli === "codex" && invocation?.mode !== "new";
  const sharedResumeArguments = invocation?.conversationId ? ` resume ${invocation.conversationId}`
    : codexResume ? invocation?.mode === "continue" ? " resume --last" : " resume" : "";
  const remote = codexEndpoint
    ? `--remote ${codexEndpoint} --remote-auth-token-env ${CODEX_OBSERVER_TOKEN_ENV}`
    : "--remote unix://";
  if (platform !== "win32") {
    if (cli === "shell" || cli === "powershell") return "\r";
    if (cli === "codex" && sharedCodex) {
      return 'if codex app-server daemon start >/dev/null; then '
        + `codex ${remote} --cd "$PWD" -c tui.whimsy=false${sharedResumeArguments}; `
        + "else printf '%s\\n' 'Codex shared server failed to start. Run: codex app-server daemon start' >&2; fi\r";
    }
    return `${launch}${codexResume ? ' --cd "$PWD"' : ""}${cli === "codex" ? " -c tui.whimsy=false" : ""}\r`;
  }
  const encodingSetup = [
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding=[Console]::OutputEncoding",
    "chcp.com 65001 | Out-Null",
    "Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force",
  ].join("; ");

  if (cli === "powershell" || cli === "shell") return `${encodingSetup}\r`;

  if (cli === "codex" && sharedCodex) {
    const failure = t("Codexの共有サーバーを起動できませんでした。codex app-server daemon start でエラーを確認してください。")
      .replaceAll("'", "''");
    // Explicit --cd avoids adopting the daemon's own workdir. Keep a failed
    // shared startup visible instead of silently creating an independent writer.
    return `${encodingSetup}; codex.cmd app-server daemon start | Out-Null; `
      + `if ($LASTEXITCODE -eq 0) { codex.cmd ${remote} --cd (Get-Location).Path -c tui.whimsy=false${sharedResumeArguments} } `
      + `else { Write-Error '${failure}' }\r`;
  }

  // Disable only Codex's idle decoration; preserve its progress animations.
  const argumentsText = cli === "codex" ? " -c tui.whimsy=false" : "";
  return `${encodingSetup}; ${launch}${codexResume ? " --cd (Get-Location).Path" : ""}${argumentsText}${activityArguments}\r`;
}
