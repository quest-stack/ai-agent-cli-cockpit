import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, posix } from "node:path";

export function getShellLaunch(
  platform = process.platform,
  environment = process.env,
  userHome = homedir(),
  loginShell = userInfo().shell,
): { file: string; args: string[]; path: string } {
  if (platform === "win32") {
    const systemPowerShell = join(environment.SystemRoot ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      file: existsSync(systemPowerShell) ? systemPowerShell : "powershell.exe",
      args: ["-NoLogo", "-NoExit"],
      path: environment.PATH ?? "",
    };
  }
  // Bootstrap commands use POSIX syntax. Other login shells (e.g. fish) use
  // zsh here, rather than receiving incompatible commands. No rc files change.
  const preferred = loginShell || environment.SHELL || "/bin/zsh";
  const file = ["/bin/zsh", "/bin/bash"].includes(preferred) ? preferred : "/bin/zsh";
  return {
    file,
    args: ["-il"],
    path: [...new Set([
      posix.join(userHome, ".local", "bin"),
      posix.join(userHome, ".npm-global", "bin"),
      "/opt/homebrew/bin", "/usr/local/bin",
      ...(environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":"),
    ].filter(Boolean))].join(":"),
  };
}
