import assert from "node:assert/strict";
import test from "node:test";

import { previewRequestSchema } from "../../src/shared/preview";
import { previewPaths, previewUrls } from "../../src/shared/preview-paths";
import { visualChanges } from "../../src/renderer/preview/visual-diff";

test("artifact extraction accepts CLI-relative paths and quoted spaces but excludes source code and URLs", () => {
  const paths = previewPaths('Saved: output/report.pdf\n`preview/index.html`\n[article](docs/article.md)\n"output/cover image.png"\nclips/demo.mp4\nsrc/electron/preview-files.ts\nhttps://example.com/image.png\nhttp://localhost:3000/page.html\nstyles/app.css');
  assert.deepEqual(new Set(paths), new Set(["output/report.pdf", "preview/index.html", "docs/article.md", "output/cover image.png", "clips/demo.mp4"]));
  assert.deepEqual(previewPaths(`${String.fromCharCode(27)}[32moutput/report.pdf${String.fromCharCode(27)}[0m\npreview\\index.html:12:3`), ["output/report.pdf", "preview\\index.html"]);
  assert.deepEqual(previewPaths("output/re" + "port.pdf"), ["output/report.pdf"]);
});

test("streamed localhost URLs wait for the full port and path instead of opening partial tokens", () => {
  const output = "Local: http://127.0.0.1:4318/preview\r\n";
  for (let length = 0; length < output.indexOf("\r"); length++) {
    assert.deepEqual(previewUrls(output.slice(0, length)), []);
  }
  assert.deepEqual(previewUrls(output), ["http://127.0.0.1:4318/preview"]);
  assert.deepEqual(previewUrls("http://localhost\nhttp://localhost:3000\n"), ["http://localhost:3000/", "http://localhost/"]);
  const escape = String.fromCharCode(27);
  assert.deepEqual(previewUrls(`http://127.0.0.1${escape}[32m:4318/${escape}[0m\n`), ["http://127.0.0.1:4318/"]);
  assert.deepEqual(previewUrls("http://localhost.evil.test:3000/\nhttps://example.com/\n"), []);
});

test("capture and discovery requests bound scroll positions, candidate counts and session IDs", () => {
  assert.equal(previewRequestSchema.safeParse({ action: "capture", tabId: "a", targetId: "b", position: { x: 0, y: 1000 } }).success, true);
  assert.equal(previewRequestSchema.safeParse({ action: "capture", tabId: "a", targetId: "b", position: { x: 0, y: -1 } }).success, false);
  assert.equal(previewRequestSchema.safeParse({ action: "discover", tabId: "a", sessionId: "b", paths: ["output/a.pdf"] }).success, true);
  assert.equal(previewRequestSchema.safeParse({ action: "discover", tabId: "a", sessionId: "../b", paths: ["output/a.pdf"] }).success, false);
  assert.equal(previewRequestSchema.safeParse({ action: "discover", tabId: "a", sessionId: "b", paths: Array(13).fill("a.pdf") }).success, false);
});

test("visual differences group nearby changed pixels and ignore small raster color noise", () => {
  const width = 80; const height = 64; const before = new Uint8ClampedArray(width * height * 4).fill(255); const after = before.slice();
  after[0] = 240;
  assert.deepEqual(visualChanges(before, after, width, height), []);
  for (const [x, y] of [[2, 2], [3, 3], [18, 2], [19, 3], [65, 50], [66, 51]]) after[(y * width + x) * 4] = 0;
  assert.deepEqual(visualChanges(before, after, width, height), [{ x: 0, y: 0, width: 32, height: 16 }, { x: 64, y: 48, width: 16, height: 16 }]);
  assert.deepEqual(visualChanges(before, after, width, height, 16), [{ x: 64, y: 48, width: 16, height: 16 }]);
  assert.throws(() => visualChanges(before, new Uint8ClampedArray(10), width, height), /Invalid/u);
});
