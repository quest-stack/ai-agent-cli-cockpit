import { createReadStream } from "node:fs";
import { copyFile, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { localPreviewUrl } from "../shared/preview";
import { createManagedPreviewCache } from "./preview-cache";
import type { PreviewFileCandidate, PreviewKind } from "../shared/preview";

export const PREVIEW_SCHEME = "cockpit-preview";
export const MAX_PREVIEW_FILE = 512 * 1024 * 1024;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".pdf": "application/pdf", ".mp4": "video/mp4",
};
export function previewKind(source: string): PreviewKind | null {
  if (localPreviewUrl(source)) return "web";
  const extension = extname(source).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "web";
  if (extension === ".md") return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  return extension === ".mp4" ? "video" : null;
}
export function localFilePath(source: string): boolean {
  return isAbsolute(source) && !/^(?:\\\\|\/\/)/u.test(source) && !source.includes("\0");
}
export async function resolvePreviewCandidates(directory: string | undefined, paths: string[]): Promise<{ files: PreviewFileCandidate[]; unresolved: boolean }> {
  const files: PreviewFileCandidate[] = []; let unresolved = false;
  let root: string | undefined;
  try { if (directory && localFilePath(directory)) root = await realpath(directory); } catch { /* No fallback to Cockpit's own working directory. */ }
  for (const label of paths.slice(0, 12)) {
    const kind = previewKind(label);
    if (!kind || localPreviewUrl(label)) continue;
    if (!root) { unresolved = true; continue; }
    try {
      const candidate = isAbsolute(label) ? label : resolve(root, label);
      if (!localFilePath(candidate) || label.split(/[\\/]/u).some((part) => part.startsWith(".") && part !== "." && part !== "..")) { unresolved = true; continue; }
      const source = await realpath(candidate); const inside = relative(root, source);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || previewKind(source) !== kind
        || inside.split(sep).some((part) => part.startsWith(".")) || !(await stat(source)).isFile()) { unresolved = true; continue; }
      if (!files.some((file) => file.source === source)) files.push({ source, label, kind });
    } catch { unresolved = true; }
  }
  return { files, unresolved };
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function inlineMarkdown(input: string): string {
  // Escape raw HTML first; links and images accept only relative asset URLs.
  return escapeHtml(input).replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/gu, (_match, alt: string, url: string) => {
      if (/^[\w./%-]+$/u.test(url) && !url.startsWith("/") && !url.includes("..")) return `<img alt="${alt}" src="${url}">`;
      return alt;
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/gu, (_match, label: string, url: string) => {
      if (/^[\w./%#?-]+$/u.test(url) && !url.startsWith("/") && !url.includes("..")) return `<a href="${url}">${label}</a>`;
      return label;
    });
}
export function renderMarkdown(input: string): string {
  let fenced = false;
  const output: string[] = [];
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/u.test(line)) { output.push(fenced ? "</code></pre>" : "<pre><code>"); fenced = !fenced; continue; }
    if (fenced) { output.push(`${escapeHtml(line)}\n`); continue; }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); continue; }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? "")) {
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/gu, "").split("|");
      output.push(`<table><thead><tr>${cells(line).map((cell) => `<th>${inlineMarkdown(cell.trim())}</th>`).join("")}</tr></thead><tbody>`);
      index += 2;
      while (index < lines.length && lines[index].includes("|")) { output.push(`<tr>${cells(lines[index]).map((cell) => `<td>${inlineMarkdown(cell.trim())}</td>`).join("")}</tr>`); index++; }
      index--;
      output.push("</tbody></table>"); continue;
    }
    const item = /^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/u.exec(line);
    if (item) { output.push(`<div class="list-item">• ${inlineMarkdown(item[1])}</div>`); continue; }
    if (line.startsWith("> ")) { output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue; }
    if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (fenced) output.push("</code></pre>");
  return output.join("\n");
}

export const documentStyle = `html{color-scheme:light}body{font:15px/1.9 system-ui,sans-serif;background:#fffefa;color:#29352e;margin:0;padding:36px;overflow-wrap:anywhere}main{max-width:900px;margin:auto}h1{font-size:28px}h2{border-bottom:1px solid #dee4db;padding-bottom:8px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #dee4db;padding:9px;text-align:left}pre{background:#edf1e9;padding:16px;overflow:auto}code{font-family:monospace}blockquote{border-left:3px solid #7c9b86;margin-left:0;padding-left:16px}img{max-width:100%}video{max-width:100%;max-height:90vh}button{font:inherit;cursor:pointer}body.media{background:#11151b;color:#e6e9ef;padding:16px;text-align:center}body.media main{display:grid;min-height:90vh;place-content:center}body.media img{max-height:85vh;object-fit:contain}body.media img.zoomed{max-width:none;max-height:none}#error{color:#f5a623}`;

