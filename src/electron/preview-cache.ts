import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

const markerName = "owner.json";
const ownerSchema = z.object({ kind: z.literal("cockpit-preview-cache-v1"), pid: z.number().int().positive(), nonce: z.string().uuid() });
const ownedFile = /^(?:page-)?[a-f0-9-]{36}\.(?:mhtml|png|html|htm|md|jpe?g|gif|webp|svg|pdf|mp4)$/iu;
const rootName = "cli-cockpit-preview-v1";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function checkedOwner(directory: string, root: string) {
  if (dirname(resolve(directory)) !== resolve(root) || !basename(directory).startsWith("instance-")) return undefined;
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
  const marker = join(directory, markerName);
  const markerInfo = await lstat(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 512) return undefined;
  const result = ownerSchema.safeParse(JSON.parse(await readFile(marker, "utf8")));
  return result.success && basename(directory) === `instance-${result.data.pid}-${result.data.nonce}` ? result.data : undefined;
}

async function eraseOwnedFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && ownedFile.test(entry.name)) await unlink(join(directory, entry.name)).catch(() => undefined);
  }
  const remaining = await readdir(directory);
  if (remaining.length === 1 && remaining[0] === markerName) {
    await unlink(join(directory, markerName));
    await rmdir(directory).catch(() => undefined);
  }
}

/** Only marked, dead instances below this dedicated cache root are eligible. */
export async function cleanPreviewCaches(root: string, isAlive: (pid: number) => boolean = alive): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
  for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 256)) {
    if (!entry.isDirectory() || !entry.name.startsWith("instance-")) continue;
    const directory = join(root, entry.name);
    try {
      const owner = await checkedOwner(directory, root);
      if (owner && !isAlive(owner.pid)) await eraseOwnedFiles(directory);
    } catch { /* Invalid markers and directories belonging to other software are untouched. */ }
  }
}

export async function createManagedPreviewCache(base = tmpdir()): Promise<string> {
  const root = join(await realpath(base), rootName);
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid preview cache root");
  await cleanPreviewCaches(root);
  const owner = { kind: "cockpit-preview-cache-v1", pid: process.pid, nonce: randomUUID() };
  const directory = join(root, `instance-${owner.pid}-${owner.nonce}`);
  await mkdir(directory);
  await writeFile(join(directory, markerName), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
  return directory;
}

export async function releasePreviewCache(directory: string): Promise<void> {
  try {
    const root = dirname(directory);
    if (basename(root) !== rootName) return;
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const owner = await checkedOwner(directory, root);
    if (owner?.pid === process.pid) await eraseOwnedFiles(directory);
  } catch { /* Crash/locked-file leftovers are retried at the next startup. */ }
}
