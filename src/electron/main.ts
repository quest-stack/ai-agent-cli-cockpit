import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  session,
  shell,
} from "electron";

import { formatClipboardImagePath } from "../shared/clipboard";
import { DIAGNOSTIC_CATEGORIES } from "../shared/diagnostics";
import { IPC_CHANNELS } from "../shared/ipc";
import { isGpuCrash } from "../shared/process-gone";
import {
  clipboardTextSchema,
  diagnosticLogMessageSchema,
  notificationRequestSchema,
  persistedWorkspaceSchema,
  ptyResizeRequestSchema,
  ptyWriteRequestSchema,
  sessionIdSchema,
  spawnSessionRequestSchema,
  updateManifestSchema,
} from "../shared/schema";
import { isNewerVersion } from "../shared/version-compare";

import { DiagnosticLogger } from "./diagnostic-log";
import { scanProjects } from "./project-scanner";
import { PtyManager } from "./pty-manager";
import { RemoteLaunchWatcher } from "./remote-launch-watcher";
import { SessionStore } from "./session-store";

import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  OpenDialogOptions,
} from "electron";
import type {
  ClipboardPasteResult,
  ProjectDirectoryPickResult,
} from "../shared/ipc";
import type { UpdateManifest, UpdateNotice } from "../shared/types";

const UPDATE_CHECK_DELAY_MS = 5_000;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/quest-stack/ai-agent-cli-cockpit/main/update-manifest.json";

let availableUpdateManifest: UpdateManifest | null = null;
let mainWindow: BrowserWindow | null = null;
let diagnosticLogger: DiagnosticLogger;
let ptyManager: PtyManager;
let remoteLaunchWatcher: RemoteLaunchWatcher;
let sessionStore: SessionStore;
let updateCheckTimer: ReturnType<typeof setTimeout> | undefined;

if (process.env.COCKPIT_USER_DATA) {
  app.setPath("userData", process.env.COCKPIT_USER_DATA);
} else {
  // 保存先を package.json の name から切り離して固定する。
  //
  // Electron は既定で「appData + アプリ名」を userData にする。つまり
  // package.json の name を変えると保存先も変わり、利用者から見ると
  // タブもセッションもピン留めも全部消えたように見える。
  // 公開に合わせてパッケージ名を変える予定があるため、ここで固定して
  // 名前とデータの置き場所を無関係にしておく。
  //
  // 値は現在の保存先をそのまま使う。既存利用者の設定を引き継ぐため、
  // 新しい名前に合わせて変えてはいけない。
  app.setPath("userData", join(app.getPath("appData"), "claude-cli-cockpit"));
}

function assertTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): void {
  const senderUrl = event.senderFrame?.url;
  const trusted =
    senderUrl !== undefined &&
    (senderUrl.startsWith("file://") ||
      senderUrl.startsWith("http://127.0.0.1:5173/"));

  if (!trusted) {
    throw new Error("Rejected IPC from an untrusted renderer.");
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  const targetWindow = mainWindow;
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send(channel, payload);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getUpdateDownloadUrl(manifest: UpdateManifest): string {
  // ARM64 Windows 上でも x64 ビルドを動かすと process.arch は x64 になる。
  // 今回は実行中バイナリと同じ版を案内し、CPU 実体の補正は将来課題とする。
  if (process.arch === "arm64" || process.arch === "x64") {
    return manifest.urls[process.arch];
  }
  return "";
}

function logUpdateCheckFailure(
  currentVersion: string,
  reason: "network" | "parse" | "timeout",
  message: string,
): void {
  diagnosticLogger.log(
    DIAGNOSTIC_CATEGORIES.updateCheck,
    JSON.stringify({
      currentVersion,
      event: "failed",
      message,
      reason,
    }),
  );
}

async function checkForUpdates(): Promise<void> {
  const currentVersion = app.getVersion();
  diagnosticLogger.log(
    DIAGNOSTIC_CATEGORIES.updateCheck,
    JSON.stringify({
      currentVersion,
      event: "started",
      manifestUrl: UPDATE_MANIFEST_URL,
    }),
  );

  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await net.fetch(UPDATE_MANIFEST_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      logUpdateCheckFailure(
        currentVersion,
        "network",
        `HTTP ${response.status}`,
      );
      return;
    }

    const manifestText = await response.text();
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestText) as unknown;
    } catch (error: unknown) {
      logUpdateCheckFailure(
        currentVersion,
        "parse",
        getErrorMessage(error),
      );
      return;
    }

    const parsed = updateManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      logUpdateCheckFailure(
        currentVersion,
        "parse",
        parsed.error.message,
      );
      return;
    }

    const updateAvailable = isNewerVersion(
      parsed.data.version,
      currentVersion,
    );
    diagnosticLogger.log(
      DIAGNOSTIC_CATEGORIES.updateCheck,
      JSON.stringify({
        currentVersion,
        event: "completed",
        latestVersion: parsed.data.version,
        updateAvailable,
      }),
    );

    if (!updateAvailable) {
      return;
    }

    availableUpdateManifest = parsed.data;
    const notice: UpdateNotice = {
      downloadAvailable: getUpdateDownloadUrl(parsed.data) !== "",
      notes: parsed.data.notes,
      version: parsed.data.version,
    };
    sendToRenderer(IPC_CHANNELS.updateAvailable, notice);
  } catch (error: unknown) {
    logUpdateCheckFailure(
      currentVersion,
      controller.signal.aborted ? "timeout" : "network",
      getErrorMessage(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleUpdateCheck(): void {
  if (updateCheckTimer) {
    return;
  }

  // CLI の復元とレイアウト確定を先に済ませ、更新確認は非同期で一度だけ行う。
  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = undefined;
    void checkForUpdates();
  }, UPDATE_CHECK_DELAY_MS);
}

function registerProcessGoneHandlers(): void {
  app.on("child-process-gone", (_event, details) => {
    diagnosticLogger.log(
      DIAGNOSTIC_CATEGORIES.processGone,
      JSON.stringify({
        event: "child-process-gone",
        exitCode: details.exitCode,
        name: details.name,
        reason: details.reason,
        serviceName: details.serviceName,
        type: details.type,
      }),
    );

    // 正常な GPU プロセス終了では画面を揺らさず、テクスチャ消失が疑われる
    // 異常終了だけを renderer の回復処理へ通知する。
    if (isGpuCrash(details)) {
      sendToRenderer(IPC_CHANNELS.gpuRecovered, null);
    }
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    diagnosticLogger.log(
      DIAGNOSTIC_CATEGORIES.processGone,
      JSON.stringify({
        event: "render-process-gone",
        exitCode: details.exitCode,
        reason: details.reason,
        type: "Renderer",
        webContentsId: webContents.id,
      }),
    );
  });
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC_CHANNELS.diagnosticLog, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = diagnosticLogMessageSchema.safeParse(payload);
    if (parsed.success) {
      diagnosticLogger.log("renderer", parsed.data);
    }
  });

  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    assertTrustedSender(event);
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.bootstrap, async (event) => {
    assertTrustedSender(event);
    const workspace = sessionStore.snapshot;
    return {
      projects: await scanProjects(workspace.settings, workspace.recent),
      workspace,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.clipboardRead,
    async (event): Promise<ClipboardPasteResult> => {
      assertTrustedSender(event);
      const text = clipboard.readText();
      if (text.length > 0) {
        return {
          kind: "text",
          text,
        };
      }

      const image = clipboard.readImage();
      if (image.isEmpty()) {
        return {
          kind: "empty",
        };
      }

      const imagePath = join(
        app.getPath("temp"),
        `cockpit-paste-${Date.now()}.png`,
      );
      await writeFile(imagePath, image.toPNG());
      return {
        kind: "image",
        text: formatClipboardImagePath(imagePath),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.clipboardWriteText,
    (event, payload: unknown) => {
      assertTrustedSender(event);
      const parsed = clipboardTextSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Invalid clipboard text.");
      }
      clipboard.writeText(parsed.data);
    },
  );

  ipcMain.handle(IPC_CHANNELS.projectsRescan, async (event) => {
    assertTrustedSender(event);
    const workspace = sessionStore.snapshot;
    return scanProjects(workspace.settings, workspace.recent);
  });

  ipcMain.handle(
    IPC_CHANNELS.projectDirectoryPick,
    async (event): Promise<ProjectDirectoryPickResult> => {
      assertTrustedSender(event);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        properties: ["openDirectory"],
        title: "フォルダを選択",
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(IPC_CHANNELS.workspaceSave, async (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = persistedWorkspaceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid workspace payload: ${parsed.error.message}`);
    }
    await sessionStore.save(parsed.data);
    // 設定画面でトグルを切り替えた結果がここに届く。監視の開始・停止を
    // 保存と同じ場所で行うことで、設定と実際の挙動がずれないようにする。
    remoteLaunchWatcher.setEnabled(parsed.data.settings.remoteLaunchEnabled);
  });

  ipcMain.handle(IPC_CHANNELS.ptySpawn, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = spawnSessionRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid spawn request: ${parsed.error.message}`);
    }
    return {
      session: ptyManager.spawn(parsed.data),
    };
  });

  ipcMain.handle(IPC_CHANNELS.ptyKill, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = sessionIdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid session id.");
    }
    ptyManager.kill(parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.notification, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = notificationRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid notification request.");
    }

    if (!Notification.isSupported()) {
      return;
    }

    new Notification({
      body: "CLIが入力または承認を待っています。",
      silent: false,
      title: parsed.data.title,
    }).show();
  });

  ipcMain.on(IPC_CHANNELS.ptyWrite, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = ptyWriteRequestSchema.safeParse(payload);
    if (parsed.success) {
      ptyManager.write(parsed.data.sessionId, parsed.data.data);
    }
  });

  ipcMain.on(IPC_CHANNELS.ptyResize, (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = ptyResizeRequestSchema.safeParse(payload);
    if (parsed.success) {
      ptyManager.resize(
        parsed.data.sessionId,
        parsed.data.cols,
        parsed.data.rows,
        parsed.data.sizeSettled === true,
      );
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.updateOpenDownload,
    async (event): Promise<boolean> => {
      assertTrustedSender(event);
      if (!availableUpdateManifest) {
        return false;
      }

      const downloadUrl = getUpdateDownloadUrl(availableUpdateManifest);
      if (downloadUrl === "") {
        return false;
      }

      try {
        await shell.openExternal(downloadUrl);
        return true;
      } catch (error: unknown) {
        diagnosticLogger.log(
          DIAGNOSTIC_CATEGORIES.updateCheck,
          JSON.stringify({
            event: "download-open-failed",
            message: getErrorMessage(error),
            version: availableUpdateManifest.version,
          }),
        );
        return false;
      }
    },
  );
}

function configureNetworkBoundary(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith("file://") ||
      details.url.startsWith("data:") ||
      details.url.startsWith("devtools://") ||
      details.url.startsWith("http://127.0.0.1:5173/") ||
      details.url.startsWith("ws://127.0.0.1:5173/") ||
      // renderer の通信境界は維持し、main が一度読む manifest だけを許可する。
      details.url === UPDATE_MANIFEST_URL;

    callback({ cancel: !allowed });
  });

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
}

