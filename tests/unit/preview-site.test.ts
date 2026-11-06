import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGrant, resolvePreviewCandidates, resolvePreviewSiteAsset } from "../../src/electron/preview-files";
import { previewArtifactPaths, previewDeliveredPaths, previewPaths } from "../../src/shared/preview-paths";
import { previewRequestSchema, previewSavedSchema } from "../../src/shared/preview";

async function siteFixture() {
  const directory = await mkdtemp(join(process.env.COCKPIT_TEST_DATA ?? tmpdir(), "cockpit-site-"));
  const root = join(directory, "site");
  await mkdir(join(root, "d1"), { recursive: true }); await mkdir(join(root, "images"));
  await writeFile(join(root, "index.html"), "<a href='/d1/'>Direction 1</a>");
  await writeFile(join(root, "d1/index.html"), "<img src='../images/shared.svg'>");
  await writeFile(join(root, "images/shared.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { directory, root: await realpath(root) };
}

test("a static site folder grants its entry, directory routes, root paths and shared sibling assets", async () => {
  const { root } = await siteFixture();
  const grant = await createGrant("site-test", root);
  assert.equal(grant.kind, "web"); assert.equal(grant.siteRoot, root);
  assert.equal(grant.source, join(root, "index.html"));
  for (const route of ["/d1", "/d1/", "/d1/index.html"]) assert.equal(await resolvePreviewSiteAsset(grant, route), join(root, "d1/index.html"));
  assert.equal(await resolvePreviewSiteAsset(grant, "/"), join(root, "index.html"));
  assert.equal(await resolvePreviewSiteAsset(grant, "/images/shared.svg"), join(root, "images/shared.svg"));
  assert.equal(await resolvePreviewSiteAsset(grant, "/images/"), null);
  await writeFile(join(root, "terms.html"), "<h1>Terms</h1>");
  assert.equal(await resolvePreviewSiteAsset(grant, "/terms"), join(root, "terms.html"));
  const child = await createGrant("child-test", join(root, "d1/index.html"), root);
  assert.equal(child.root, root); assert.equal(child.siteRoot, root);
});

test("site grants reject hidden paths, escaped entries and symlink escapes without executing project scripts", async () => {
  const { directory, root } = await siteFixture();
  const outside = join(directory, "outside"); await mkdir(outside);
  await writeFile(join(outside, "private.html"), "private"); await writeFile(join(outside, "index.html"), "private");
  await writeFile(join(root, ".env.local"), "private");
  await mkdir(join(root, ".private")); await writeFile(join(root, ".private/private.html"), "private");
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(root, ".private"), join(root, "hidden-alias"), process.platform === "win32" ? "junction" : "dir");
  const grant = await createGrant("boundary-test", root);
  for (const route of ["/.env.local", "/.private/private.html", "/hidden-alias/private.html", "/escape/", "/%2e%2e/outside/private.html", "/..%5coutside/private.html"]) assert.equal(await resolvePreviewSiteAsset(grant, route), null);
  await assert.rejects(createGrant("escaped-entry", join(outside, "private.html"), root));
  // Windows junctions above cover directory escapes without requiring an OS privilege change.
  if (process.platform !== "win32") {
    const linkedRoot = join(directory, "linked-entry"); await mkdir(linkedRoot);
    await symlink(join(outside, "index.html"), join(linkedRoot, "index.html"));
    await assert.rejects(createGrant("linked-entry", linkedRoot));
  }
  const dynamic = join(directory, "dynamic"); await mkdir(dynamic);
  await writeFile(join(dynamic, "package.json"), JSON.stringify({ scripts: { dev: "must-not-run" } }));
  await assert.rejects(createGrant("dynamic-test", dynamic));
});

test("only explicit site deliveries are discovered and auto-opened within the source CLI directory", async () => {
  const { directory, root } = await siteFixture();
  const output = 'サイト: "./site/"\n';
  assert.deepEqual(previewPaths(output), ["./site/"]);
  assert.deepEqual(previewDeliveredPaths(output), ["./site/"]);
  assert.deepEqual(previewArtifactPaths(output), ["./site/"]);
  for (const incidental of ['Read "./site/"\n', 'node build.js "./site/"\n', 'git -C "./site/" status\n', 'サイト: https://example.com/\n', 'サイト: .env.local\n']) assert.deepEqual(previewPaths(incidental), []);
  const result = await resolvePreviewCandidates(directory, previewPaths(output));
  assert.equal(result.files.length, 1); assert.equal(result.files[0].source, join(root, "index.html"));
  assert.equal(result.files[0].siteRoot, root); assert.equal(result.unresolved, false);
  const html = await resolvePreviewCandidates(directory, ["site/d1/index.html"]);
  assert.equal(html.files[0].source, join(root, "d1/index.html"));
  assert.equal(html.files[0].siteRoot, root);
  assert.deepEqual(await resolvePreviewCandidates(undefined, ["./site/"]), { files: [], unresolved: true });
  assert.deepEqual(await resolvePreviewCandidates(root, ["../site/../outside/"]), { files: [], unresolved: true });
});

test("site folder selection and root restoration cross validated IPC and persistence boundaries", () => {
  assert.equal(previewRequestSchema.safeParse({ action: "pick-site", tabId: "tab-1" }).success, true);
  assert.equal(previewRequestSchema.safeParse({ action: "add", tabId: "tab-1", source: "/site/d1/index.html", siteRoot: "/site" }).success, true);
  assert.equal(previewRequestSchema.safeParse({ action: "add", tabId: "tab-1", source: "/site/index.html", siteRoot: "x".repeat(2049) }).success, false);
  const saved = [{ tabId: "tab-1", targets: [{ id: "target-1", source: "/site/d1/index.html", siteRoot: "/site" }] }];
  assert.deepEqual(previewSavedSchema.parse(saved), saved);
});
