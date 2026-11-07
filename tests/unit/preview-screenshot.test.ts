import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { fullPageDimensions, replaceScreenshotFile } from "../../src/electron/preview-screenshot";
import { previewRequestSchema } from "../../src/shared/preview";

test("full-page capture bounds reject malformed and oversized page geometry", () => {
  assert.deepEqual(fullPageDimensions({ cssContentSize: { width: 1440.2, height: 2600 } }), { ok: true, width: 1441, height: 2600 });
  for (const size of [{ width: Infinity, height: 1 }, { width: 0, height: 10 }, { width: 10, height: NaN }]) {
    assert.deepEqual(fullPageDimensions({ cssContentSize: size }), { ok: false, error: "failed" });
  }
  for (const size of [{ width: 32769, height: 1 }, { width: 1000, height: 32769 }, { width: 8000, height: 8000 }]) {
    assert.deepEqual(fullPageDimensions({ cssContentSize: size }), { ok: false, error: "too-large" });
  }
});

for (const mode of ["transient", "persistent", "stale", "nonretryable"] as const) {
  test(`PNG replacement ${mode} locks preserve the approved file until a valid atomic replacement`, async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "cockpit-owned-png-replace-"));
    const temporary = join(directory, "owned.tmp"), destination = join(directory, "approved.png");
    await fs.writeFile(temporary, "new PNG"); await fs.writeFile(destination, "approved old PNG");
    const rename = fs.rename;
    let attempts = 0, current = true;
    const patched = mock.method(fs, "rename", async (...args: Parameters<typeof rename>): Promise<void> => {
      attempts++;
      assert.equal(await fs.readFile(destination, "utf8"), "approved old PNG");
      if (mode === "transient" && attempts > 2) return rename(...args);
      if (mode === "stale") current = false;
      throw Object.assign(new Error("Owned replacement fixture"), { code: mode === "nonretryable" ? "ENOENT" : "EPERM" });
    });
    try {
      const replace = (): Promise<boolean> => replaceScreenshotFile(temporary, destination, () => current, "win32");
      if (mode === "transient") {
        assert.equal(await replace(), true);
        assert.equal(await fs.readFile(destination, "utf8"), "new PNG");
        assert.ok(attempts >= 3 && attempts <= 6);
      } else {
        if (mode === "stale") assert.equal(await replace(), false);
        else await assert.rejects(replace(), { code: mode === "nonretryable" ? "ENOENT" : "EPERM" });
        assert.equal(await fs.readFile(destination, "utf8"), "approved old PNG");
        assert.equal(await fs.readFile(temporary, "utf8"), "new PNG");
        assert.equal(attempts, mode === "persistent" ? 6 : 1);
      }
    } finally { patched.mock.restore(); }
  });
}

test("screenshot IPC cannot choose a file path or inject a source", () => {
  const request = { action: "screenshot", tabId: "tab-1", targetId: "target-1", destination: "file" };
  assert.equal(previewRequestSchema.safeParse(request).success, true);
  assert.equal(previewRequestSchema.safeParse({ ...request, filePath: "C:/arbitrary.png" }).success, false);
  assert.equal(previewRequestSchema.safeParse({ ...request, source: "file:///C:/arbitrary" }).success, false);
  assert.equal(previewRequestSchema.safeParse({ ...request, destination: "arbitrary" }).success, false);
});
