import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const language = process.env.COCKPIT_LANGUAGE ?? "ja";
if (language !== "ja" && language !== "en") {
  throw new Error("COCKPIT_LANGUAGE must be ja or en.");
}
const rendererOutput = process.env.COCKPIT_EDITION_BUILD === "1"
  ? `dist/editions/${language}/renderer`
  : "dist/renderer";

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react(), {
    name: "cockpit-edition-language",
    transformIndexHtml: (html) => html.replace('<html lang="ja">', `<html lang="${language}">`),
  }],
  define: { __COCKPIT_LANGUAGE__: JSON.stringify(language) },
  build: {
    // 古いビルド成果物を残さない。false のままだとハッシュ付きの
    // assets が消えずに溜まり続け、electron-builder の files: dist/**/*
    // がそれごと配布物へ同梱してしまう（過去の内容が exe に残る）。
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, rendererOutput),
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
