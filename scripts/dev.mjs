import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createServer } from "vite";

const projectRoot = resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronCommand =
  process.platform === "win32"
    ? resolve(projectRoot, "node_modules", ".bin", "electron.cmd")
    : resolve(projectRoot, "node_modules", ".bin", "electron");

const compileResult = spawnSync(
  npmCommand,
  ["run", "build:electron"],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);

if (compileResult.status !== 0) {
  process.exit(compileResult.status ?? 1);
}

const server = await createServer({
  configFile: resolve(projectRoot, "vite.config.ts"),
});
await server.listen();

const electronProcess = spawn(electronCommand, [projectRoot], {
  cwd: projectRoot,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173/",
  },
  stdio: "inherit",
  windowsHide: true,
});

const shutdown = async () => {
  if (!electronProcess.killed) {
    electronProcess.kill();
  }
  await server.close();
};

electronProcess.once("exit", async (code) => {
  await shutdown();
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await shutdown();
    process.exit(0);
  });
}
