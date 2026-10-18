import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const EVENTS = [
  "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop",
  "UserPromptSubmit", "PreToolUse", "Interrupt",
] as const;
const idSchema = z.string().min(1).max(200).regex(/^[\w-]+$/u);
export const cliActivityEventSchema = z.object({
  event: z.enum(EVENTS),
  sessionId: idSchema,
  agentId: idSchema.optional(),
  source: z.string().max(64).optional(),
});
export type CliActivityEvent = z.infer<typeof cliActivityEventSchema>;
const EVENT_FILE = /^\d{18}-[a-f0-9]{32}\.json$/u;

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

// 生の stdin に含まれるプロンプト・応答・パスを保存しない。
// 出力や終了コードで承認・続行を制御せず、失敗時も必ず静かに終了する。
export const ACTIVITY_HOOK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $event = [string]$payload.hook_event_name
  if ($event -notin @('SessionStart','SessionEnd','SubagentStart','SubagentStop','UserPromptSubmit','PreToolUse','Interrupt')) { exit 0 }
  $session = [string]$payload.session_id
  $agent = [string]$payload.agent_id
  if ($session.Length -eq 0 -or $session.Length -gt 200 -or $session -notmatch '^[a-zA-Z0-9_-]+$') { exit 0 }
  $record = @{ event = $event; sessionId = $session }
  if ($agent.Length -gt 0 -and $agent.Length -le 200 -and $agent -match '^[a-zA-Z0-9_-]+$') { $record.agentId = $agent }
  if ($event -eq 'SessionStart') { $record.source = [string]$payload.source }
  $name = [DateTime]::UtcNow.Ticks.ToString('D18') + '-' + [Guid]::NewGuid().ToString('N')
  $temporary = Join-Path $PSScriptRoot ($name + '.tmp')
  $complete = Join-Path $PSScriptRoot ($name + '.json')
  [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $complete)
} catch { }
exit 0
`;

export class CliActivityBridge {
  readonly directory: string;
  readonly command: string;
  private readonly settingsFile: string;
  private readonly ownerFile: string;
  private readonly ownerDescriptor: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    storageDirectory: string,
    sessionId: string,
    private readonly onEvent: (event: CliActivityEvent) => void,
  ) {
    // 復元したセッションでは hook 定義を一定に保ち、外部 ID をパスへ
    // 直接埋め込まない。同じ保存設定の別インスタンスは所有ロックで分離する。
    const key = createHash("sha256").update(sessionId).digest("hex");
    this.directory = join(storageDirectory, key);
    mkdirSync(this.directory, { recursive: true });
    this.ownerFile = join(this.directory, "owner.pid");
    try {
      this.ownerDescriptor = openSync(this.ownerFile, "wx");
    } catch {
      // クラッシュ時に残った、自分の短い所有記録だけを検査する。
      const stat = lstatSync(this.ownerFile);
      if (!stat.isFile() || stat.size > 32) throw new Error("Activity directory unavailable.");
      const previous = Number(readFileSync(this.ownerFile, "utf8"));
      if (Number.isInteger(previous) && previous > 0) {
        let alive = true;
        try { process.kill(previous, 0); } catch (error: unknown) {
          alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
        if (alive) throw new Error("Activity directory in use.");
      }
      unlinkSync(this.ownerFile);
      this.ownerDescriptor = openSync(this.ownerFile, "wx");
    }
    try {
      writeFileSync(this.ownerDescriptor, String(process.pid), "utf8");
      this.removeEventFiles();
      const script = join(this.directory, "activity.ps1");
      writeFileSync(script, ACTIVITY_HOOK_SCRIPT, "utf8");
      const encoded = Buffer.from(`& ${powershellLiteral(script)}`, "utf16le")
        .toString("base64");
      this.command = "powershell.exe -NoLogo -NoProfile -NonInteractive " +
        `-ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
      this.settingsFile = join(this.directory, "hooks.json");
      const hooks = Object.fromEntries(EVENTS.filter((event) => event !== "Interrupt")
        .map((event) => [event, [{ hooks: [{
          type: "command", command: this.command, timeout: 3,
        }] }]]));
      writeFileSync(this.settingsFile, JSON.stringify({ hooks }), "utf8");
      this.timer = setInterval(() => this.poll(), 200);
      this.timer.unref();
    } catch (error: unknown) {
      closeSync(this.ownerDescriptor);
      unlinkSync(this.ownerFile);
      throw error;
    }
  }

  argumentsFor(command: string): string {
    if (command === "claude") {
      return ` --settings ${powershellLiteral(this.settingsFile)}`;
    }
    if (command === "codex") {
      // セッションの CLI override に追加する。ホーム・案件の設定や既存の
      // hook を書き換えない。CLI 自身の /hooks 信頼確認は迂回しない。
      return EVENTS.map((event) => {
        // Windows PowerShell 5.1 のネイティブ引数変換で二重引用符が
        // 脱落しないよう、TOML の文字列には単一引用符を使う。
        const config = `hooks.${event}=[{hooks=[{type='command',command='${this.command}',timeout=3}]}]`;
        return ` -c ${powershellLiteral(config)}`;
      }).join("");
    }
    return "";
  }

  poll(): void {
    if (this.disposed) return;
    try {
      for (const name of readdirSync(this.directory).filter((item) =>
        EVENT_FILE.test(item)).sort().slice(0, 128)) {
        const path = join(this.directory, name);
        try {
          const stat = lstatSync(path);
          if (stat.isFile() && stat.size <= 2_048) {
            const result = cliActivityEventSchema.safeParse(
              JSON.parse(readFileSync(path, "utf8")) as unknown,
            );
            if (result.success) this.onEvent(result.data);
          }
        } catch {
          // 不完全・不正なイベントで後続の観測を止めない。
        } finally {
          try { unlinkSync(path); } catch { /* Already removed. */ }
        }
      }
    } catch {
      // 観測不能でも CLI は動かす。次回 poll で再試行する。
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.removeEventFiles();
    closeSync(this.ownerDescriptor);
    try { unlinkSync(this.ownerFile); } catch { /* Already removed. */ }
  }

  private removeEventFiles(): void {
    // 自分が生成するイベントファイルだけを片付ける。再帰削除はしない。
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (EVENT_FILE.test(name) || /^\d{18}-[a-f0-9]{32}\.tmp$/u.test(name)) {
        try { unlinkSync(join(this.directory, name)); } catch { /* Already removed. */ }
      }
    }
  }
}
