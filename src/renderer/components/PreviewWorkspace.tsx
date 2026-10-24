import { Maximize2, Minimize2, PanelRight, PanelRightClose } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../../shared/i18n";
import { PreviewPanel } from "../preview/PreviewPanel";
import { NativePreviewPanel } from "../preview/NativePreviewPanel";
import { cockpitApi } from "../bridge";
import { previewPrototypeEnabled, readPreviewTrialState, savePreviewTrialState } from "../preview/prototype-state";
import "../preview/preview.css";

import type { CSSProperties, ReactNode } from "react";
import type { PreviewTrialState } from "../preview/prototype-state";

interface PreviewWorkspaceProps {
  active: boolean;
  children: (cliVisible: boolean) => ReactNode;
  tabId: string;
  suspended?: boolean;
  sessionIds?: string[];
  onOpen?: () => void;
}

export function PreviewWorkspace(props: PreviewWorkspaceProps) {
  return previewPrototypeEnabled ? <PreviewWorkspaceLayout {...props} />
    : cockpitApi.preview ? <PreviewWorkspaceLayout {...props} native /> : props.children(true);
}

function PreviewWorkspaceLayout({ active, children, tabId, suspended = false, sessionIds = [], native = false, onOpen }: PreviewWorkspaceProps & { native?: boolean }) {
  const storageId = native ? `native-${tabId}` : tabId;
  const [state, setState] = useState(() => readPreviewTrialState(storageId));
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<"cli" | "preview">("preview");
  const [expanded, setExpanded] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const draggingRef = useRef<{ id: number; startX: number; startRatio: number } | null>(null);

  useEffect(() => savePreviewTrialState(storageId, state), [state, storageId]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setNarrow(entry.contentRect.width < 840);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const cliVisible = !state.open || (narrow ? view === "cli" : !expanded);
  const previewVisible = active && !suspended && state.open && (!narrow || view === "preview");
  const updateState = (updater: (current: PreviewTrialState) => PreviewTrialState): void => setState(updater);
  const close = (): void => {
    setState((current) => ({ ...current, open: false, dismissed: true }));
    setExpanded(false);
    closeRef.current?.focus();
  };

  return (
    <div className={`preview-workspace ${narrow ? "is-narrow" : ""}`} ref={shellRef}>
      <div className="preview-workspace-toolbar">
        <span className="preview-trial-label">{native ? t("成果物を会話の隣で確認") : t("プレビューのUI試作 · サンプル表示")}</span>
        {state.open && narrow && (
          <div aria-label={t("表示の切り替え")} className="preview-view-switch">
            <button aria-pressed={view === "cli"} onClick={() => setView("cli")} type="button">AI</button>
            <button aria-pressed={view === "preview"} onClick={() => setView("preview")} type="button">{t("プレビュー")}</button>
          </div>
        )}
        <button
          aria-controls={`preview-${tabId}`} aria-expanded={state.open}
          className={`preview-toggle ${state.open ? "is-open" : ""}`}
          data-testid="preview-toggle" ref={closeRef}
          onClick={() => {
            if (state.open) close();
            else { onOpen?.(); setView("preview"); setState((current) => ({ ...current, open: true })); }
          }} type="button"
        >
          <PanelRight aria-hidden="true" size={14} />{t("プレビュー")}
        </button>
      </div>
      <div className="preview-workspace-body" data-expanded={expanded || undefined} ref={bodyRef}
        style={{ "--preview-ratio": `${state.ratio * 100}%` } as CSSProperties}>
        <div className="preview-cli" hidden={!cliVisible}>{children(cliVisible)}</div>
        {state.open && !narrow && !expanded && (
          <div aria-label={t("プレビューの幅を変更")} aria-orientation="vertical"
            aria-valuemin={30} aria-valuemax={65} aria-valuenow={Math.round(state.ratio * 100)}
            className="preview-resize" role="separator" tabIndex={0}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              setState((current) => ({ ...current, ratio: event.key === "Home" ? 0.3 : event.key === "End" ? 0.65
                : Math.max(0.3, Math.min(0.65, current.ratio + (event.key === "ArrowLeft" ? 0.02 : -0.02))) }));
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingRef.current = { id: event.pointerId, startX: event.clientX, startRatio: state.ratio };
            }}
            onPointerMove={(event) => {
              const drag = draggingRef.current;
              const width = bodyRef.current?.clientWidth;
              if (!drag || drag.id !== event.pointerId || !width) return;
              const ratio = Math.max(0.3, Math.min(0.65, drag.startRatio - (event.clientX - drag.startX) / width));
              setState((current) => ({ ...current, ratio }));
            }}
            onPointerUp={() => { draggingRef.current = null; }}
            onLostPointerCapture={() => { draggingRef.current = null; }}
          />
        )}
        <section aria-label={t("プレビュー")} className="preview-region" hidden={!state.open || (narrow && view !== "preview")}
          id={`preview-${tabId}`} style={{ flexBasis: narrow || expanded ? "100%" : "var(--preview-ratio)" }}>
          <header className="preview-region-header">
            <strong><PanelRight aria-hidden="true" size={14} />{t("プレビュー")}</strong>
            <div>
              {!narrow && <button aria-label={expanded ? t("並べて表示に戻す") : t("プレビューを拡大")}
                onClick={() => setExpanded((current) => !current)} type="button">
                {expanded ? <Minimize2 aria-hidden="true" size={14} /> : <Maximize2 aria-hidden="true" size={14} />}
              </button>}
              <button aria-label={t("プレビューを閉じる")} onClick={close} type="button"><PanelRightClose aria-hidden="true" size={15} /></button>
            </div>
          </header>
          {native ? <NativePreviewPanel autoOpen={active && !suspended && !state.dismissed}
            onAutoOpen={() => {
              onOpen?.(); setView("preview");
              setState((current) => current.dismissed ? current : { ...current, open: true });
            }} onRequestedOpen={() => {
              if (!active || suspended) return;
              onOpen?.(); setView("preview"); setState((current) => ({ ...current, open: true, dismissed: false }));
            }} sessionIds={sessionIds} tabId={tabId} visible={previewVisible} />
            : <PreviewPanel onChange={updateState} state={state} tabId={tabId} visible={previewVisible} />}
        </section>
      </div>
    </div>
  );
}
