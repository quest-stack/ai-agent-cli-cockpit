export const DIAGNOSTIC_LOGGING = true;

export const DIAGNOSTIC_CATEGORIES = {
  appStart: "app.start",
  processGone: "process.gone",
  ptyBootstrap: "pty.bootstrap",
  ptyExtendedKeyMode: "pty.extended-key-mode",
  ptyRedraw: "pty.redraw",
  ptyResize: "pty.resize",
  ptySpawn: "pty.spawn",
  ptyWrite: "pty.write",
  // 出るはずのない文字が CLI から届いたときの記録（原因調査用）。
  suspiciousGlyph: "pty.suspicious-glyph",
  // 受付フォルダ経由の起動は「誰かの指示でこの PC が動いた」記録なので、
  // 受理・不受理をすべて残す。
  remoteLaunch: "remote-launch",
  terminalComposition: "terminal.composition",
  terminalFit: "terminal.fit",
  terminalKeydown: "terminal.keydown",
  terminalKeydownListener: "terminal.keydown-listener",
  terminalKeyTranslation: "terminal.key-translation",
  terminalWebgl: "terminal.webgl",
  terminalWriteSession: "terminal.write-session",
  updateCheck: "update.check",
} as const;

export interface DiagnosticPayloadDescription {
  escaped: string;
  hex: string;
  utf8ByteLength: number;
}

export interface ExtendedKeyModeRequest {
  mode: string;
  protocol:
    | "kitty-keyboard-push"
    | "kitty-keyboard-set"
    | "modifyOtherKeys";
  sequence: string;
}

/* eslint-disable no-control-regex -- CSI protocols use ESC and C1 control bytes. */
const EXTENDED_KEY_MODE_SEQUENCE_PATTERN =
  /(?:\x1b\[|\u009b)(?:>4;([0-9]+)m|>([0-9]+)u|=([0-9]+)u)/gu;
/* eslint-enable no-control-regex */
const MAX_EXTENDED_KEY_MODE_SEQUENCE_LENGTH = 64;

function getTrailingExtendedKeyModePrefix(data: string): string {
  let start = Math.max(
    data.lastIndexOf("\x1b["),
    data.lastIndexOf("\u009b"),
  );
  if (data.endsWith("\x1b")) {
    start = data.length - 1;
  }
  if (start < 0) {
    return "";
  }

  const candidate = data.slice(start);
  if (
    candidate.length > MAX_EXTENDED_KEY_MODE_SEQUENCE_LENGTH ||
    candidate === ""
  ) {
    return "";
  }
  if (candidate === "\x1b") {
    return candidate;
  }

  const body = candidate.startsWith("\x1b[")
    ? candidate.slice(2)
    : candidate.slice(1);
  return body === "" || /^(?:[>=][0-9]*|>4;[0-9]*)$/u.test(body)
    ? candidate
    : "";
}

export class ExtendedKeyModeSequenceDetector {
  private carry = "";

  push(data: string): ExtendedKeyModeRequest[] {
    const combined = this.carry + data;
    const requests: ExtendedKeyModeRequest[] = [];

    for (const match of combined.matchAll(
      EXTENDED_KEY_MODE_SEQUENCE_PATTERN,
    )) {
      const mode = match[1] ?? match[2] ?? match[3];
      const sequence = match[0];
      if (mode === undefined || sequence === undefined) {
        continue;
      }

      requests.push({
        mode,
        protocol:
          match[1] !== undefined
            ? "modifyOtherKeys"
            : match[2] !== undefined
              ? "kitty-keyboard-push"
              : "kitty-keyboard-set",
        sequence,
      });
    }

    this.carry = getTrailingExtendedKeyModePrefix(combined);
    return requests;
  }
}

export function describeDiagnosticPayload(
  data: string,
): DiagnosticPayloadDescription {
  const bytes = new globalThis.TextEncoder().encode(data);
  const serialized = JSON.stringify(data);

  return {
    escaped:
      serialized === undefined ? "" : serialized.slice(1, -1),
    hex: Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(" "),
    utf8ByteLength: bytes.length,
  };
}

export function formatDiagnosticMessage(
  category: string,
  fields: Record<string, unknown>,
): string {
  return `${category} ${JSON.stringify(fields)}`;
}
