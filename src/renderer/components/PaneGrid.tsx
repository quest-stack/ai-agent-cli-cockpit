import {
  Columns2,
  Maximize2,
  Minimize2,
  Rows2,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { findPane } from "../../shared/layout";

import { Launcher } from "./Launcher";
import { StatusDot } from "./StatusDot";
import { TerminalView } from "./TerminalView";

import { t } from "../../shared/i18n";

import type { LaunchInput } from "./Launcher";
import type {
  AppSettings,
  LayoutNode,
  ProjectCandidate,
  RecentSession,
  SessionState,
  SplitAxis,
} from "../../shared/types";

interface PaneGridProps {
  activePaneId: string;
  closingSessionIds: ReadonlySet<string>;
  launcherError?: string;
  node: LayoutNode;
  onActivatePane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onRescan: () => Promise<void>;
  onSplitPane: (paneId: string, axis: SplitAxis) => void;
  onStart: (paneId: string, input: LaunchInput) => Promise<void>;
  onTogglePin: (path: string) => void;
  onToggleZoom: (paneId: string) => void;
  paneCount: number;
  projects: ProjectCandidate[];
  recent: RecentSession[];
  sessions: SessionState[];
  settings: AppSettings;
  tabActive: boolean;
  zoomedPaneId: string | null;
}

export function PaneGrid(props: PaneGridProps) {
  const {
    activePaneId,
    closingSessionIds,
    launcherError,
    node,
    onActivatePane,
    onClosePane,
    onResizeSplit,
    onRescan,
    onSplitPane,
    onStart,
    onTogglePin,
    onToggleZoom,
    paneCount,
    projects,
    recent,
    sessions,
    settings,
    tabActive,
    zoomedPaneId,
  } = props;

  if (node.type === "split") {
    return (
      <div
        className={`split-layout split-${node.axis}`}
        data-split-id={node.id}
      >
        <div
          className="split-child"
          hidden={zoomedPaneId !== null && !findPane(node.children[0], zoomedPaneId)}
          style={{ flexBasis: zoomedPaneId ? "100%" : `${node.ratio * 100}%` }}
        >
          <PaneGrid
            {...props}
            key={node.children[0].id}
            node={node.children[0]}
          />
        </div>
        <div
          aria-label={
            node.axis === "row"
              ? t("左右ペインの幅を変更")
              : t("上下ペインの高さを変更")
          }
          className="split-handle"
          hidden={zoomedPaneId !== null}
          onPointerDown={(event) => {
            event.preventDefault();
            const handle = event.currentTarget;
            const container = handle.parentElement;
            if (!container) {
              return;
            }

            handle.setPointerCapture(event.pointerId);
            const move = (moveEvent: PointerEvent): void => {
              const bounds = container.getBoundingClientRect();
              const ratio =
                node.axis === "row"
                  ? (moveEvent.clientX - bounds.left) / bounds.width
                  : (moveEvent.clientY - bounds.top) / bounds.height;
              onResizeSplit(node.id, ratio);
            };
            const stop = (): void => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", stop);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", stop, { once: true });
          }}
          role="separator"
        />
        <div
          className="split-child"
          hidden={zoomedPaneId !== null && !findPane(node.children[1], zoomedPaneId)}
          style={{ flexBasis: zoomedPaneId ? "100%" : `${(1 - node.ratio) * 100}%` }}
        >
          <PaneGrid
            {...props}
            key={node.children[1].id}
            node={node.children[1]}
          />
        </div>
      </div>
    );
  }

  const session = sessions.find((item) => item.id === node.sessionId);
  const visible = tabActive && (!zoomedPaneId || node.id === zoomedPaneId);
  const active = visible && node.id === activePaneId;
  const maximized = zoomedPaneId === node.id;
  const zoomLabel = maximized ? t("分割表示に戻す") : t("ペインを最大化");
  const zoomButton = paneCount > 1 && (
    <button
      aria-label={zoomLabel}
      aria-pressed={maximized}
      onClick={(event) => {
        event.stopPropagation();
        onToggleZoom(node.id);
      }}
      title={`${zoomLabel} (Ctrl+Shift+Enter)`}
      type="button"
    >
      {maximized
        ? <Minimize2 aria-hidden="true" size={14} />
        : <Maximize2 aria-hidden="true" size={14} />}
    </button>
  );
  const closing = session
    ? closingSessionIds.has(session.id)
    : false;

  return (
    <section
      aria-label={session ? t("{value0} ターミナル", { value0: session.title }) : t("新規セッション")}
      className={`terminal-pane ${active ? "is-active" : ""}`}
      data-pane-id={node.id}
      data-testid={`pane-${node.id}`}
      data-zoomed={maximized ? "true" : undefined}
      onMouseDown={() => onActivatePane(node.id)}
    >
      {session ? (
        <>
          <header className="pane-header">
            <div className="pane-identity">
              <StatusDot status={session.status} />
              <TerminalIcon aria-hidden="true" size={14} />
              <span title={`${session.title} · ${session.projectName}`}>
                <strong>{session.title}</strong>
                <small> · {session.projectName}</small>
              </span>
            </div>
            <div className="pane-meta">
              <span className="command-chip">{session.command}</span>
              <span className="pane-status-label">{session.status}</span>
            </div>
            <div className="pane-actions">
              {zoomButton}
              <button
                aria-label={t("右に分割")}
                onClick={(event) => {
                  event.stopPropagation();
                  onSplitPane(node.id, "row");
                }}
                title={t("右に分割 (Ctrl+Shift+D)")}
                type="button"
              >
                <Columns2 aria-hidden="true" size={14} />
              </button>
              <button
                aria-label={t("下に分割")}
                onClick={(event) => {
                  event.stopPropagation();
                  onSplitPane(node.id, "column");
                }}
                title={t("下に分割 (Ctrl+Shift+E)")}
                type="button"
              >
                <Rows2 aria-hidden="true" size={14} />
              </button>
              {paneCount > 1 && (
                <button
                  aria-label={t("ペインを閉じる")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClosePane(node.id);
                  }}
                  title={t("ペインを閉じる")}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </button>
              )}
            </div>
          </header>
          {closing ? (
            <div className="terminal-closing" role="status">{t("セッションを終了しています…")}</div>
          ) : (
            <TerminalView
              active={active}
              command={session.command}
              onFocus={() => onActivatePane(node.id)}
              sessionId={session.id}
              visible={visible}
            />
          )}
          {!closing &&
            (session.status === "exited" || session.status === "error") && (
            <div className="exited-banner" role="status">
              {session.status === "error"
                ? t("異常終了{value0}", { value0: session.exitCode === undefined ? "" : ` (${session.exitCode})` })
                : t("プロセス終了")}
              <span>{t("サイドバーの ↻ で同じ設定を再起動できます")}</span>
            </div>
            )}
        </>
      ) : (
        <div className="empty-pane">
          <div className="empty-pane-actions">
            {zoomButton}
            <button
              aria-label={t("右に分割")}
              onClick={() => onSplitPane(node.id, "row")}
              title={t("右に分割")}
              type="button"
            >
              <Columns2 aria-hidden="true" size={14} />
            </button>
            <button
              aria-label={t("下に分割")}
              onClick={() => onSplitPane(node.id, "column")}
              title={t("下に分割")}
              type="button"
            >
              <Rows2 aria-hidden="true" size={14} />
            </button>
            {paneCount > 1 && (
              <button
                aria-label={t("ペインを閉じる")}
                onClick={() => onClosePane(node.id)}
                title={t("ペインを閉じる")}
                type="button"
              >
                <X aria-hidden="true" size={14} />
              </button>
            )}
          </div>
          <Launcher
            error={active ? launcherError : undefined}
            onRescan={onRescan}
            onStart={(input) => onStart(node.id, input)}
            onTogglePin={onTogglePin}
            projects={projects}
            recent={recent}
            settings={settings}
          />
        </div>
      )}
    </section>
  );
}