export interface PreviewGrant {
  id: string;
  kind: PreviewKind;
  source: string;
  root: string;
  cached?: string;
  revision: number;
  dependencies: Map<string, string>;
}
export async function signature(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_FILE) throw new Error("Invalid preview file.");
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
}
export async function createGrant(id: string, source: string): Promise<PreviewGrant> {
  if (!localFilePath(source)) throw new Error("Invalid local file.");
  const canonical = await realpath(source);
  if (!localFilePath(canonical)) throw new Error("Invalid local file.");
  const kind = previewKind(canonical);
  if (!kind || basename(canonical).startsWith(".")) throw new Error("Unsupported preview file.");
  const stamp = await signature(canonical);
  return { id, kind, source: canonical, root: dirname(canonical), revision: 0, dependencies: new Map([[canonical, stamp]]) };
}
export async function cacheGrant(grant: PreviewGrant, directory: string): Promise<void> {
  const before = await signature(grant.source);
  const limit = ["markdown", "web"].includes(grant.kind) ? 10 * 1024 * 1024 : grant.kind === "image" ? 100 * 1024 * 1024 : MAX_PREVIEW_FILE;
  if ((await stat(grant.source)).size > limit) throw new Error("Preview file is too large.");
  const cached = join(directory, `${randomUUID()}${extname(grant.source)}`);
  try {
  await copyFile(grant.source, cached);
  if (await signature(grant.source) !== before) throw new Error("File is still being written.");
  if (grant.kind === "pdf" || grant.kind === "video") {
    const stream = createReadStream(cached, { start: 0, end: 63 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const header = Buffer.concat(chunks);
    if (grant.kind === "pdf" ? !header.subarray(0, 5).equals(Buffer.from("%PDF-")) : !header.includes(Buffer.from("ftyp"))) throw new Error("Incomplete media file.");
  }
  grant.cached = cached;
  grant.dependencies.set(grant.source, before);
  grant.revision++;
  } catch (error: unknown) { await rm(cached, { force: true }).catch(() => undefined); throw error; }
}
export async function createPreviewCache(): Promise<string> {
  return createManagedPreviewCache();
}
export async function resolvePreviewAsset(grant: PreviewGrant, encodedPath: string): Promise<string | null> {
  try {
    const decoded = decodeURIComponent(encodedPath).replace(/^\//u, "");
    if (decoded.includes("\\") || decoded.split("/").some((part) => part.startsWith(".") || part.includes(":"))) return null;
    const lexical = resolve(grant.root, decoded);
    const candidate = await realpath(lexical);
    const inside = relative(grant.root, candidate);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !mime[extname(candidate).toLowerCase()]) return null;
    await signature(candidate);
    return candidate;
  } catch { return null; }
}
export function previewRange(value: string | null, size: number): { start: number; end: number } | null | false {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || start < 0) return false;
  return { start, end };
}

export async function fileResponse(path: string, request: globalThis.Request, contentType?: string): Promise<globalThis.Response> {
  const info = await stat(path);
  const range = previewRange(request.headers.get("range"), info.size);
  if (range === false) return new globalThis.Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const headers: Record<string, string> = { "Content-Type": contentType ?? mime[extname(path).toLowerCase()] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  if (request.method === "HEAD") return new globalThis.Response(null, { status: range ? 206 : 200, headers });
  const stream = createReadStream(path, { start, end });
  const cancel = (): void => { stream.destroy(); };
  request.signal.addEventListener("abort", cancel, { once: true });
  stream.once("close", () => request.signal.removeEventListener("abort", cancel));
  return new globalThis.Response(Readable.toWeb(stream) as globalThis.ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}

export async function grantDocument(grant: PreviewGrant): Promise<string> {
  const media = `/${encodeURIComponent(basename(grant.source))}?asset=1&v=${grant.revision}`;
  let body: string;
  if (grant.kind === "markdown") body = renderMarkdown(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(await readFile(grant.cached!)));
  else if (grant.kind === "image") body = `<button id="fit" type="button">100% / Fit</button><p><img id="image" src="${media}"></p>`;
  else if (grant.kind === "video") body = `<video id="video" src="${media}" controls playsinline preload="metadata"></video><p id="error"></p>`;
  else return "";
  // This isolated page has no preload or IPC. The main process uses these fixed DOM IDs to retain media position.
  return `<!doctype html><html><head><meta charset="utf-8"><style>${documentStyle}</style></head><body class="${grant.kind === "markdown" ? "document" : "media"}"><main>${body}</main><script>document.getElementById('fit')?.addEventListener('click',()=>document.getElementById('image').classList.toggle('zoomed'));document.getElementById('video')?.addEventListener('error',()=>{document.getElementById('error').textContent='Cannot play this MP4. The codec may be unsupported.'});</script></body></html>`;
}
