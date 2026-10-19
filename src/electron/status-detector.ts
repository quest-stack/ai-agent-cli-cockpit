import type { SessionStatus } from "../shared/types";
import type { CliActivityEvent } from "./cli-activity-bridge";

export const STATUS_SETTLE_DELAY_MS = 900;
const WAITING_RELEASE_OUTPUT_LENGTH = 80;

const OSC_PATTERN = new RegExp(
  String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`,
  "gu",
);
const ANSI_PATTERN = new RegExp(
  String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])`,
  "gu",
);

const WAITING_PATTERNS = [
  /Yes,\s*don['’]t ask again/iu,
  /Waiting for (?:your )?approval/iu,
  /Do you want to (?:proceed|continue|allow)/iu,
  /Would you like to (?:proceed|continue|allow)/iu,
  /Allow (?:this|once|always)/iu,
  /Press Enter to continue/iu,
  /(?:Approve|Approval required)/iu,
  /❯\s*1\./u,
  /\[(?:y\/n|Y\/n|y\/N)\]/u,
];

export function stripTerminalSequences(value: string): string {
  return value.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

export function containsWaitingPrompt(value: string): boolean {
  return WAITING_PATTERNS.some((pattern) => pattern.test(value));
}

export class StatusDetector {
  private buffer = "";
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private status: SessionStatus = "idle";
  private terminalStatus: SessionStatus = "idle";
  private readonly activeSubagents = new Set<string>();
  private readonly knownSubagents = new Set<string>();
  private readonly activeTools = new Map<string, { sessionId: string; agentId?: string }>();
  private disposed = false;
  private waitingLocked = false;
  private waitingOutput = "";

  constructor(
    private readonly onStatus: (status: SessionStatus) => void,
    private readonly settleDelayMs = STATUS_SETTLE_DELAY_MS,
  ) {}

  handleData(data: string): void {
    if (this.disposed) return;
    const visibleData = stripTerminalSequences(data);

    if (this.waitingLocked) {
      this.waitingOutput = `${this.waitingOutput}${visibleData}`.slice(-8_000);
      const meaningfulLength = this.waitingOutput.replace(/\s/gu, "").length;
      if (
        meaningfulLength < WAITING_RELEASE_OUTPUT_LENGTH ||
        containsWaitingPrompt(this.waitingOutput)
      ) {
        return;
      }

      this.waitingLocked = false;
      this.buffer = this.waitingOutput;
      this.waitingOutput = "";
    } else {
      if (this.status === "idle" || this.status === "waiting") {
        this.buffer = "";
      }
      this.buffer = `${this.buffer}${visibleData}`.slice(-8_000);
    }

    this.setStatus("busy");

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }

    this.settleTimer = setTimeout(() => {
      const nextStatus = containsWaitingPrompt(this.buffer)
        ? "waiting"
        : "idle";
      this.setStatus(nextStatus);
      this.waitingLocked = nextStatus === "waiting";
      this.waitingOutput = "";
      this.buffer = "";
    }, this.settleDelayMs);
  }

  handleInput(data = ""): void {
    if (this.disposed) return;
    this.waitingLocked = false;
    this.waitingOutput = "";
    this.buffer = "";
    // Claude does not emit Stop on user interruption. Stop retaining tool
    // observations on an explicit interrupt and resume output-based detection.
    // This changes the indicator only; the CLI decides whether work stops.
    if (data === "\u0003" || data === "\u001b") {
      this.activeTools.clear();
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
      this.setStatus("idle");
    }
  }

  // CLI が静かでも、開始を確認した Subagent の作業は継続している。
  // 承認依頼は terminalStatus 側で優先し、CLI の操作には介入しない。
  handleSubagent(agentId: string, active: boolean): void {
    if (this.disposed) return;
    if (active) {
      this.knownSubagents.add(agentId);
      this.activeSubagents.add(agentId);
    }
    else {
      this.activeSubagents.delete(agentId);
      this.clearTools(undefined, agentId);
    }
    this.setStatus(this.terminalStatus);
  }

  clearSubagents(): void {
    this.activeSubagents.clear();
    this.knownSubagents.clear();
    if (!this.disposed) this.setStatus(this.terminalStatus);
  }

  handleActivityEvent(event: CliActivityEvent): void {
    if (this.disposed) return;
    // Codex の子スレッド内の hook は session_id が子の ID になる。
    // agent_id のない通常イベントでも、開始を確認した子だけを追跡する。
    const agentId = event.agentId ??
      (this.knownSubagents.has(event.sessionId) ? event.sessionId : undefined);
    // Track the caller's tool, including direct CLI/MCP delegation. Invocation
    // IDs, not tool names or commands, isolate parallel calls and child threads.
    if (event.event === "PreToolUse" && event.toolUseId) {
      this.activeTools.set(this.toolKey(event, agentId), {
        sessionId: event.sessionId, agentId,
      });
      this.setStatus(this.terminalStatus);
    } else if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      if (event.toolUseId) this.activeTools.delete(this.toolKey(event, agentId));
      this.setStatus(this.terminalStatus);
    } else if (event.event === "Stop" || event.event === "StopFailure") {
      this.clearTools(event.sessionId, agentId);
      this.setStatus(this.terminalStatus);
    } else if (event.event === "UserPromptSubmit") {
      // A new turn also recovers from a lost completion/denial event.
      this.clearTools(event.sessionId, agentId);
      this.setStatus(this.terminalStatus);
    }
    if (event.event === "SubagentStart" ||
      ((event.event === "UserPromptSubmit" || event.event === "PreToolUse") && agentId)) {
      if (agentId) this.handleSubagent(agentId, true);
    } else if (event.event === "SubagentStop") {
      if (agentId) this.handleSubagent(agentId, false);
    } else if (event.event === "SessionEnd" || event.event === "Interrupt" ||
      (event.event === "SessionStart" && event.source !== "compact")) {
      if (agentId) {
        if (event.event !== "SessionStart") this.handleSubagent(agentId, false);
      } else {
        this.activeTools.clear();
        this.clearSubagents();
      }
    }
  }

  handleExit(exitCode: number): void {
    this.dispose();
    this.setStatus(exitCode === 0 ? "exited" : "error");
  }

  dispose(): void {
    this.disposed = true;
    this.activeSubagents.clear();
    this.knownSubagents.clear();
    this.activeTools.clear();
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    this.waitingLocked = false;
    this.waitingOutput = "";
  }

  private setStatus(nextStatus: SessionStatus): void {
    this.terminalStatus = nextStatus;
    if (nextStatus === "idle" && (this.activeSubagents.size > 0 || this.activeTools.size > 0)) {
      nextStatus = "busy";
    }
    if (nextStatus === this.status) {
      return;
    }

    this.status = nextStatus;
    this.onStatus(nextStatus);
  }

  private toolKey(event: CliActivityEvent, agentId?: string): string {
    return `${event.sessionId}:${agentId ?? ""}:${event.toolUseId}`;
  }

  private clearTools(sessionId?: string, agentId?: string): void {
    for (const [key, tool] of this.activeTools) {
      if (agentId ? tool.agentId === agentId :
        tool.sessionId === sessionId && tool.agentId === undefined) {
        this.activeTools.delete(key);
      }
    }
  }
}
