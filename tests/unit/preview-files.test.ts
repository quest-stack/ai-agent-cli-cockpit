import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { cacheGrant, createGrant, createPreviewCache, fileResponse, previewKind, previewRange, renderMarkdown, resolvePreviewAsset, resolvePreviewCandidates } from "../../src/electron/preview-files";
import { localPreviewUrl, previewFrame, previewRequestSchema, previewSavedSchema } from "../../src/shared/preview";

test("preview URLs accept only loopback HTTP(S), reject credentials and other schemes", () => {
  for (const value of ["http://localhost:3000", "https://127.0.0.1:8443/a", "http://[::1]:4000"]) assert.ok(localPreviewUrl(value));
  for (const value of ["http://localhost.evil.test", "https://example.com", "file:///tmp/test.html", "javascript:alert(1)", "http://user:pass@localhost:3000", "http://0.0.0.0:3000", "http://192.168.1.1:3000"]) assert.equal(localPreviewUrl(value), null);
});

test("preview IPC validates bounded view geometry and tab/target ownership identifiers", () => {
  assert.equal(previewRequestSchema.safeParse({ action: "present", tabId: "tab-1", targetId: "preview-1", bounds: { x: -1, y: 0, width: 800, height: 600 } }).success, false);
  assert.equal(previewRequestSchema.safeParse({ action: "add", tabId: "../other", source: "C:/work/index.html" }).success, false);
  assert.equal(previewSavedSchema.safeParse([{ tabId: "tab-1", targets: [{ id: "target-1", source: "C:/work/index.html" }] }]).success, true);
  assert.equal(previewKind("movie.MP4"), "video"); assert.equal(previewKind(".env"), null);
});

test("responsive preview accepts bounded CSS viewport sizes and fits without changing their aspect ratio", () => {
  const request = { action: "present", tabId: "tab-1", targetId: "preview-1", bounds: { x: 100, y: 100, width: 500, height: 600 }, viewport: { width: 390, height: 844 } };
  assert.equal(previewRequestSchema.safeParse(request).success, true);
  for (const width of [0, 239, 3841, 390.5, Infinity]) assert.equal(previewRequestSchema.safeParse({ ...request, viewport: { width, height: 844 } }).success, false);
  const frame = previewFrame(request.bounds, request.viewport);
  assert.ok(frame.scale < 1);
  assert.ok(frame.bounds.x >= request.bounds.x && frame.bounds.y >= request.bounds.y);
  assert.ok(frame.bounds.x + frame.bounds.width <= request.bounds.x + request.bounds.width);
  assert.ok(frame.bounds.y + frame.bounds.height <= request.bounds.y + request.bounds.height);
  assert.ok(Math.abs(frame.bounds.width / frame.bounds.height - 390 / 844) < 0.002);
  assert.deepEqual(previewFrame(request.bounds), { bounds: request.bounds, scale: 1 });
});

test("Markdown escapes raw HTML and unsafe links while rendering common document elements", () => {
  const html = renderMarkdown('# Heading\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n![image](cover.png)\n| Name | Value |\n| --- | --- |\n| A | **B** |\n```html\n<img onerror=alert(1)>\n```');
  assert.match(html, /<h1>Heading<\/h1>/u); assert.match(html, /<table>/u); assert.match(html, /<strong>B<\/strong>/u);
  assert.doesNotMatch(html, /<script|href="javascript:|<img onerror/iu);
  assert.match(html, /&lt;script&gt;/u); assert.match(html, /src="cover.png"/u);
});

test("asset grants deny traversal, hidden files and symlinks outside the selected folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-assets-"));
  const root = join(directory, "site"); const outside = join(directory, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, "index.html"), "<h1>Safe</h1>"); await writeFile(join(root, "style.css"), "body{color:green}");
  await writeFile(join(root, ".secret.json"), "{}"); await writeFile(join(outside, "secret.json"), "{}");
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const grant = await createGrant("asset-test", join(root, "index.html"));
  assert.equal(await resolvePreviewAsset(grant, "/style.css"), await realpath(join(root, "style.css")));
  for (const path of ["/%2e%2e/outside/secret.json", "/.secret.json", "/linked/secret.json", "/..%5coutside/secret.json"]) assert.equal(await resolvePreviewAsset(grant, path), null);
});