function resolveAppIcon(): string | undefined {
  // dev(electron.cmd .)では dist/electron/main.js から見た build/icon.ico、
  // パッケージ後は resourcesPath 配下を探し、存在するものを使う。
  const candidates = [
    join(__dirname, "../../build/icon.ico"),
    join(process.resourcesPath ?? "", "icon.ico"),
    join(process.resourcesPath ?? "", "build", "icon.ico"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function createWindow(): Promise<void> {
  const appIcon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    backgroundColor: "#0b0d10",
    height: 900,
    ...(appIcon ? { icon: appIcon } : {}),
    minHeight: 520,
    minWidth: 760,
    show: false,
    title: "CLI Cockpit",
    titleBarOverlay: {
      color: "#0b0d10",
      height: 40,
      symbolColor: "#8b93a1",
    },
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      devTools: Boolean(process.env.VITE_DEV_SERVER_URL),
      nodeIntegration: false,
      preload: join(__dirname, "preload.js"),
      sandbox: true,
      webSecurity: true,
    },
    width: 1440,
  });

  // メニューは登録しない。コピー/ペーストは renderer の keydown ハンドラで
  // preload 経由のクリップボード IPC を使って自前処理する（メニューの role:paste を
  // 併用すると paste イベントが二重発火するため、経路を1本に絞る）。
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId("jp.quest.cli-cockpit");
  const userDataDirectory = app.getPath("userData");
  diagnosticLogger = new DiagnosticLogger(userDataDirectory);
  await diagnosticLogger.start();
  registerProcessGoneHandlers();

  sessionStore = new SessionStore(userDataDirectory);
  await sessionStore.load();

  ptyManager = new PtyManager({
    onData: (event) => {
      sendToRenderer(IPC_CHANNELS.ptyData, event);
    },
    onDiagnostic: (category, message) => {
      diagnosticLogger.log(category, message);
    },
    onStatus: (event) => {
      sendToRenderer(IPC_CHANNELS.ptyStatus, event);
    },
  });

  remoteLaunchWatcher = new RemoteLaunchWatcher({
    diagnosticCategory: DIAGNOSTIC_CATEGORIES.remoteLaunch,
    directory: join(userDataDirectory, "inbox"),
    events: {
      onDiagnostic: (category, message) => {
        diagnosticLogger.log(category, message);
      },
      onRequest: (request) => {
        // 起動そのものは renderer に任せる。main で pty を起こすと、
        // タブやペインに載らない「画面に出ないセッション」ができる。
        sendToRenderer(IPC_CHANNELS.remoteLaunch, request);
      },
    },
  });
  // 保存済み設定に従って開始する。既定は false なので、更新しただけで
  // 受付口が開くことはない。
  remoteLaunchWatcher.setEnabled(
    sessionStore.snapshot.settings.remoteLaunchEnabled,
  );

  configureNetworkBoundary();
  registerIpcHandlers();
  await createWindow();
  scheduleUpdateCheck();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}).catch((error: unknown) => {
  console.error("CLI Cockpit failed to start.", error);
  app.quit();
});

app.on("before-quit", () => {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  ptyManager?.killAll();
});

app.on("window-all-closed", () => {
  app.quit();
});
