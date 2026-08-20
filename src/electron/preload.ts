import { contextBridge, ipcRenderer, webUtils } from "electron";

import type {
  ClipboardPasteResult,
  IpcChannels,
  ProjectDirectoryPickResult,
} from "../shared/ipc";
import type {
  BootstrapPayload,
  CockpitApi,
  PersistedWorkspace,
  ProjectCandidate,
  PtyDataEvent,
  PtyResizeRequest,
  PtyStatusEvent,
  PtyWriteRequest,
  RemoteLaunchRequest,
  SpawnSessionRequest,
  SpawnSessionResult,
  UpdateNotice,
} from "../shared/types";

const CHANNELS = {
  appVersion: "cockpit:app-version",
  bootstrap: "cockpit:bootstrap",
  clipboardRead: "cockpit:clipboard-read",
  clipboardWriteText: "cockpit:clipboard-write-text",
  diagnosticLog: "cockpit:diagnostic-log",
  gpuRecovered: "cockpit:gpu-recovered",
  notification: "cockpit:notification",
  projectDirectoryPick: "cockpit:project-directory-pick",
  projectsRescan: "cockpit:projects-rescan",
  ptyData: "cockpit:pty-data",
  ptyKill: "cockpit:pty-kill",
  ptyResize: "cockpit:pty-resize",
  ptySpawn: "cockpit:pty-spawn",
  ptyStatus: "cockpit:pty-status",
  ptyWrite: "cockpit:pty-write",
  remoteLaunch: "cockpit:remote-launch",
  updateAvailable: "cockpit:update-available",
  updateOpenDownload: "cockpit:update-open-download",
  workspaceSave: "cockpit:workspace-save",
} as const satisfies IpcChannels;

const api: CockpitApi = {
  diagnosticLog: (message) => {
    ipcRenderer.send(CHANNELS.diagnosticLog, message);
  },
  getAppVersion: () =>
    ipcRenderer.invoke(CHANNELS.appVersion) as Promise<string>,
  getBootstrap: () =>
    ipcRenderer.invoke(CHANNELS.bootstrap) as Promise<BootstrapPayload>,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  killSession: (sessionId) =>
    ipcRenderer.invoke(CHANNELS.ptyKill, sessionId) as Promise<void>,
  onGpuRecovered: (listener) => {
    const eventListener = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.gpuRecovered, eventListener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.gpuRecovered, eventListener);
    };
  },
  onPtyData: (listener) => {
    const eventListener = (
      _event: Electron.IpcRendererEvent,
      payload: PtyDataEvent,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(CHANNELS.ptyData, eventListener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ptyData, eventListener);
    };
  },
  onPtyStatus: (listener) => {
    const eventListener = (
      _event: Electron.IpcRendererEvent,
      payload: PtyStatusEvent,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(CHANNELS.ptyStatus, eventListener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ptyStatus, eventListener);
    };
  },
  onRemoteLaunch: (listener) => {
    const eventListener = (
      _event: Electron.IpcRendererEvent,
      payload: RemoteLaunchRequest,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(CHANNELS.remoteLaunch, eventListener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.remoteLaunch, eventListener);
    };
  },
  onUpdateAvailable: (listener) => {
    const eventListener = (
      _event: Electron.IpcRendererEvent,
      payload: UpdateNotice,
    ): void => {
      listener(payload);
    };
    ipcRenderer.on(CHANNELS.updateAvailable, eventListener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.updateAvailable, eventListener);
    };
  },
  openUpdateDownload: () =>
    ipcRenderer.invoke(CHANNELS.updateOpenDownload) as Promise<boolean>,
  pickProjectDirectory: () =>
    ipcRenderer.invoke(
      CHANNELS.projectDirectoryPick,
    ) as Promise<ProjectDirectoryPickResult>,
  readClipboardForPaste: () =>
    ipcRenderer.invoke(
      CHANNELS.clipboardRead,
    ) as Promise<ClipboardPasteResult>,
  rescanProjects: () =>
    ipcRenderer.invoke(CHANNELS.projectsRescan) as Promise<ProjectCandidate[]>,
  resizeSession: (request: PtyResizeRequest) => {
    ipcRenderer.send(CHANNELS.ptyResize, request);
  },
  saveWorkspace: (workspace: PersistedWorkspace) =>
    ipcRenderer.invoke(CHANNELS.workspaceSave, workspace) as Promise<void>,
  showWaitingNotification: (sessionId, title) =>
    ipcRenderer.invoke(CHANNELS.notification, {
      sessionId,
      title,
    }) as Promise<void>,
  spawnSession: (request: SpawnSessionRequest) =>
    ipcRenderer.invoke(
      CHANNELS.ptySpawn,
      request,
    ) as Promise<SpawnSessionResult>,
  writeClipboardText: (text) =>
    ipcRenderer.invoke(CHANNELS.clipboardWriteText, text) as Promise<void>,
  writeSession: (request: PtyWriteRequest) => {
    ipcRenderer.send(CHANNELS.ptyWrite, request);
  },
};

contextBridge.exposeInMainWorld("cockpit", api);
