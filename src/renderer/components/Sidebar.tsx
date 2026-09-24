import {
  ChevronLeft,
  ChevronRight,
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "../../shared/types";

import { LogoMark } from "./LogoMark";
import { StatusDot } from "./StatusDot";

import { t } from "../../shared/i18n";

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ProjectCandidate,
  SessionState,
} from "../../shared/types";

interface SidebarProps {
  activeSessionId: string | null;
  collapsed: boolean;
  onCloseSession: (session: SessionState) => void;
  onLaunchPinned: () => Promise<void>;
  onNewSession: () => void;
  onRemoveSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onRestartSession: (session: SessionState) => Promise<void>;
  onResize: (width: number) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleCollapsed: () => void;
  pinnedProjects: ProjectCandidate[];
  sessions: SessionState[];
  width: number;
}

interface SessionTitleEditorProps {
  initialTitle: string;
  label: string;
  onCancel: () => void;
  onCommit: (title: string) => void;
}

function SessionTitleEditor({
  initialTitle,
  label,
  onCancel,
  onCommit,
}: SessionTitleEditorProps) {
  const [draft, setDraft] = useState(initialTitle);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      aria-label={label}
      className="session-title-input"
      onBlur={() => {
        if (!cancelledRef.current) {
          onCommit(draft);
        }
      }}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      ref={inputRef}
      value={draft}
    />
  );
}

export function Sidebar({
  activeSessionId,
  collapsed,
  onCloseSession,
  onLaunchPinned,
  onNewSession,
  onRemoveSession,
  onRenameSession,
  onRestartSession,
  onResize,
  onSelectSession,
  onToggleCollapsed,
  pinnedProjects,
  sessions,
  width,
}: SidebarProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(
    null,
  );
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const sidebarStyle = {
    "--sidebar-width": `${width}px`,
  } as CSSProperties;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (collapsed) {
      return;
    }

    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(pointerId);
    document.body.classList.add("is-resizing-sidebar");

    const move = (moveEvent: PointerEvent): void => {
      onResize(startWidth + moveEvent.clientX - startX);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing-sidebar");
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };

  const resizeWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResize(width - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResize(width + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(MIN_SIDEBAR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(MAX_SIDEBAR_WIDTH);
    }
  };

  return (
    <aside
      className={`sidebar ${collapsed ? "is-collapsed" : ""}`}
      style={sidebarStyle}
    >
      <div className="sidebar-brand">
        <LogoMark />
        {!collapsed && (
          <div>
            <strong>CLI Cockpit</strong>
            <span>LOCAL TERMINAL ARRAY</span>
          </div>
        )}
        <button
          aria-label={collapsed ? t("サイドバーを展開") : t("サイドバーを折りたたむ")}
          className="sidebar-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? t("展開") : t("折りたたむ")}
          type="button"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={15} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={15} />
          )}
        </button>
      </div>

      <div
        aria-label={t("独立セッション一覧")}
        className="sidebar-section-heading"
      >
        {!collapsed && <span>INDEPENDENT SESSIONS</span>}
        {!collapsed && <small>{sessions.length}</small>}
      </div>

      <div
        className="session-list"
        data-testid="session-list"
        data-tour-target="session-list"
      >
        {sessions.length === 0 && !collapsed && (
          <p className="session-empty">{t("起動中のCLIはありません。")}</p>
        )}
        {sessions.map((session) => {
          const exited =
            session.status === "exited" || session.status === "error";
          return (
            <div
              aria-label={`${session.title} ${session.projectName}`}
              className={`session-row ${
                activeSessionId === session.id ? "is-active" : ""
              }`}
              data-testid={`session-row-${session.id}`}
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectSession(session.id);
                }
              }}
              role="button"
              tabIndex={0}
              title={`${session.title} · ${session.projectName}`}
            >
              <StatusDot status={session.status} />
              {!collapsed && (
                <span
                  className="session-copy"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setEditingSessionId(session.id);
                  }}
                >
                  {editingSessionId === session.id ? (
                    <SessionTitleEditor
                      initialTitle={session.title}
                      label={t("{value0} のセッション名", { value0: session.projectName })}
                      onCancel={() => setEditingSessionId(null)}
                      onCommit={(title) => {
                        onRenameSession(session.id, title);
                        setEditingSessionId(null);
                      }}
                    />
                  ) : (
                    <strong title={t("ダブルクリックで名前を編集")}>
                      {session.title}
                    </strong>
                  )}
                  <small>{session.projectName}</small>
                </span>
              )}
              {!collapsed && (
                <span className="session-actions">
                  {exited && (
                    <button
                      aria-label={t("同じ設定で再起動")}
                      className="row-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onRestartSession(session);
                      }}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={14} />
                    </button>
                  )}
                  <button
                    aria-label={exited ? t("一覧から除去") : t("セッションを終了")}
                    className="row-action row-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (exited) {
                        onRemoveSession(session.id);
                      } else {
                        onCloseSession(session);
                      }
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button
          className="sidebar-primary-action"
          data-tour-target="new-session"
          onClick={onNewSession}
          title={t("新規セッション")}
          type="button"
        >
          <Plus aria-hidden="true" size={16} />
          {!collapsed && <span>New Session</span>}
        </button>
        <button
          aria-expanded={presetsOpen}
          className="sidebar-secondary-action"
          onClick={() => setPresetsOpen((value) => !value)}
          title={t("プリセット")}
          type="button"
        >
          <Layers3 aria-hidden="true" size={16} />
          {!collapsed && <span>{t("プリセット")}</span>}
          {!collapsed &&
            (presetsOpen ? (
              <ChevronLeft aria-hidden="true" size={14} />
            ) : (
              <ChevronRight aria-hidden="true" size={14} />
            ))}
        </button>
        {presetsOpen && !collapsed && (
          <div className="preset-popover">
            <span className="preset-eyebrow">DYNAMIC PRESET</span>
            <strong>{t("全案件")}</strong>
            <p>{t("現在のピン留め {value0} 件を個別タブで起動", { value0: pinnedProjects.length })}</p>
            <button
              disabled={launching || pinnedProjects.length === 0}
              onClick={async () => {
                setLaunching(true);
                try {
                  await onLaunchPinned();
                  setPresetsOpen(false);
                } finally {
                  setLaunching(false);
                }
              }}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" size={13} />
              {launching ? t("起動中…") : t("全案件を開く")}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div
          aria-label={t("サイドバー幅を変更")}
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={width}
          className="sidebar-resize-handle"
          onDoubleClick={() => onResize(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
          role="separator"
          tabIndex={0}
          title={t("ドラッグで幅を変更・ダブルクリックで初期幅")}
        />
      )}
    </aside>
  );
}
