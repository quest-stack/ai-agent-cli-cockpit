import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cleanPreviewCaches, createManagedPreviewCache, releasePreviewCache } from "../../src/electron/preview-cache";
import { archiveFingerprint, historyVictims } from "../../src/electron/preview-history";

test("MHTML deduplication ignores generated MIME values but preserves document and asset differences", () => {
  const archive = (id: string, date: string, content = "same") => Buffer.from(`From: Blink\r\nDate: ${date}\r\nContent-Type: multipart/related; boundary="boundary-${id}"\r\n\r\n--boundary-${id}\r\nContent-ID: <frame-${id}@mhtml.blink>\r\n\r\n<p>${content}</p><img src="cid:css-${id}@mhtml.blink">\r\n--boundary-${id}--`, "latin1");
  const marks = new Map([["body > p", "same"]]);
  const first = archiveFingerprint(archive("ABC123", "Monday"), marks);
  assert.equal(first, archiveFingerprint(archive("DEF456", "Tuesday"), marks));
  assert.notEqual(first, archiveFingerprint(archive("DEF456", "Tuesday", "different"), marks));
  assert.notEqual(first, archiveFingerprint(archive("DEF456", "Tuesday"), new Map([["body > p", "new style"]])));
});

test("history retains at most three versions per target and evicts oldest versions across targets for the byte cap", () => {
  const entries = [1, 2, 3, 4].map((order) => ({ id: `a${order}`, targetId: "a", bytes: 30, order }));
  entries.push({ id: "b5", targetId: "b", bytes: 30, order: 5 });
  assert.deepEqual(historyVictims(entries, 120), ["a1"]);
  assert.deepEqual(historyVictims(entries, 90), ["a1", "a2"]);
});

test("startup removes marked dead-instance files while active instances keep their cache", async () => {
  const base = await mkdtemp(join(tmpdir(), "cockpit-cache-cleanup-test-"));
  const directory = await createManagedPreviewCache(base);
  const file = join(directory, "page-12345678-1234-1234-1234-123456789abc.mhtml");
  await writeFile(file, "saved preview");
  const root = dirname(directory);
  await cleanPreviewCaches(root, () => true);
  await access(file);
  await cleanPreviewCaches(root, () => false);
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("cleanup leaves unmarked directories, unknown files and malformed owners untouched", async () => {
  const base = await mkdtemp(join(tmpdir(), "cockpit-cache-boundary-test-"));
  const directory = await createManagedPreviewCache(base);
  const root = dirname(directory);
  await writeFile(join(directory, "user-note.txt"), "keep");
  const unmarked = join(root, "instance-unmarked"); await mkdir(unmarked);
  await writeFile(join(unmarked, "page-12345678-1234-1234-1234-123456789abc.mhtml"), "keep");
  const malformed = join(root, "instance-malformed"); await mkdir(malformed);
  await writeFile(join(malformed, "owner.json"), '{"kind":"other-app","pid":1}');
  await cleanPreviewCaches(root, () => false);
  assert.equal(await readFile(join(directory, "user-note.txt"), "utf8"), "keep");
  assert.ok((await readdir(directory)).includes("owner.json"));
  await access(unmarked); await access(malformed);
});

test("normal disposal removes only this process's marked cache", async () => {
  const base = await mkdtemp(join(tmpdir(), "cockpit-cache-release-test-"));
  const directory = await createManagedPreviewCache(base);
  await writeFile(join(directory, "12345678-1234-1234-1234-123456789abc.html"), "sample");
  await releasePreviewCache(directory);
  await assert.rejects(access(directory), { code: "ENOENT" });
});
