import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  build: {
    // 古いビルド成果物を残さない。false のままだとハッシュ付きの
    // assets が消えずに溜まり続け、electron-builder の files: dist/**/*
    // がそれごと配布物へ同梱してしまう（過去の内容が exe に残る）。
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
