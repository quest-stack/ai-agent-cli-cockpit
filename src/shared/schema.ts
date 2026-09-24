import { z } from "zod";

import {
  CLI_COMMANDS,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SCAN_ROOTS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SESSION_STATUSES,
} from "./types";

const safeIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const pathSchema = z.string().min(1).max(1_024).refine(
  (value) => !value.includes("\0"),
  "Path contains a null byte.",
);
const commandSchema = z.string().min(1).max(256).refine(
  (value) => !/[\r\n\0]/u.test(value),
  "Command must be a single line.",
);
const updateUrlSchema = z.string().max(2_048).refine((value) => {
  if (value === "") {
    return true;
  }

  try {
    const url = new globalThis.URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "Update URLs must be empty or use HTTP(S).");
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);

export const clipboardTextSchema = z.string().max(1_000_000);
export const appEditionMetadataSchema = z.object({
  cockpitLanguage: z.enum(["ja", "en"]).default("ja"),
});
export const diagnosticLogMessageSchema = z.string().min(1).max(16_384);

export const paneNodeSchema = z.object({
  id: safeIdSchema,
  sessionId: safeIdSchema.nullable(),
  type: z.literal("pane"),
});

export const layoutNodeSchema: z.ZodType<
  import("./types").LayoutNode
> = z.lazy(() =>
  z.union([
    paneNodeSchema,
    z.object({
      axis: z.enum(["row", "column"]),
      children: z.tuple([layoutNodeSchema, layoutNodeSchema]),
      id: safeIdSchema,
      ratio: z.number().min(0.15).max(0.85),
      type: z.literal("split"),
    }),
  ]),
);

export const tabStateSchema = z.object({
  activePaneId: safeIdSchema,
  id: safeIdSchema,
  root: layoutNodeSchema,
  title: z.string().min(1).max(100),
});

export const persistedSessionSchema = z.object({
  command: commandSchema,
  cwd: pathSchema,
  id: safeIdSchema,
  projectName: z.string().min(1).max(160),
  shouldRestore: z.boolean(),
  title: z.string().min(1).max(160),
});

export const sessionStateSchema = persistedSessionSchema.extend({
  exitCode: z.number().int().optional(),
  startedAt: z.number().int().nonnegative(),
  status: z.enum(SESSION_STATUSES),
});

export const recentSessionSchema = z.object({
  command: commandSchema,
  cwd: pathSchema,
  lastUsedAt: z.number().int().nonnegative(),
  projectName: z.string().min(1).max(160),
  title: z.string().min(1).max(160),
});

export const savedPresetSchema = z.object({
  id: safeIdSchema,
  name: z.string().min(1).max(80),
  sessions: z.array(
    z.object({
      command: commandSchema,
      cwd: pathSchema,
      projectName: z.string().min(1).max(160),
      title: z.string().min(1).max(160),
    }),
  ).min(1).max(24),
});

export const appSettingsSchema = z.object({
  alwaysConfirmClose: z.boolean(),
  ctrlCCopies: z.boolean().default(false),
  defaultCommand: z.enum(CLI_COMMANDS),
  // Enter で改行し、Shift+Enter で送信する。
  //
  // 既定は false（CLI 本来の Enter=送信のまま）。利用者が使っている CLI の
  // 操作を変えるため、更新しただけで挙動が変わることがないようにする。
  enterInsertsNewline: z.boolean().default(false),
  notificationsEnabled: z.boolean(),
  pinned: z.array(pathSchema).max(100),
  // 既存の設定ファイルにはこのキーが無い。既定を false にすることで、
  // 更新しただけで受付口が開くことがないようにする。
  remoteLaunchEnabled: z.boolean().default(false),
  scanRoots: z.array(pathSchema).max(MAX_SCAN_ROOTS),
  sidebarWidth: z.number().int()
    .min(MIN_SIDEBAR_WIDTH)
    .max(MAX_SIDEBAR_WIDTH)
    .default(DEFAULT_SIDEBAR_WIDTH),
  tourCompleted: z.boolean().default(false),
});

export const persistedWorkspaceSchema = z.object({
  activeTabId: safeIdSchema,
  recent: z.array(recentSessionSchema).max(40),
  savedPresets: z.array(savedPresetSchema).max(40),
  sessions: z.array(persistedSessionSchema).max(64),
  settings: appSettingsSchema,
  tabs: z.array(tabStateSchema).min(1).max(32),
  version: z.literal(1),
});

export const updateManifestSchema: z.ZodType<
  import("./types").UpdateManifest
> = z.object({
  downloadPage: updateUrlSchema,
  editions: z.object({
    ja: z.object({
      notes: z.string().min(1).max(2_000),
      urls: z.object({ arm64: updateUrlSchema, x64: updateUrlSchema }),
    }).optional(),
    en: z.object({
      notes: z.string().min(1).max(2_000),
      urls: z.object({ arm64: updateUrlSchema, x64: updateUrlSchema }),
    }).optional(),
  }).optional(),
  notes: z.string().min(1).max(2_000),
  urls: z.object({
    arm64: updateUrlSchema,
    x64: updateUrlSchema,
  }),
  version: versionSchema,
});

/**
 * 受付フォルダに置かれた依頼ファイルの検証。
 *
 * command を持たせない（`claude` 固定）。ここでコマンドを受け取ると、
 * ファイルを置けることが任意コマンド実行と同義になってしまう。
 * prompt は端末へそのまま流し込むため、制御文字を弾く。改行は
 * 「送信」と解釈されるので、ここでは1行だけを受け付ける。
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 先頭の BOM を取り除く。
 *
 * PowerShell の `Out-File -Encoding utf8` や Windows のメモ帳は UTF-8 BOM を
 * 付けて書く。BOM が残ったままだと JSON.parse は必ず失敗するため、依頼を
 * 書く側が Windows の標準的な手段を使っただけで弾かれてしまう。
 * 実際に PowerShell で書いた依頼が一度これで弾かれた。
 */
export function stripByteOrderMark(value: string): string {
  return value.codePointAt(0) === 0xfeff ? value.slice(1) : value;
}

export const remoteLaunchRequestSchema = z.object({
  cwd: pathSchema,
  prompt: z.string().min(1).max(4_000).refine(
    (value) => !hasControlCharacter(value),
    "Prompt must not contain control characters.",
  ).optional(),
  title: z.string().min(1).max(160).refine(
    (value) => !hasControlCharacter(value),
    "Title must not contain control characters.",
  ).optional(),
});

export const spawnSessionRequestSchema = z.object({
  cols: z.number().int().min(2).max(1_000),
  command: commandSchema,
  cwd: pathSchema,
  id: safeIdSchema,
  projectName: z.string().min(1).max(160),
  rows: z.number().int().min(1).max(1_000),
  title: z.string().min(1).max(160),
});

export const ptyResizeRequestSchema = z.object({
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(1).max(1_000),
  sessionId: safeIdSchema,
  sizeSettled: z.boolean().optional(),
});

export const ptyWriteRequestSchema = z.object({
  data: z.string().max(1_000_000),
  sessionId: safeIdSchema,
});

export const sessionIdSchema = safeIdSchema;

export const notificationRequestSchema = z.object({
  sessionId: safeIdSchema,
  title: z.string().min(1).max(160),
});
