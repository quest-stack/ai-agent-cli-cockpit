import { access, readdir, stat } from "node:fs/promises";
import { basename, normalize, resolve } from "node:path";

import type {
  AppSettings,
  ProjectCandidate,
  ProjectSource,
  RecentSession,
} from "../shared/types";

interface ProjectMarkers {
  hasGit: boolean;
  hasPackageJson: boolean;
}

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "release",
  "test-results",
]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readMarkers(path: string): Promise<ProjectMarkers> {
  const [hasGit, hasPackageJson] = await Promise.all([
    pathExists(resolve(path, ".git")),
    pathExists(resolve(path, "package.json")),
  ]);

  return { hasGit, hasPackageJson };
}

function normalizedKey(path: string): string {
  return normalize(resolve(path)).toLocaleLowerCase("en-US");
}

function displayName(path: string): string {
  return basename(path);
}

export async function scanProjects(
  settings: AppSettings,
  recent: RecentSession[],
): Promise<ProjectCandidate[]> {
  const candidates = new Map<
    string,
    { order: number; path: string; source: ProjectSource }
  >();
  let order = 0;

  for (const pinnedPath of settings.pinned) {
    if (await isDirectory(pinnedPath)) {
      candidates.set(normalizedKey(pinnedPath), {
        order: order++,
        path: resolve(pinnedPath),
        source: "pinned",
      });
    }
  }

  for (const recentSession of recent) {
    if (!(await isDirectory(recentSession.cwd))) {
      continue;
    }

    const key = normalizedKey(recentSession.cwd);
    if (!candidates.has(key)) {
      candidates.set(key, {
        order: order++,
        path: resolve(recentSession.cwd),
        source: "recent",
      });
    }
  }

  for (const scanRoot of settings.scanRoots) {
    let entries;
    try {
      entries = await readdir(scanRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        IGNORED_DIRECTORY_NAMES.has(entry.name)
      ) {
        continue;
      }

      const path = resolve(scanRoot, entry.name);
      const key = normalizedKey(path);
      if (!candidates.has(key)) {
        candidates.set(key, { order: order++, path, source: "scan" });
      }
    }
  }

  const enriched = await Promise.all(
    [...candidates.values()].map(async ({ order: candidateOrder, path, source }) => ({
      ...(await readMarkers(path)),
      name: displayName(path),
      order: candidateOrder,
      path,
      source,
    })),
  );

  const sourceRank: Readonly<Record<ProjectSource, number>> = {
    pinned: 0,
    recent: 1,
    scan: 2,
  };

  return enriched
    .sort((left, right) => {
      const sourceDifference =
        sourceRank[left.source] - sourceRank[right.source];
      if (sourceDifference !== 0) {
        return sourceDifference;
      }

      if (left.source !== "scan") {
        return left.order - right.order;
      }

      const markerDifference =
        Number(right.hasGit || right.hasPackageJson) -
        Number(left.hasGit || left.hasPackageJson);
      if (markerDifference !== 0) {
        return markerDifference;
      }

      return left.name.localeCompare(right.name, "ja");
    })
    .map((project) => ({
      hasGit: project.hasGit,
      hasPackageJson: project.hasPackageJson,
      name: project.name,
      path: project.path,
      source: project.source,
    }));
}
