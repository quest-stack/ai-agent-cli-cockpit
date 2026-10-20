import { ExternalLink, FileImage, FileText, FolderOpen, Globe, Plus, RefreshCw, Video, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "../../shared/i18n";
import { localPreviewUrl, previewFrame, previewViewportSchema, previewViewportsSchema } from "../../shared/preview";
import { previewPaths, previewUrls } from "../../shared/preview-paths";
import { cockpitApi } from "../bridge";
import { ResponsivePreviewControls } from "./ResponsivePreviewControls";
import { compareCaptures, VisualComparison } from "./VisualComparison";

import type { PreviewCapture, PreviewFileCandidate, PreviewRequest, PreviewSnapshot, PreviewTarget, PreviewViewport } from "../../shared/preview";
import type { VisualComparisonData } from "./VisualComparison";

const icons = { web: Globe, markdown: FileText, image: FileImage, pdf: FileText, video: Video };

export function NativePreviewPanel({ tabId, visible, sessionIds, autoOpen, onAutoOpen }: {
  tabId: string; visible: boolean; sessionIds: string[]; autoOpen: boolean; onAutoOpen: () => void;
}) {
  const [targets, setTargets] = useState<PreviewTarget[]>([]);
  const [selection, setSelection] = useState<string | null>(() => {
    try { return window.localStorage.getItem(`cockpit.previewSelection.${tabId}`); } catch { return null; }
  });
  const [chooser, setChooser] = useState(false);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [fileCandidates, setFileCandidates] = useState<PreviewFileCandidate[]>([]);
  const [unresolved, setUnresolved] = useState(false);
  const [viewports, setViewports] = useState<Record<string, PreviewViewport>>(() => {
    try {
      const parsed = previewViewportsSchema.safeParse(JSON.parse(window.localStorage.getItem(`cockpit.previewViewports.${tabId}`) ?? "{}"));
      return parsed.success ? parsed.data : {};
    } catch { return {}; }
  });
  const [scale, setScale] = useState(1);
  const [baselines, setBaselines] = useState<Record<string, PreviewCapture & { automatic?: boolean }>>({});
  const [comparison, setComparison] = useState<VisualComparisonData>();
  const [capturing, setCapturing] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const capturingRef = useRef(false);
  const baselineIds = useRef(new Set<string>());
  const autoBaselineRef = useRef<(id: string) => void>(() => undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const currentIdRef = useRef<string | null>(null);
  const autoAdded = useRef(new Set<string>());
  const autoPending = useRef(false);
  const autoOpenRef = useRef({ enabled: autoOpen, open: onAutoOpen });
  const selected = targets.find((target) => target.id === selection) ?? targets[0];
  const selectedId = selected?.id;
  const selectedRevision = selected?.revision;
  const viewport = selected?.kind === "web" ? viewports[selected.id] : undefined;
  const canPresent = visible && !chooser && !comparison && Boolean(selected) && !busy;

  const accept = useCallback((snapshot: PreviewSnapshot): void => {
    if (snapshot.tabId !== tabId) return;
    setTargets(snapshot.targets); setLoaded(true);
  }, [tabId]);
  const request = useCallback(async (input: PreviewRequest): Promise<boolean> => {
    try {
      const result = await cockpitApi.preview!.request(input);
      if (result.ok) {
        accept(result.value);
        if (result.value.focusId) setSelection(result.value.focusId);
        return true;
      } else setError(result.error === "unsupported" ? t("この形式はプレビューできません。") : t("開けませんでした。ファイルの場所やURLを確認してください。"));
    } catch { setError(t("プレビューを読み込めませんでした。もう一度お試しください。")); }
    return false;
  }, [accept]);

  useEffect(() => { autoOpenRef.current = { enabled: autoOpen, open: onAutoOpen }; }, [autoOpen, onAutoOpen]);
  useEffect(() => {
    const remove = cockpitApi.preview!.onChanged(accept);
    void Promise.resolve().then(() => request({ action: "list", tabId }));
    return remove;
  }, [accept, request, tabId]);
  useEffect(() => {
    if (!selectedId) return;
    try { window.localStorage.setItem(`cockpit.previewSelection.${tabId}`, selectedId); } catch { /* Keep in-memory selection. */ }
    stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, tabId]);
  useEffect(() => {
    try { window.localStorage.setItem(`cockpit.previewViewports.${tabId}`, JSON.stringify(viewports)); } catch { /* Keep in-memory sizes. */ }
  }, [tabId, viewports]);

  const sessionKey = sessionIds.join("|");
  useEffect(() => {
    const allowed = new Set(sessionKey.split("|"));
    const tails = new Map<string, string>();
    const checked = new Map<string, number>();
    const pending = new Map<string, Set<string>>();
    const timers = new Map<string, number>();
    const urlTimers = new Map<string, number>();
    let disposed = false;
    const flush = async (sessionId: string): Promise<void> => {
      timers.delete(sessionId); const paths = [...(pending.get(sessionId) ?? [])].slice(-12); pending.delete(sessionId);
      if (!paths.length) return;
      try {
        const result = await cockpitApi.preview!.request({ action: "discover", tabId, sessionId, paths });
        if (disposed || !result.ok || !result.discovery) return;
        const discovery = result.discovery;
        setFileCandidates((current) => [...new Map([...current, ...discovery.files].map((file) => [file.source, file])).values()].slice(-10));
        setUnresolved(discovery.unresolved);
      } catch { if (!disposed) setUnresolved(true); }
    };
    const remove = cockpitApi.onPtyData((event) => {
      if (!allowed.has(event.sessionId)) return;
      const text = `${tails.get(event.sessionId) ?? ""}${event.data}`;
      tails.set(event.sessionId, text.slice(-4096));
      window.clearTimeout(urlTimers.get(event.sessionId));
      urlTimers.set(event.sessionId, window.setTimeout(() => {
        urlTimers.delete(event.sessionId);
        const urls = previewUrls(tails.get(event.sessionId) ?? "");
        if (urls.length) setCandidates((current) => [...new Set([...urls, ...current])].slice(0, 5));
      }, 300));
      for (const path of previewPaths(text)) {
        const key = `${event.sessionId}:${path}`;
        if (Date.now() - (checked.get(key) ?? 0) < 2000) continue;
        checked.set(key, Date.now());
        if (checked.size > 256) checked.delete(checked.keys().next().value!);
        const list = pending.get(event.sessionId) ?? new Set<string>(); list.add(path); pending.set(event.sessionId, list);
      }
      if (pending.has(event.sessionId) && !timers.has(event.sessionId)) timers.set(event.sessionId, window.setTimeout(() => { void flush(event.sessionId); }, 250));
    });
    return () => {
      disposed = true; remove();
      for (const timer of [...timers.values(), ...urlTimers.values()]) window.clearTimeout(timer);
    };
  }, [sessionKey, tabId]);
  useEffect(() => {
    const first = candidates.find((url) => !autoAdded.current.has(url))
      ?? fileCandidates.find((file) => !autoAdded.current.has(file.source))?.source;
    if ((!visible && !autoOpen) || !loaded || targets.length || !first || chooser || busy || autoPending.current) return;
    autoAdded.current.add(first);
    autoPending.current = true;
    void request({ action: "add", tabId, source: first }).then((added) => {
      const current = autoOpenRef.current;
      if (added && current.enabled) current.open();
    }).finally(() => { autoPending.current = false; });
  }, [autoOpen, busy, candidates, chooser, fileCandidates, loaded, request, tabId, targets.length, visible]);

  useEffect(() => {
    const api = cockpitApi.preview!;
    const surface = surfaceRef.current;
    if (!canPresent || !selectedId || !surface) {
      void api.request({ action: "hide", tabId }); currentIdRef.current = null;
      return;
    }
    let disposed = false;
    const present = (): void => {
      const box = surface.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || box.x < 0 || box.y < 0) return;
      currentIdRef.current = selectedId;
      const frame = previewFrame({
        x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height),
      }, viewport);
      setScale(frame.scale);
      void api.request({ action: "present", tabId, targetId: selectedId, bounds: frame.bounds, viewport }).then((result) => {
        if (result.ok && !disposed && currentIdRef.current === selectedId) autoBaselineRef.current(selectedId);
      }).catch(() => undefined);
    };
    const observer = new ResizeObserver(present);
    observer.observe(surface);
    window.addEventListener("resize", present);
    window.addEventListener("scroll", present, true);
    present();
    return () => {
      disposed = true;
      observer.disconnect(); window.removeEventListener("resize", present); window.removeEventListener("scroll", present, true);
      void api.request({ action: "hide", tabId });
    };
  }, [canPresent, selectedId, selectedRevision, tabId, viewport]);

  const add = async (pick: boolean, value = source): Promise<void> => {
    setError(undefined); setBusy(true);
    await request(pick ? { action: "pick", tabId } : { action: "add", tabId, source: value.trim() });
    setBusy(false); setChooser(false); setSource("");
  };
  const closeTarget = (id: string): void => {
    const index = targets.findIndex((target) => target.id === id);
    if (selected?.id === id) setSelection(targets[index + 1]?.id ?? targets[index - 1]?.id ?? null);
    setViewports((current) => { const next = { ...current }; delete next[id]; return next; });
    setBaselines((current) => { const next = { ...current }; delete next[id]; return next; });
    baselineIds.current.delete(id);
    void request({ action: "remove", tabId, targetId: id });
  };
  const capture = async (compare: boolean, automatic = false): Promise<void> => {
    if (!selected || capturingRef.current) return;
    const baseline = baselines[selected.id];
    capturingRef.current = true;
    setCapturing(true); setAutoSaving(automatic); if (!automatic) setError(undefined);
    try {
      const expected = compare && selected.kind === "web" ? previewViewportSchema.safeParse(baseline?.viewport) : undefined;
      const take = () => cockpitApi.preview!.request({ action: "capture", tabId, targetId: selected.id, position: compare ? baseline?.position : undefined, baseline: !compare,
        viewport: expected?.success ? expected.data : undefined }).catch(() => undefined);
      let result = await take();
      for (let attempt = 0; automatic && (!result?.ok || !result.capture) && attempt < 2 && currentIdRef.current === selected.id; attempt++) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
        if (currentIdRef.current !== selected.id) break;
        result = await take();
      }
      if (!result?.ok || !result.capture) throw new Error("Capture unavailable");
      const captured = result.capture;
      if (compare && baseline) {
        const before = result.comparison?.before ?? baseline, after = result.comparison?.after ?? captured;
        setComparison({ name: selected.name, kind: selected.kind, before, after, regions: await compareCaptures(before, after), versions: result.versions,
          page: before.page && after.page ? { tabId, targetId: selected.id, changedElements: after.page.changedElements } : undefined,
          pageUnavailable: ["web", "markdown"].includes(selected.kind) && (!before.page || !after.page) });
      }
      else {
        baselineIds.current.add(selected.id);
        setBaselines((current) => ({ ...current, [selected.id]: { ...captured, automatic } }));
      }
    } catch { if (!automatic) setError(t("比較画像を作れませんでした。プレビューの読み込み後にもう一度お試しください。")); }
    finally { capturingRef.current = false; setCapturing(false); setAutoSaving(false); }
  };
  useEffect(() => {
    autoBaselineRef.current = (id) => {
      if (selected?.id === id && ["web", "markdown"].includes(selected.kind) && !baselineIds.current.has(id)) void capture(false, true);
    };
  });

  return <div className="preview-panel" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={(event) => {
      event.preventDefault(); event.stopPropagation();
      const file = event.dataTransfer.files[0];
      const value = file ? cockpitApi.getPathForFile(file) : event.dataTransfer.getData("text/plain");
      if (value) void add(false, value);
    }}>
    <div className="preview-target-bar">
      <div aria-label={t("プレビュー対象")} className="preview-target-tabs" ref={stripRef} role="tablist">{targets.map((target, index) => {
        const Icon = icons[target.kind];
        return <div className={`preview-target ${selected?.id === target.id ? "is-selected" : ""}`} key={target.id}>
          <button aria-selected={selected?.id === target.id} onClick={() => setSelection(target.id)} role="tab"
            tabIndex={selected?.id === target.id ? 0 : -1} title={target.source} type="button"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? targets[0] : event.key === "End" ? targets.at(-1)!
                : targets[(index + (event.key === "ArrowLeft" ? -1 : 1) + targets.length) % targets.length];
              setSelection(next.id);
              requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus());
            }}><Icon aria-hidden="true" size={13} /><span>{target.name}</span>{target.updated && <span aria-label={t("更新あり")} className="preview-update-dot" />}</button>
          <button aria-label={t("{value0}を閉じる", { value0: target.name })} className="preview-target-close" onClick={() => closeTarget(target.id)} type="button"><X aria-hidden="true" size={12} /></button>
        </div>;
      })}</div>
      <button aria-expanded={chooser} aria-label={t("プレビュー対象を追加")} className="preview-add" onClick={() => setChooser((current) => !current)} type="button"><Plus aria-hidden="true" size={16} /></button>
    </div>
    {chooser && <div aria-label={t("ファイル・URLを追加")} className="preview-chooser" role="dialog" onKeyDown={(event) => { if (event.key === "Escape") setChooser(false); }}>
      <div className="preview-chooser-heading"><strong>{t("ファイル・URLを追加")}</strong><button aria-label={t("閉じる")} onClick={() => setChooser(false)} type="button"><X aria-hidden="true" size={14} /></button></div>
      <button disabled={busy} onClick={() => void add(true)} type="button"><FolderOpen aria-hidden="true" size={16} /><span>{t("ファイルを選ぶ")}</span></button>
      <form onSubmit={(event) => { event.preventDefault(); if (source.trim()) void add(false); }}>
        <label htmlFor={`preview-source-${tabId}`}>{t("localhostのURLまたはファイルパス")}</label>
        <input autoFocus id={`preview-source-${tabId}`} onChange={(event) => setSource(event.target.value)} placeholder="http://localhost:3000" value={source} />
        <button disabled={!source.trim() || busy} type="submit">{t("プレビューを開く")}</button>
      </form>
      {candidates.filter((url) => !targets.some((target) => target.source === url)).map((url) => <button key={url} onClick={() => void add(false, url)} type="button"><Globe aria-hidden="true" size={13} /><span>{url}</span></button>)}
      {fileCandidates.filter((file) => !targets.some((target) => target.source === file.source)).map((file) => <button key={file.source} onClick={() => void add(false, file.source)} title={file.source} type="button"><FileText aria-hidden="true" size={13} /><span>{file.label}</span></button>)}
      {unresolved && <p role="status">{t("場所を特定できない成果物があります。「ファイルを選ぶ」から開いてください。")}</p>}
    </div>}
    {error && <div className="preview-native-error" role="alert">{error}<button aria-label={t("閉じる")} onClick={() => setError(undefined)} type="button"><X aria-hidden="true" size={13} /></button></div>}
    {!selected ? <div className="preview-empty"><Globe aria-hidden="true" size={28} /><span className="preview-eyebrow">YOUR WORK, IN VIEW</span>
      <h2>{t("作ったものを、ここで見る。")}</h2><p>{t("HTML・Markdown・画像・PDF・MP4を開けます。")}</p>
      <div className="preview-native-empty-actions"><button disabled={busy} onClick={() => void add(true)} type="button"><FolderOpen aria-hidden="true" size={15} />{t("ファイルを選ぶ")}</button><button onClick={() => setChooser(true)} type="button"><Globe aria-hidden="true" size={15} />{t("URLを指定")}</button></div>
      {fileCandidates.length > 0 && <div className="preview-detected-files"><strong>{t("CLI出力から見つかったファイル")}</strong>{fileCandidates.map((file) => <button key={file.source} onClick={() => void add(false, file.source)} title={file.source} type="button"><FileText aria-hidden="true" size={13} />{file.label}</button>)}</div>}
      {unresolved && <p role="status">{t("場所を特定できない成果物があります。「ファイルを選ぶ」から開いてください。")}</p>}
      <small>{t("最初の成果物は自動表示します。閉じた後は自動で開きません。")}</small></div>
      : <>
        <div className="preview-location"><span>{selected.kind.toUpperCase()}</span><code title={selected.source}>{selected.source}</code>
          <button aria-label={t("再読み込み")} onClick={() => void request({ action: "refresh", tabId, targetId: selected.id })} type="button"><RefreshCw aria-hidden="true" size={13} /></button>
          {localPreviewUrl(selected.source) && <button aria-label={t("外部ブラウザで開く")} onClick={() => void cockpitApi.openExternalWebLink(selected.source)} type="button"><ExternalLink aria-hidden="true" size={13} /></button>}
        </div>
        {selected.kind === "web" && <ResponsivePreviewControls onChange={(value) => setViewports((current) => {
          const next = { ...current }; if (value) next[selected.id] = value; else delete next[selected.id]; return next;
        })} scale={scale} value={viewport} />}
        {selected.kind !== "video" && <div className="preview-comparison-actions">
          <button disabled={busy || capturing || Boolean(selected.error)} onClick={() => void capture(false)} type="button">{t("基準を保存")}</button>
          <button disabled={busy || capturing || !baselines[selected.id] || Boolean(selected.error)} onClick={() => void capture(true)} type="button">{t("変更を比較")}</button>
          <span role="status">{capturing ? autoSaving ? t("比較の基準を自動保存中…") : t("比較画像を準備中…") : baselines[selected.id]?.automatic ? t("基準を自動保存しました") : baselines[selected.id] ? t("基準を保存しました") : t("修正前の見た目を残して、変更後と比べる")}</span>
        </div>}
        {selected.updated && ["pdf", "video"].includes(selected.kind) && <div className="preview-update-banner" role="status"><span>{t("新しい版ができました")}</span><button onClick={() => void request({ action: "refresh", tabId, targetId: selected.id })} type="button"><RefreshCw aria-hidden="true" size={12} />{t("新しい版を表示")}</button></div>}
        {selected.error && <div className="preview-native-error" role="status">{t("接続先やファイルを確認して、再読み込みしてください。")}</div>}
        <div className={`preview-native-surface${viewport ? " is-responsive" : ""}`} data-testid="preview-surface" ref={surfaceRef}>{busy ? t("読み込み中…") : selected.error ? t("再読み込みで表示をやり直せます。") : t("プレビューを読み込んでいます…")}</div>
        <footer className="preview-footer"><span>{["pdf", "video"].includes(selected.kind) ? t("新しい版は、自分のタイミングで表示") : t("保存すると表示も更新")}</span><span>{targets.length} / 20</span></footer>
      </>}
    {comparison && visible && <VisualComparison data={comparison} onClose={() => setComparison(undefined)} />}
  </div>;
}
