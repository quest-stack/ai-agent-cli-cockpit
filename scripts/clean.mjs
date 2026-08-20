// 配布ビルドの前に、前回の成果物を完全に消す。
//
// これを挟まないと、ハッシュ付きの dist/renderer/assets が消えずに溜まり、
// electron-builder の files: "dist/**/*" が古い版ごと asar へ同梱してしまう。
// 実際 0.1.1 では、無害化する前のダミーデータ（実在の案件名・個人環境の
// パス）を含む古いアセット44個が配布物に残っていた。
//
// dist を消すときは *.tsbuildinfo も一緒に消すこと。tsc --build は増分
// ビルドなので、tsbuildinfo が「生成済み」と記録していると dist/electron を
// 作り直さず、electron-builder が main.js を見つけられずに失敗する。
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");

const targets = [
  "dist",
  "dist-tests",
  "release",
  "tsconfig.electron.tsbuildinfo",
  "tsconfig.renderer.tsbuildinfo",
  "tsconfig.tsbuildinfo",
];

for (const target of targets) {
  const path = resolve(projectRoot, target);
  await rm(path, { force: true, recursive: true });
  console.log(`removed: ${target}`);
}
