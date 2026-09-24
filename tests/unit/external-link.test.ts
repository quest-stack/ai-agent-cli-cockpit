import assert from "node:assert/strict";
import test from "node:test";

import { openExternalWebLink } from "../../src/shared/external-link";

test("external links preserve HTTPS paths, queries and fragments", async () => {
  const url = "https://example.com/docs?a=1&b=two%20words#setup";
  const opened: string[] = [];
  assert.equal(await openExternalWebLink(url, async (value) => { opened.push(value); }), true);
  assert.deepEqual(opened, [url]);
});

test("external links allow local HTTP development pages", async () => {
  assert.equal(await openExternalWebLink("http://localhost:3000/", async () => {}), true);
});

test("invalid URLs and non-web protocols never reach the OS opener", async () => {
  let calls = 0;
  for (const value of [
    "javascript:alert(1)", "file:///C:/Windows/system32/cmd.exe", "data:text/html,hello",
    "ms-settings:", "about:blank", "//example.com", "not a URL", null, {},
    "https://user:password@example.com/", "https://example.com/\nfoo",
  ]) {
    assert.equal(await openExternalWebLink(value, async () => { calls += 1; }), false);
  }
  assert.equal(calls, 0);
});

test("OS opener failure is returned without an unhandled rejection", async () => {
  assert.equal(await openExternalWebLink("https://example.com/", async () => { throw new Error("No browser"); }), false);
});
