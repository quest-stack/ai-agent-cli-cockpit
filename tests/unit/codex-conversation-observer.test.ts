import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { CodexConversationObserver, WebSocketMessageObserver } from "../../src/electron/codex-conversation-observer";
import { CodexConversationProxy } from "../../src/electron/codex-conversation-proxy";

import type { Duplex } from "node:stream";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const upgrade = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
function frame(message: unknown, masked = false, opcode = 1, final = true): Buffer {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const payload = Buffer.from(text);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (final ? 128 : 0) | opcode;
  header[1] = (masked ? 128 : 0) | (payload.length < 126 ? payload.length : 126);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([5, 7, 9, 11]);
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, payload]);
}

test("observation matches a successful response to this client's request, not other thread notifications", () => {
  const found: string[] = [];
  const observer = new CodexConversationObserver(id => found.push(id));
  observer.server.push(upgrade);
  observer.server.push(frame({ method: "thread/started", params: { thread: { id: second } } }));
  observer.client.push(frame({ method: "thread/start", id: 1, params: {} }, true));
  observer.server.push(frame({ id: 1, result: { thread: { id: first, ephemeral: false } } }));
  observer.client.push(frame({ method: "thread/resume", id: 2, params: { threadId: second } }, true));
  observer.server.push(frame({ id: 2, error: { code: -1 } }));
  observer.server.push(frame({ id: 99, result: { thread: { id: second } } }));
  assert.deepEqual(found, [first]);
});

test("partial headers, masked fragmented messages and multibyte boundaries preserve observation", () => {
  const found: string[] = [];
  const observer = new CodexConversationObserver(id => found.push(id));
  for (const byte of upgrade) observer.server.push(Buffer.from([byte]));
  const request = JSON.stringify({ id: "own", method: "thread/resume", params: { threadId: second }, title: "日本語" });
  const frames = Buffer.concat([frame(request.slice(0, 35), true, 1, false), frame(request.slice(35), true, 0)]);
  for (const byte of frames) observer.client.push(Buffer.from([byte]));
  observer.server.push(frame({ id: "own", result: { thread: { id: second, ephemeral: false } } }));
  assert.deepEqual(found, [second]);
});

test("invalid JSON and unsupported compressed frames never become conversation IDs", () => {
  const received: unknown[] = [];
  const observer = new WebSocketMessageObserver(value => received.push(value));
  observer.push(frame("not JSON"));
  const compressed = frame({ id: first }); compressed[0] |= 64;
  observer.push(compressed);
  observer.push(frame({ id: second }));
  assert.deepEqual(received, []);
});

test("a real TUI's temporary fork cannot replace its persistent conversation", () => {
  const found: string[] = [];
  const observer = new CodexConversationObserver(id => found.push(id));
  observer.server.push(upgrade);
  observer.client.push(frame({ method: "thread/start", id: 1 }, true));
  observer.server.push(frame({ id: 1, result: { thread: { id: first, ephemeral: false, path: "owned-history" } } }));
  observer.client.push(frame({ method: "thread/fork", id: 2 }, true));
  observer.server.push(frame({ id: 2, result: { thread: { id: second, ephemeral: true, path: null } } }));
  assert.deepEqual(found, [first]);
});

test("unknown persistence metadata and command-shaped IDs are not recorded", () => {
  const found: string[] = [];
  const observer = new CodexConversationObserver(id => found.push(id));
  observer.server.push(upgrade);
  observer.client.push(frame({ method: "thread/start", id: 1 }, true));
  observer.server.push(frame({ id: 1, result: { thread: { id: first } } }));
  observer.client.push(frame({ method: "thread/resume", id: 2 }, true));
  observer.server.push(frame({ id: 2, result: { thread: { id: first + "; injected", ephemeral: false } } }));
  assert.deepEqual(found, []);
});

test("the loopback relay rejects requests without its pane capability", async () => {
  const proxy = new CodexConversationProxy(() => assert.fail("No unauthenticated observation allowed"));
  try {
    const endpoint = await proxy.ready;
    const response = await globalThis.fetch(endpoint.replace("ws:", "http:"));
    assert.equal(response.status, 403);
    assert.equal(new URL(endpoint).hostname, "127.0.0.1");
    assert.equal(Object.keys(proxy.environment).length, 1);
  } finally { proxy.dispose(); }
});

test("WebSocket upgrades reject missing/wrong capabilities and browser origins", async () => {
  const proxy = new CodexConversationProxy(() => assert.fail("An unauthorized client cannot observe a conversation"), { ...process.env, PATH: "", Path: "" });
  try {
    const endpoint = await proxy.ready;
    const token = Object.values(proxy.environment)[0];
    for (const extra of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${token}`, Origin: "https://untrusted.invalid" }]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const pending = request(endpoint.replace("ws:", "http:"), { headers: {
          Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.alloc(16, 7).toString("base64"), ...extra,
        } }, response => { response.resume(); resolve(response.statusCode); });
        pending.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("Unauthorized upgrade accepted")); });
        pending.on("error", reject);
        pending.setTimeout(5000, () => pending.destroy(new Error("Upgrade response timed out")));
        pending.end();
      });
      assert.equal(status, 403);
    }
  } finally { proxy.dispose(); }
});

test("the real TUI's history-to-thread handover permits overlapping authenticated connections within its pane limit", { skip: process.platform !== "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-owned-proxy-handover-"));
  const helper = join(directory, "upstream.cjs");
  writeFileSync(helper, `
    let header='';let upgraded=false;
    process.stdin.on('data',chunk=>{
      if(upgraded)return;
      header+=chunk;
      if(!header.includes('\\r\\n\\r\\n'))return;
      upgraded=true;
      const key=/Sec-WebSocket-Key: ([^\\r]+)/i.exec(header)?.[1];
      const accept=require('node:crypto').createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
    });
    process.stdin.on('end',()=>process.exit(0));
  `, "utf8");
  writeFileSync(join(directory, "codex.cmd"), `@"${process.execPath}" "${helper}" %*\r\n`, "utf8");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  environment.PATH = `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const proxy = new CodexConversationProxy(() => assert.fail("The relay must not create a conversation"), environment);
  const sockets: Duplex[] = [];
  try {
    const endpoint = (await proxy.ready).replace("ws:", "http:");
    const token = Object.values(proxy.environment)[0];
    const connect = (): Promise<number | undefined> => new Promise((resolve, reject) => {
      const pending = request(endpoint, { headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.alloc(16, 3).toString("base64"), Authorization: `Bearer ${token}`,
      } }, response => { response.resume(); resolve(response.statusCode); });
      pending.on("upgrade", (response, socket) => { sockets.push(socket); resolve(response.statusCode); });
      pending.on("error", reject);
      pending.setTimeout(5000, () => pending.destroy(new Error("Owned handover upgrade timed out")));
      pending.end();
    });
    // The picker is still connected when the actual TUI opens its thread.
    assert.equal(await connect(), 101);
    assert.equal(await connect(), 101);
    assert.equal(sockets[0].destroyed, false);
    assert.equal(await connect(), 101);
    assert.equal(await connect(), 101);
    assert.equal(await connect(), 403);
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.dispose();
  }
});