test("media ranges support seeking and reject malformed or out-of-bounds requests", async () => {
  assert.deepEqual(previewRange("bytes=3-5", 10), { start: 3, end: 5 });
  assert.deepEqual(previewRange("bytes=-3", 10), { start: 7, end: 9 });
  for (const value of ["bytes=10-", "bytes=8-2", "bytes=0-2,4-5", "bytes=-"]) assert.equal(previewRange(value, 10), false);
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-range-")); const path = join(directory, "data.mp4");
  await writeFile(path, "0123456789");
  const response = await fileResponse(path, new globalThis.Request("https://example.test", { headers: { range: "bytes=3-5" } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 3-5/10"); assert.equal(await response.text(), "345");
  assert.equal((await fileResponse(path, new globalThis.Request("https://example.test", { headers: { range: "bytes=50-" } }))).status, 416);
});

test("immutable snapshots remain readable after the original is replaced or deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-copy-")); const source = join(directory, "report.pdf");
  await writeFile(source, "%PDF-1.4\nfirst");
  const grant = await createGrant("copy-test", source); const cache = await createPreviewCache();
  await cacheGrant(grant, cache); const first = grant.cached!;
  await writeFile(source, "%PDF-1.4\nsecond"); await cacheGrant(grant, cache); await unlink(source);
  assert.equal(await readFile(first, "utf8"), "%PDF-1.4\nfirst");
  assert.equal(await readFile(grant.cached!, "utf8"), "%PDF-1.4\nsecond"); assert.equal(grant.revision, 2);
});

test("relative artifacts resolve only from the source CLI directory and require an existing supported file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-discover-"));
  const project = join(directory, "project"); const other = join(directory, "other");
  await mkdir(join(project, "output"), { recursive: true }); await mkdir(other);
  await writeFile(join(project, "output", "report.pdf"), "%PDF-1.4\nreport");
  await writeFile(join(project, "source.ts"), "export {};");
  await writeFile(join(other, "private.pdf"), "%PDF-1.4\nprivate");
  await symlink(other, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const resolved = await resolvePreviewCandidates(project, ["output/report.pdf", "source.ts"]);
  assert.equal(resolved.files.length, 1); assert.equal(resolved.files[0].source, await realpath(join(project, "output", "report.pdf")));
  assert.equal(resolved.unresolved, false);
  const unknown = await resolvePreviewCandidates(undefined, ["output/report.pdf"]);
  assert.deepEqual(unknown, { files: [], unresolved: true });
  const rejected = await resolvePreviewCandidates(project, ["missing.pdf", "../other/private.pdf", "linked/private.pdf"]);
  assert.deepEqual(rejected, { files: [], unresolved: true });
});

test("project context documents are ignored by discovery without reporting missing artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-context-"));
  for (const name of ["AGENTS.md", "Claude.md", "DESIGN.md", "README.md", "SKILL.md"]) await writeFile(join(directory, name), "# Project instructions");
  const names = ["AGENTS.md", "Claude.md", "DESIGN.md", "README.md", "SKILL.md", "CURRENT_STATUS.md", "HANDOFF_20261021.md"];
  assert.deepEqual(await resolvePreviewCandidates(directory, names), { files: [], unresolved: false });
  assert.deepEqual(await resolvePreviewCandidates(undefined, names), { files: [], unresolved: false });
});

test("project context documents can still be opened explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-manual-context-"));
  const source = join(directory, "AGENTS.md"); await writeFile(source, "# Project instructions");
  const grant = await createGrant("manual-context", source);
  assert.equal(grant.kind, "markdown");
  assert.equal(grant.source, await realpath(source));
});

test("a requested context preview keeps the session directory, hidden-file and symlink boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-requested-context-"));
  const project = join(directory, "project"); const other = join(directory, "other");
  await mkdir(project); await mkdir(other); await mkdir(join(project, ".private"));
  await writeFile(join(project, "AGENTS.md"), "# Requested instructions");
  await writeFile(join(other, "CLAUDE.md"), "# Outside instructions");
  await writeFile(join(project, ".private", "DESIGN.md"), "# Hidden instructions");
  await symlink(other, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const result = await resolvePreviewCandidates(project, ["AGENTS.md"], true);
  assert.deepEqual(result.files.map((file) => file.source), [await realpath(join(project, "AGENTS.md"))]);
  assert.deepEqual(await resolvePreviewCandidates(project, ["../other/CLAUDE.md", "linked/CLAUDE.md", ".private/DESIGN.md"], true), { files: [], unresolved: true });
  assert.deepEqual(await resolvePreviewCandidates(undefined, ["AGENTS.md"], true), { files: [], unresolved: true });
});
