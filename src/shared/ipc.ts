export const IPC_CHANNELS = {
  appVersion: "cockpit:app-version",
  bootstrap: "cockpit:bootstrap",
  clipboardRead: "cockpit:clipboard-read",
  clipboardWriteText: "cockpit:clipboard-write-text",
  diagnosticLog: "cockpit:diagnostic-log",
  gpuRecovered: "cockpit:gpu-recovered",
  notification: "cockpit:notification",
  openExternalWebLink: "cockpit:open-external-web-link",
  projectDirectoryPick: "cockpit:project-directory-pick",
  projectsRescan: "cockpit:projects-rescan",
  ptyData: "cockpit:pty-data",
  ptyKill: "cockpit:pty-kill",
  ptyResize: "cockpit:pty-resize",
  ptySpawn: "cockpit:pty-spawn",
  ptyStatus: "cockpit:pty-status",
  ptyWrite: "cockpit:pty-write",
  remoteLaunch: "cockpit:remote-launch",
  remoteLaunchInbox: "cockpit:remote-launch-inbox",
  updateAvailable: "cockpit:update-available",
  updateOpenDownload: "cockpit:update-open-download",
  workspaceSave: "cockpit:workspace-save",
} as const;

export type IpcChannels = typeof IPC_CHANNELS;

export type ClipboardPasteResult =
  | {
      kind: "empty";
    }
  | {
      kind: "image" | "text";
      text: string;
    };

export type ProjectDirectoryPickResult = string | null;
