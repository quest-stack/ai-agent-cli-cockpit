import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const testDirectory = resolve(
  import.meta.dirname,
  "..",
  "dist-tests",
  "tests",
  "unit",
);
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => resolve(testDirectory, name));

const result = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-isolation=none", ...testFiles],
  {
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
