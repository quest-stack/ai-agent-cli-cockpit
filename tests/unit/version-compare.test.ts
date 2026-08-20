import assert from "node:assert/strict";
import test from "node:test";

import { isNewerVersion } from "../../src/shared/version-compare";

test("isNewerVersion compares major, minor and patch numerically", () => {
  assert.equal(isNewerVersion("0.1.8", "0.1.7"), true);
  assert.equal(isNewerVersion("0.1.7", "0.1.7"), false);
  assert.equal(isNewerVersion("0.1.6", "0.1.7"), false);
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
});

test("isNewerVersion returns false without throwing for invalid input", () => {
  const compareUnknown = isNewerVersion as (
    latest: unknown,
    current: unknown,
  ) => boolean;

  for (const invalidVersion of [
    "",
    "abc",
    "1.a.0",
    "1.2",
    "1.2.3.4",
    undefined,
  ]) {
    assert.doesNotThrow(() => compareUnknown(invalidVersion, "0.1.7"));
    assert.equal(compareUnknown(invalidVersion, "0.1.7"), false);
    assert.doesNotThrow(() => compareUnknown("0.1.7", invalidVersion));
    assert.equal(compareUnknown("0.1.7", invalidVersion), false);
  }
});
