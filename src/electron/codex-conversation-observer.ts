import { z } from "zod";

import { providerConversationIdSchema } from "../shared/provider-conversation";

const MAX_MESSAGE = 8 * 1024 * 1024;
const requestId = z.union([z.string().max(200), z.number().finite()]);
const requestSchema = z.object({
  id: requestId,
  method: z.enum(["thread/start", "thread/resume", "thread/fork"]),
});
const responseSchema = z.object({
  id: requestId,
  result: z.object({ thread: z.object({
    id: providerConversationIdSchema,
    ephemeral: z.boolean().optional(),
    path: z.string().nullable().optional(),
  }) }),
});

/** Observe only successful replies to this TUI's own thread requests. */
export class CodexConversationObserver {
  private readonly pending = new Set<string | number>();
  readonly client = new WebSocketMessageObserver(message => {
    const result = requestSchema.safeParse(message);
    if (!result.success) return;
    if (this.pending.size >= 128) this.pending.delete(this.pending.values().next().value!);
    this.pending.add(result.data.id);
  });
  readonly server = new WebSocketMessageObserver(message => {
    const id = z.object({ id: requestId }).safeParse(message);
    if (!id.success || !this.pending.delete(id.data.id)) return;
    const result = responseSchema.safeParse(message);
    if (result.success) {
      const thread = result.data.result.thread;
      // The real TUI also forks temporary threads for its own work. They have
      // no rollout and cannot be resumed after the client closes.
      if (thread.ephemeral !== true && (thread.ephemeral === false || Boolean(thread.path))) this.onConversation(thread.id);
    }
  }, true);

  constructor(private readonly onConversation: (id: string) => void) {}
}

/**
 * Passive RFC6455 reader. The original bytes are forwarded independently.
 * Oversized/unknown messages disable observation without affecting the CLI.
 * No prompt, response text or transport capability is saved or logged.
 */
export class WebSocketMessageObserver {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentSize = 0;
  private textFragments = false;
  private skip = 0;
  private disabled = false;

  constructor(private readonly onMessage: (message: unknown) => void, private headers = false) {}

  push(chunk: Buffer): void {
    if (this.disabled) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.headers) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > 32768) this.disable();
        return;
      }
      const header = this.buffer.subarray(0, end).toString("latin1");
      if (!/^HTTP\/1\.[01] 101 /u.test(header) || /sec-websocket-extensions:/iu.test(header)) {
        this.disable(); return;
      }
      this.buffer = this.buffer.subarray(end + 4);
      this.headers = false;
    }
    while (this.buffer.length) {
      if (this.skip) {
        const count = Math.min(this.skip, this.buffer.length);
        this.skip -= count; this.buffer = this.buffer.subarray(count);
        if (this.skip) return;
      }
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], second = this.buffer[1];
      if (first & 0x70) { this.disable(); return; }
      let length = second & 127, offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) { this.disable(); return; }
        length = Number(wide); offset = 10;
      }
      const masked = Boolean(second & 128);
      const headerSize = offset + (masked ? 4 : 0);
      if (this.buffer.length < headerSize) return;
      if (length > MAX_MESSAGE) {
        this.buffer = this.buffer.subarray(headerSize); this.skip = length;
        this.fragments = []; this.fragmentSize = 0; this.textFragments = false;
        continue;
      }
      if (this.buffer.length < headerSize + length) return;
      const payload = Buffer.from(this.buffer.subarray(headerSize, headerSize + length));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= this.buffer[offset + i % 4];
      this.buffer = this.buffer.subarray(headerSize + length);
      const opcode = first & 15, final = Boolean(first & 128);
      if (opcode >= 8) continue;
      if (opcode === 1) {
        this.fragments = []; this.fragmentSize = 0; this.textFragments = true;
      } else if (opcode !== 0 || !this.textFragments) continue;
      this.fragmentSize += payload.length;
      if (this.fragmentSize > MAX_MESSAGE) {
        this.fragments = []; this.fragmentSize = 0; this.textFragments = false; continue;
      }
      this.fragments.push(payload);
      if (final) {
        let message: unknown;
        try { message = JSON.parse(Buffer.concat(this.fragments).toString("utf8")) as unknown; } catch { /* Not a JSON message. */ }
        this.fragments = []; this.fragmentSize = 0; this.textFragments = false;
        if (message !== undefined) this.onMessage(message);
      }
    }
  }

  private disable(): void {
    this.disabled = true; this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentSize = 0;
  }
}
