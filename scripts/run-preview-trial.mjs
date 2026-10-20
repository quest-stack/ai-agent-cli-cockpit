// Launch the built app with a fresh, separate trial profile. No installed app
// preferences, CLI settings, accounts or startup sessions are read or changed.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const { createDefaultWorkspace } = require(join(root, "dist/electron/defaults.js"));
const directory = await mkdtemp(join(tmpdir(), "cockpit-preview-trial-"));
const workspace = createDefaultWorkspace();
workspace.settings.scanRoots = [];
workspace.settings.pinned = [];
workspace.settings.notificationsEnabled = false;
workspace.settings.tourCompleted = true;
await writeFile(join(directory, "session.json"), JSON.stringify(workspace), "utf8");
const env = { ...process.env, COCKPIT_USER_DATA: directory };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [require.resolve("electron/cli.js"), root], {
  cwd: root, env, stdio: "ignore", detached: true, windowsHide: true,
});
child.unref();
console.log(`CLI Cockpit preview trial started. Separate profile: ${directory}`);
