import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { CodexConversationObserver } from "./codex-conversation-observer";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";

export const CODEX_OBSERVER_TOKEN_ENV = "COCKPIT_CODEX_OBSERVER_TOKEN";
const MAX_PANE_CONNECTIONS = 4;

/**
 * Authenticated loopback relay to the existing Codex control socket. This owns
 * no thread and sends no RPC. The TUI retains approval, account and daemon state.
 */
export class CodexConversationProxy {
  private readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer((_request, response) => {
    response.writeHead(403, { Connection: "close" }); response.end();
  });
  private readonly clients = new Set<Duplex>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private disposed = false;
  readonly ready: Promise<string>;

  constructor(private readonly onConversation: (id: string) => void, environment: typeof process.env = process.env) {
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("upgrade", (request, socket, head) => {
      const authorization = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.token}`);
      // The real TUI briefly keeps its history-picker connection open while
      // connecting the selected thread. Both are initiated by that same TUI;
      // this relay sends no RPC and must not reject the handover as a second
      // client. Keep the authenticated pane's concurrent connections bounded.
      if (this.disposed || this.clients.size >= MAX_PANE_CONNECTIONS || request.headers.origin || request.url !== "/" ||
        authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      this.clients.add(socket);
      const observer = new CodexConversationObserver(id => {
        if (!this.disposed) this.onConversation(id);
      });
      const child = process.platform === "win32"
        ? spawn(environment.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex.cmd app-server proxy"], {
          env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        })
        : spawn("codex", ["app-server", "proxy"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      // Do not forward this pane's capability to the upstream daemon.
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() !== "authorization") {
          headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        }
      }
      child.stdin.write(`GET / HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) { observer.client.push(head); child.stdin.write(head); }
      socket.on("data", (chunk: Buffer) => observer.client.push(chunk));
      child.stdout.on("data", (chunk: Buffer) => observer.server.push(chunk));
      socket.pipe(child.stdin); child.stdout.pipe(socket); child.stderr.resume();
      const close = (): void => {
        if (!this.clients.delete(socket)) return;
        child.stdin.end(); socket.destroy();
      };
      socket.on("close", close);
      socket.on("error", close);
      child.stdin.on("error", close);
      child.on("error", close);
      child.on("exit", () => { this.children.delete(child); close(); });
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address !== "string") resolve(`ws://127.0.0.1:${address.port}`);
        else reject(new Error("Codex observation endpoint unavailable."));
      });
    });
    void this.ready.catch(() => undefined);
  }

  get environment(): Record<string, string> { return { [CODEX_OBSERVER_TOKEN_ENV]: this.token }; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const socket of this.clients) socket.destroy();
    for (const child of this.children) { child.stdin.end(); child.kill(); }
    this.clients.clear(); this.children.clear(); this.server.close();
  }
}
