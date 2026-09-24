import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import ts from "typescript";

import { resolveAppLanguage, translate } from "../../src/shared/i18n";
import { englishMessages } from "../../src/shared/messages.en";
import { appEditionMetadataSchema, updateManifestSchema } from "../../src/shared/schema";
import { getUpdateForEdition } from "../../src/shared/update-edition";

import type { MessageKey } from "../../src/shared/i18n";

test("English messages keep the same placeholders as the Japanese originals", () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
  for (const [key, value] of Object.entries(englishMessages)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /[\u3040-\u30ff\u4e00-\u9fff]/u, key);
  }
});

test("translation preserves user-provided text without interpreting its placeholders", () => {
  const key: MessageKey = "{value0} · ほか{value1}件";
  const values = { value0: "作業名 {value1} $&", value1: 2 };
  assert.equal(translate("ja", key, values), "作業名 {value1} $& · ほか2件");
  assert.equal(translate("en", key, values), "作業名 {value1} $& · 2 more");
});

test("old app metadata defaults to Japanese and fixed English metadata is accepted", () => {
  assert.equal(appEditionMetadataSchema.parse({}).cockpitLanguage, "ja");
  assert.equal(appEditionMetadataSchema.parse({ cockpitLanguage: "en" }).cockpitLanguage, "en");
  assert.equal(appEditionMetadataSchema.safeParse({ cockpitLanguage: "fr" }).success, false);
  assert.equal(resolveAppLanguage(undefined), "ja");
});

const manifest = {
  version: "0.2.8", notes: "日本語のお知らせ", downloadPage: "https://example.com/releases",
  urls: { arm64: "https://example.com/ja-arm64.exe", x64: "https://example.com/ja-x64.exe" },
  editions: { en: {
    notes: "English release notes",
    urls: { arm64: "https://example.com/en-arm64.exe", x64: "https://example.com/en-x64.exe" },
  } },
};

test("update downloads select the installed language and architecture", () => {
  const parsed = updateManifestSchema.parse(manifest);
  assert.deepEqual(getUpdateForEdition(parsed, "en", "arm64"), {
    downloadUrl: "https://example.com/en-arm64.exe", notes: "English release notes",
  });
  assert.equal(getUpdateForEdition(parsed, "en", "x64").downloadUrl, "https://example.com/en-x64.exe");
  assert.equal(getUpdateForEdition(parsed, "ja", "x64").downloadUrl, "https://example.com/ja-x64.exe");
  assert.equal(getUpdateForEdition(parsed, "en", "unsupported").downloadUrl, "");
});

test("an old manifest never directs an English edition to a Japanese installer", () => {
  const parsed = updateManifestSchema.parse({ ...manifest, editions: undefined });
  const english = getUpdateForEdition(parsed, "en", "arm64");
  assert.equal(english.downloadUrl, "");
  assert.doesNotMatch(english.notes, /[\u3040-\u30ff\u4e00-\u9fff]/u);
  assert.equal(getUpdateForEdition(parsed, "ja", "arm64").downloadUrl, manifest.urls.arm64);
});

test("edition download URLs must pass the same validation as legacy URLs", () => {
  assert.equal(updateManifestSchema.safeParse({ ...manifest, editions: { en: {
    ...manifest.editions.en, urls: { arm64: "javascript:alert(1)", x64: "" },
  } } }).success, false);
});

test("UI source has no Japanese copy outside the translation dictionary", () => {
  const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/u;
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name))
      : /\.tsx?$/u.test(entry.name) ? [join(directory, entry.name)] : []);
  const missing: string[] = [];
  for (const file of files("src")) {
    if (file.endsWith("messages.en.ts")) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "t") return;
      const value = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
        ? node.text : ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map((span) => span.literal.text).join("") : "";
      if (japanese.test(value)) missing.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
});
