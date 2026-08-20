import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_LOGGING,
} from "../shared/diagnostics";

interface DiagnosticLoggerOptions {
  enabled?: boolean;
  errorOutput?: (message: string, error: unknown) => void;
  now?: () => Date;
  output?: (message: string) => void;
}

export class DiagnosticLogger {
  readonly filePath: string;

  private directoryReady: Promise<void> | undefined;
  private readonly enabled: boolean;
  private readonly errorOutput: (message: string, error: unknown) => void;
  private readonly now: () => Date;
  private readonly output: (message: string) => void;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDirectory: string,
    options: DiagnosticLoggerOptions = {},
  ) {
    this.enabled = options.enabled ?? DIAGNOSTIC_LOGGING;
    this.errorOutput = options.errorOutput ?? ((message, error) => {
      console.error(message, error);
    });
    this.filePath = join(userDataDirectory, "diagnostic.log");
    this.now = options.now ?? (() => new Date());
    this.output = options.output ?? ((message) => {
      console.log(message);
    });
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const timestamp = this.now().toISOString();
    this.output(`CLI Cockpit diagnostic log: ${this.filePath}`);
    this.enqueue(
      `${timestamp} [${DIAGNOSTIC_CATEGORIES.appStart}] ` +
        `=== APP START ${timestamp} === ` +
        `diagnosticLogPath=${JSON.stringify(this.filePath)}`,
    );
    await this.flush();
  }

  log(category: string, message: string): void {
    if (!this.enabled) {
      return;
    }

    const safeCategory = category.replace(/[^a-zA-Z0-9._:-]/gu, "_");
    const singleLineMessage = message
      .replace(/\0/gu, "\\0")
      .replace(/\r/gu, "\\r")
      .replace(/\n/gu, "\\n");
    this.enqueue(
      `${this.now().toISOString()} [${safeCategory}] ${singleLineMessage}`,
    );
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  private ensureDirectory(): Promise<void> {
    this.directoryReady ??= mkdir(this.userDataDirectory, {
      recursive: true,
    }).then(() => undefined);
    return this.directoryReady;
  }

  private enqueue(line: string): void {
    this.pendingWrite = this.pendingWrite
      .then(async () => {
        await this.ensureDirectory();
        await appendFile(this.filePath, `${line}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.errorOutput(
          `Failed to append CLI Cockpit diagnostic log: ${this.filePath}`,
          error,
        );
      });
  }
}
