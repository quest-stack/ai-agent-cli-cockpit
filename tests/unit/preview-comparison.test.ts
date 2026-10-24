import assert from "node:assert/strict";
import test from "node:test";

import { previewRequestSchema } from "../../src/shared/preview";
import { previewArtifactPaths, previewPaths, previewUrls } from "../../src/shared/preview-paths";
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

test("artifact links decode local image paths and exclude remote links", () => {
  assert.deepEqual(previewPaths('![Cover](output/cover%20image.png)\n[Open](<output/second image.svg>)\n[Image](file:///C:/work/output/third%20image.jpg)\n![Remote](https://example.com/private.png)'),
    ["output/cover image.png", "output/second image.svg", "C:/work/output/third image.jpg"]);
  assert.deepEqual(previewPaths('first.png\n[Middle](middle.svg)\n"last image.png"'), ["first.png", "middle.svg", "last image.png"]);
  assert.deepEqual(previewPaths('![Remote](file://server/private.png)\n![Invalid](output/%zz.png)\n![Null](output/%00.png)'), []);
});

test("automatic previews require generated or delivered artifacts instead of incidental paths", () => {
  assert.deepEqual(previewArtifactPaths('Reading docs/reference.pdf\nview_image assets/logo.png\nGet-Content notes.md\nassets/old.png\nCreated output/cover.png\nSaved output/report.pdf\n[Result](output/final.pdf)\n![Image](output/final%20image.svg)\n生成しました: output/result.html'),
    ["output/cover.png", "output/report.pdf", "output/final.pdf", "output/final image.svg", "output/result.html"]);
  assert.deepEqual(previewArtifactPaths('Reading output/generated.png\n参照元: output/saved.pdf\nCreated AGENTS.md\nReading [Result](output/report.pdf)\noutput/report.pdf\nassets/created.png'), []);
});

test("generation progress and echoed shell commands never select an existing artifact", () => {
  for (const line of ['Creating output/cover.png', 'Generating output/cover.png', 'Saving output/report.pdf', "PS C:\\work> Write-Output 'Saved output/report.pdf'", "echo 'Created output/cover.png'", "printf 'Generated output/report.pdf'", 'python render.py --message "Saved output/cover.png"']) {
    assert.deepEqual(previewArtifactPaths(line), [], line);
  }
});

test("Japanese completion messages and terminal hyperlinks identify the actual delivered file", () => {
  assert.deepEqual(previewArtifactPaths('PDFを書き出しました: output/report.pdf\n画像を保存しました: output/cover.png'), ['output/report.pdf', 'output/cover.png']);
  const escape = String.fromCharCode(27), bell = String.fromCharCode(7);
  const linked = `Created ${escape}]8;;file:///C:/work/output/report%20final.pdf${bell}View PDF${escape}]8;;${bell}`;
  assert.deepEqual(previewArtifactPaths(linked), ['C:/work/output/report final.pdf']);
  assert.deepEqual(previewArtifactPaths(linked.replaceAll(bell, `${escape}\\`)), ['C:/work/output/report final.pdf']);
  assert.deepEqual(previewArtifactPaths(linked.replace('Created', 'Reading')), []);
  assert.deepEqual(previewArtifactPaths(linked.replace('file:///C:/work/output/report%20final.pdf', 'https://example.com/report.pdf')), []);
});

test("project context documents are not extracted as generated preview artifacts", () => {
  const context = ["AGENTS.md", "Claude.md", "docs/DESIGN.md", "C:\\work\\README.en.md", "/work/SKILL.md", "CLAUDE.local.md", "AGENTS.override.md", "CURRENT_STATUS.md", "HANDOFF_20261021.md"];
  assert.deepEqual(previewPaths(context.join("\n")), []);
  assert.deepEqual(previewPaths(`output/report.pdf\n${Array.from({ length: 20 }, (_, index) => `project-${index}/AGENTS.md`).join("\n")}`), ["output/report.pdf"]);
  assert.deepEqual(previewPaths("docs/design-proposal.md\noutput/report.md\noutput/design.png"), ["docs/design-proposal.md", "output/report.md", "output/design.png"]);
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
