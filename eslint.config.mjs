import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

const nodeGlobals = {
  __dirname: "readonly",
  __filename: "readonly",
  Buffer: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  Electron: "readonly",
  global: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

const browserGlobals = {
  cancelAnimationFrame: "readonly",
  ClipboardEvent: "readonly",
  document: "readonly",
  HTMLButtonElement: "readonly",
  HTMLDialogElement: "readonly",
  HTMLDivElement: "readonly",
  HTMLElement: "readonly",
  HTMLInputElement: "readonly",
  KeyboardEvent: "readonly",
  PointerEvent: "readonly",
  requestAnimationFrame: "readonly",
  ResizeObserver: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  window: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "dist-tests/**",
      "node_modules/**",
      "release/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          "disallowTypeAnnotations": false,
          "prefer": "type-imports",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: [
      "src/electron/**/*.ts",
      "tests/**/*.ts",
      "scripts/**/*.mjs",
      "vite.config.ts",
      "playwright.config.ts",
    ],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: browserGlobals,
    },
  },
  {
    files: ["tests/e2e/**/*.ts"],
    languageOptions: {
      globals: browserGlobals,
    },
    rules: {
      "no-empty-pattern": "off",
    },
  },
  {
    files: ["src/renderer/App.tsx"],
    rules: {
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
