import type {
  ClipboardPasteResult,
  ProjectDirectoryPickResult,
} from "./ipc";

export const SESSION_STATUSES = [
  "busy",
  "waiting",
  "idle",
  "exited",
  "error",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const CLI_COMMANDS = ["claude", "codex", "powershell"] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;
export const MAX_SCAN_ROOTS = 20;

export type SplitAxis = "row" | "column";

export interface PaneNode {
  id: string;
  sessionId: string | null;
  type: "pane";
}

export interface SplitNode {
  axis: SplitAxis;
  children: [LayoutNode, LayoutNode];
  id: string;
  ratio: number;
  type: "split";
}

export type LayoutNode = PaneNode | SplitNode;

export interface TabState {
  activePaneId: string;
  id: string;
  root: LayoutNode;
  title: string;
}

export interface PersistedSession {
  command: string;
  cwd: string;
  id: string;
  projectName: string;
  shouldRestore: boolean;
  title: string;
}

export interface SessionState extends PersistedSession {
  exitCode?: number;
  startedAt: number;
  status: SessionStatus;
}

export interface RecentSession {
  command: string;
  cwd: string;
  lastUsedAt: number;
  projectName: string;
  title: string;
}

export interface SavedPreset {
  id: string;
  name: string;
  sessions: Array<{
    command: string;
    cwd: string;
    projectName: string;
    title: string;
  }>;
}

export interface AppSettings {
  /** 旧版の保存形式との互換用。起動中のセッションは値によらず終了前に確認する。 */
  alwaysConfirmClose: boolean;
  /** Ctrl+Cで選択範囲をコピー。未選択時もCLIへ中断を送らない。 */
  ctrlCCopies: boolean;
  defaultCommand: CliCommand;
  /**
   * Enter で改行し、Shift+Enter で送信する。
   *
   * CLI 本来の割り当ては Enter が送信で、チャット欄の感覚と逆になる。
   * 入れ替えたい利用者向けの設定で、既定は false（CLI 本来のまま）。
   *
   * 実現は Cockpit 側で送るバイトを差し替えることで行い、CLI の設定
   * ファイルには触れない。利用者のホームフォルダを書き換えないため、
   * Cockpit 以外から起動した CLI の操作は変わらない。
   */
  enterInsertsNewline: boolean;
  notificationsEnabled: boolean;
  pinned: string[];
  /**
   * 受付フォルダに置かれた依頼からセッションを起動する機能の有効/無効。
   *
   * 有効にすると、`<userData>/inbox/*.json` を置いた主体が、この PC で
   * CLI セッションを起動できるようになる。ネットワークは開かないが、
   * そのフォルダに書ける相手には作業を実行させる力を与えることになる。
   * 利用者が知らないまま経路が開くことのないよう既定は false とし、
   * 設定で明示的に有効化してもらう。
   */
  remoteLaunchEnabled: boolean;
  scanRoots: string[];
  sidebarWidth: number;
  tourCompleted: boolean;
}

/**
 * 受付フォルダに置く依頼ファイルの中身。
 *
 * 起動するコマンドは受け取らない。`claude` に固定することで、
 * 「ファイルを置ければ任意のコマンドを実行できる」状態を避ける。
 */
export interface RemoteLaunchRequest {
  /** 作業ディレクトリ。実在するディレクトリのみ受理する。 */
  cwd: string;
  /** 起動直後に流し込む最初の指示。省略時は起動のみ。 */
  prompt?: string;
  /** タブに表示する名前。省略時は cwd の末尾から作る。 */
  title?: string;
}

export interface PersistedWorkspace {
  activeTabId: string;
  recent: RecentSession[];
  savedPresets: SavedPreset[];
  sessions: PersistedSession[];
  settings: AppSettings;
  tabs: TabState[];
  version: 1;
}

export type ProjectSource = "pinned" | "recent" | "scan";

export interface ProjectCandidate {
  hasGit: boolean;
  hasPackageJson: boolean;
  name: string;
  path: string;
  source: ProjectSource;
}

export interface BootstrapPayload {
  projects: ProjectCandidate[];
  workspace: PersistedWorkspace;
}

export interface UpdateManifest {
  downloadPage: string;
  notes: string;
  /** Optional for older Japanese-only manifests and clients. */
  editions?: Partial<Record<"ja" | "en", {
    notes: string;
    urls: { arm64: string; x64: string };
  }>>;
  urls: {
    arm64: string;
    x64: string;
  };
  version: string;
}

export interface UpdateNotice {
  downloadAvailable: boolean;
  notes: string;
  version: string;
}

export interface SpawnSessionRequest {
  cols: number;
  command: string;
  cwd: string;
  id: string;
  projectName: string;
  rows: number;
  title: string;
}

export interface SpawnSessionResult {
  session: SessionState;
}

export interface PtyDataEvent {
  data: string;
  sessionId: string;
}

export interface PtyStatusEvent {
  exitCode?: number;
  sessionId: string;
  status: SessionStatus;
}

export interface PtyResizeRequest {
  cols: number;
  rows: number;
  sessionId: string;
  /**
   * WebGL ロードでセル寸法が確定した後のサイズか。true が来た時点で
   * main 側は「これ以上サイズは変わらない」とみなし、保留していた
   * ブートストラップ（claude の起動）を実行してよい。
   */
  sizeSettled?: boolean;
}

export interface PtyWriteRequest {
  data: string;
  sessionId: string;
}

export interface CockpitApi {
  diagnosticLog: (message: string) => void;
  getAppVersion: () => Promise<string>;
  getBootstrap: () => Promise<BootstrapPayload>;
  getPathForFile: (file: globalThis.File) => string;
  /**
   * 依頼を置く受付フォルダの絶対パス。
   *
   * 設定画面で利用者に見せるために使う。この機能は「フォルダに JSON を
   * 置く」以外の入口を持たないため、場所が分からないと誰も使えない。
   */
  getRemoteLaunchInbox: () => Promise<string>;
  killSession: (sessionId: string) => Promise<void>;
  onGpuRecovered: (listener: () => void) => () => void;
  onPtyData: (listener: (event: PtyDataEvent) => void) => () => void;
  onPtyStatus: (listener: (event: PtyStatusEvent) => void) => () => void;
  onRemoteLaunch: (
    listener: (request: RemoteLaunchRequest) => void,
  ) => () => void;
  onUpdateAvailable: (
    listener: (update: UpdateNotice) => void,
  ) => () => void;
  openExternalWebLink: (url: string) => Promise<boolean>;
  openUpdateDownload: () => Promise<boolean>;
  pickProjectDirectory: () => Promise<ProjectDirectoryPickResult>;
  readClipboardForPaste: () => Promise<ClipboardPasteResult>;
  rescanProjects: () => Promise<ProjectCandidate[]>;
  resizeSession: (request: PtyResizeRequest) => void;
  saveWorkspace: (workspace: PersistedWorkspace) => Promise<void>;
  showWaitingNotification: (sessionId: string, title: string) => Promise<void>;
  spawnSession: (request: SpawnSessionRequest) => Promise<SpawnSessionResult>;
  writeClipboardText: (text: string) => Promise<void>;
  writeSession: (request: PtyWriteRequest) => void;
}
