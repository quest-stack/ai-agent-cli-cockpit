import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { scanProjects } from "../../src/electron/project-scanner";

import type { AppSettings, RecentSession } from "../../src/shared/types";

test("pinned, recent and scanned projects are ordered with project markers", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cli-cockpit-test-"));
  const pinnedPath = join(temporaryRoot, "corporate-site-rebranding");
  const recentPath = join(temporaryRoot, "recent-work");
  const plainPath = join(temporaryRoot, "plain-folder");

  try {
    await mkdir(join(pinnedPath, ".git"), { recursive: true });
    await mkdir(recentPath, { recursive: true });
    await mkdir(plainPath, { recursive: true });
    await writeFile(join(recentPath, "package.json"), "{}\n", "utf8");

    const settings: AppSettings = {
      alwaysConfirmClose: false,
      defaultCommand: "claude",
      enterInsertsNewline: false,
      notificationsEnabled: true,
      pinned: [pinnedPath],
      remoteLaunchEnabled: false,
      scanRoots: [temporaryRoot],
      sidebarWidth: 240,
      tourCompleted: false,
    };
    const recent: RecentSession[] = [
      {
        command: "codex",
        cwd: recentPath,
        lastUsedAt: Date.now(),
        projectName: "recent-work",
        title: "review",
      },
    ];

    const projects = await scanProjects(settings, recent);

    assert.equal(projects[0].source, "pinned");
    assert.equal(projects[0].name, "corporate-site-rebranding");
    assert.equal(projects[0].hasGit, true);
    assert.equal(projects[1].source, "recent");
    assert.equal(projects[1].hasPackageJson, true);
    assert.ok(
      projects.some((project) => project.path === resolve(plainPath)),
    );
  } finally {
    const resolvedRoot = resolve(temporaryRoot);
    assert.ok(resolvedRoot.startsWith(resolve(tmpdir())));
    await rm(resolvedRoot, { force: true, recursive: true });
  }
});
