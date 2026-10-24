import type { SessionStatus } from "../shared/types";
import type { CliActivityEvent } from "./cli-activity-bridge";

export const STATUS_SETTLE_DELAY_MS = 900;
const WAITING_RELEASE_OUTPUT_LENGTH = 80;

// PTY chunks can split a control sequence anywhere. Retain its framing, never
// its payload, so title/cursor updates do not become visible work between chunks.
class TerminalOutputFilter {
  private mode: "text" | "escape" | "intermediate" | "csi" |
    "osc" | "oscEscape" | "string" | "stringEscape" = "text";

  push(data: string): string {
    let output = "";
    for (const character of data) {
      const code = character.charCodeAt(0);
      if (code === 0x18 || code === 0x1a) {
        this.mode = "text";
        continue;
      }
      if (this.mode === "text") {
        if (character === "\u001b") this.mode = "escape";
        else if (code === 0x9b) this.mode = "csi";
        else if (code === 0x9d) this.mode = "osc";
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) this.mode = "string";
        else if ((code >= 0x20 && (code < 0x7f || code > 0x9f)) || /[\r\n\t]/u.test(character)) output += character;
        continue;
      }
      if (this.mode === "escape") {
        if (character === "[") this.mode = "csi";
        else if (character === "]") this.mode = "osc";
        else if (/[PX^_]/u.test(character)) this.mode = "string";
        else if (/[ -/]/u.test(character)) this.mode = "intermediate";
        else if (character !== "\u001b") this.mode = "text";
        continue;
      }
      if (this.mode === "intermediate") {
        if (character === "\u001b") this.mode = "escape";
        else if (!/[ -/]/u.test(character)) this.mode = "text";
        continue;
      }
      if (this.mode === "csi") {
        if (character === "\u001b") this.mode = "escape";
        else if (code >= 0x40 && code <= 0x7e) this.mode = "text";
        continue;
      }
      const osc = this.mode === "osc" || this.mode === "oscEscape";
      const escaped = this.mode === "oscEscape" || this.mode === "stringEscape";
      if (code === 0x9c || (osc && character === "\u0007") || (escaped && character === "\\")) this.mode = "text";
      else if (character === "\u001b") this.mode = osc ? "oscEscape" : "stringEscape";
      else this.mode = osc ? "osc" : "string";
    }
    return output;
  }
}

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
  return new TerminalOutputFilter().push(value);
}

export function containsWaitingPrompt(value: string): boolean {
  return WAITING_PATTERNS.some((pattern) => pattern.test(value));
}

export class StatusDetector {
  private readonly outputFilter = new TerminalOutputFilter();
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
    const visibleData = this.outputFilter.push(data);
    if (!visibleData) return;
    if (!visibleData.trim()) {
      // Whitespace can separate words in a streamed approval prompt, but is not
      // new work and must not keep renewing the settle timer by itself.
      if (this.waitingLocked) this.waitingOutput = `${this.waitingOutput}${visibleData}`.slice(-8_000);
      else this.buffer = `${this.buffer}${visibleData}`.slice(-8_000);
      return;
    }

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
    } else if (event.event === "SubagentStop" || event.event === "Stop" || event.event === "StopFailure") {
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
