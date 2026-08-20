import type { SessionStatus } from "../shared/types";

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
  private waitingLocked = false;
  private waitingOutput = "";

  constructor(
    private readonly onStatus: (status: SessionStatus) => void,
    private readonly settleDelayMs = STATUS_SETTLE_DELAY_MS,
  ) {}

  handleData(data: string): void {
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

  handleInput(): void {
    this.waitingLocked = false;
    this.waitingOutput = "";
    this.buffer = "";
  }

  handleExit(exitCode: number): void {
    this.dispose();
    this.setStatus(exitCode === 0 ? "exited" : "error");
  }

  dispose(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    this.waitingLocked = false;
    this.waitingOutput = "";
  }

  private setStatus(nextStatus: SessionStatus): void {
    if (nextStatus === this.status) {
      return;
    }

    this.status = nextStatus;
    this.onStatus(nextStatus);
  }
}
