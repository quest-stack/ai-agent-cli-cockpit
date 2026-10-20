import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t } from "../../shared/i18n";
import { visualChanges } from "./visual-diff";
import { PageComparison } from "./PageComparison";
import { cockpitApi } from "../bridge";

import type { PreviewCapture, PreviewKind, PreviewVersion } from "../../shared/preview";
import type { ChangeRegion } from "./visual-diff";

export interface VisualComparisonData {
  name: string;
  kind: PreviewKind;
  before: PreviewCapture;
  after: PreviewCapture;
  regions?: ChangeRegion[];
  page?: { tabId: string; targetId: string; changedElements: number };
  pageUnavailable?: boolean;
  versions?: PreviewVersion[];
}

export async function compareCaptures(before: PreviewCapture, after: PreviewCapture): Promise<ChangeRegion[] | undefined> {
  if (before.viewport.width !== after.viewport.width || before.viewport.height !== after.viewport.height
    || Math.abs(before.position.x - after.position.x) > 1 || Math.abs(before.position.y - after.position.y) > 1) return undefined;
  if ((before.pdf || after.pdf) && (before.pdf?.page === undefined || after.pdf?.page === undefined || before.pdf?.zoom === undefined
    || after.pdf?.zoom === undefined || before.pdf.page !== after.pdf.page || Math.abs(before.pdf.zoom - after.pdf.zoom) > 0.001)) return undefined;
  const images = await Promise.all([before, after].map(async (capture) => {
    const image = new window.Image(); image.src = capture.image; await image.decode(); return image;
  }));
  const canvas = document.createElement("canvas"); canvas.width = before.width; canvas.height = before.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(images[0], 0, 0, canvas.width, canvas.height);
  const initial = context.getImageData(0, 0, canvas.width, canvas.height).data;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(images[1], 0, 0, canvas.width, canvas.height);
  const ignoredTop = Math.min(before.height, Math.ceil(Math.max(before.pdf?.ignoredTop ?? 0, (after.pdf?.ignoredTop ?? 0) * before.height / after.height)));
  return visualChanges(initial, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, ignoredTop);
}

export function VisualComparison({ data: initial, onClose }: { data: VisualComparisonData; onClose: () => void }) {
  const [data, setData] = useState(initial);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panes = useRef<Array<HTMLDivElement | null>>([]);
  const [highlight, setHighlight] = useState(true);
  const [original, setOriginal] = useState(false);
  const [mode, setMode] = useState<"page" | "image">(data.page ? "page" : "image");
  const choose = async (beforeId: string, afterId: string): Promise<void> => {
    if (!data.page || selecting) return;
    setSelecting(true); setSelectionError(false);
    try {
      const result = await cockpitApi.preview!.request({ action: "compare-versions", tabId: data.page.tabId, targetId: data.page.targetId, beforeId, afterId });
      if (!result.ok || !result.comparison) throw new Error("History unavailable");
      const { before, after, changedElements } = result.comparison;
      setData({ ...data, before, after, versions: result.versions, regions: await compareCaptures(before, after), page: { ...data.page, changedElements } });
    } catch { setSelectionError(true); }
    finally { setSelecting(false); }
  };
  useEffect(() => {
    const dialog = dialogRef.current; const previous = document.activeElement;
    dialog?.showModal(); closeRef.current?.focus();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  return createPortal(<dialog aria-labelledby="visual-comparison-title" className="visual-comparison-dialog" data-testid="visual-comparison"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => event.stopPropagation()} ref={dialogRef}>
    <header className="visual-comparison-heading"><div><h2 id="visual-comparison-title">{t("変更を見比べる")}</h2><p>{data.name}</p></div>
      <button aria-label={t("比較を閉じる")} className="button-muted" onClick={onClose} ref={closeRef} type="button"><X aria-hidden="true" size={18} /></button></header>
    <div className="visual-comparison-toolbar">
      {data.page && Boolean(data.versions?.length) && <div className="comparison-history">
        {["before", "after"].map((side) => <label key={side}>{side === "before" ? t("左の版") : t("右の版")}
          <select aria-label={side === "before" ? t("左の版") : t("右の版")} disabled={selecting} value={(side === "before" ? data.before : data.after).page?.versionId}
            onChange={(event) => void choose(side === "before" ? event.target.value : data.before.page!.versionId!, side === "after" ? event.target.value : data.after.page!.versionId!)}>
            {data.versions?.map((version) => <option key={version.id} value={version.id}>v{version.sequence} · {new Date(version.capturedAt).toLocaleTimeString()}</option>)}
          </select></label>)}
      </div>}
      {data.page && <div aria-label={t("比較の表示方法")} className="comparison-modes"><button aria-pressed={mode === "page"} onClick={() => setMode("page")} type="button">{t("ページ全体")}</button><button aria-pressed={mode === "image"} onClick={() => setMode("image")} type="button">{t("画像")}</button></div>}
      <label><input checked={highlight} disabled={mode === "image" && !data.regions} onChange={(event) => setHighlight(event.target.checked)} type="checkbox" />{t("変更箇所を強調")}</label>
      {mode === "image" && <label><input checked={original} onChange={(event) => setOriginal(event.target.checked)} type="checkbox" />{t("画像を原寸で表示")}</label>}
      <span role="status">{data.pageUnavailable && mode === "image" ? t("ページ全体を保存できなかったため、画像で比較しています。")
        : mode === "page" ? data.page?.changedElements ? t("変更した要素を囲んでいます。左右のページをスクロールできます。") : t("変更した要素はありません。左右のページをスクロールできます。")
        : !data.regions ? t("同じ表示条件で比較できないため、強調表示はオフです。")
        : data.regions.length ? t("変化した範囲を色で囲んでいます。") : t("強調する差分はありません。")}</span>
    </div>
    {selectionError && <p role="alert">{t("履歴を読み込めませんでした。比較を開き直してください。")}</p>}
    {mode === "page" && data.page ? <PageComparison key={`${data.before.page?.versionId}-${data.after.page?.versionId}`} data={data} highlight={highlight} /> : <div className="visual-comparison-images">{[data.before, data.after].map((capture, index) => <section className="visual-comparison-side" key={index}>
      <h3>{data.versions?.length ? index === 0 ? t("左の版") : t("右の版") : index === 0 ? t("変更前（保存した基準）") : t("変更後（現在）")}<small>{capture.viewport.width} × {capture.viewport.height} · {new Date(capture.capturedAt).toLocaleTimeString()}</small>
        {capture.pdf?.page !== undefined && capture.pdf.zoom !== undefined && <small>{t("{value0}ページ · {value1}%", { value0: capture.pdf.page, value1: Math.round(capture.pdf.zoom * 100) })}</small>}</h3>
      <div className="visual-comparison-scroll" onScroll={(event) => {
        const other = panes.current[index === 0 ? 1 : 0]; if (!other) return;
        const current = event.currentTarget;
        const y = current.scrollTop / Math.max(1, current.scrollHeight - current.clientHeight);
        const x = current.scrollLeft / Math.max(1, current.scrollWidth - current.clientWidth);
        const top = y * (other.scrollHeight - other.clientHeight); const left = x * (other.scrollWidth - other.clientWidth);
        if (Math.abs(other.scrollTop - top) > 1) other.scrollTop = top;
        if (Math.abs(other.scrollLeft - left) > 1) other.scrollLeft = left;
      }} ref={(node) => { panes.current[index] = node; }}>
        <div className="visual-comparison-canvas" style={{ width: original ? capture.width : "100%" }}>
          <img alt={index === 0 ? t("変更前のプレビュー") : t("変更後のプレビュー")} draggable={false} src={capture.image} />
          {highlight && data.regions?.map((region, regionIndex) => <span aria-hidden="true" className="visual-diff-region" data-testid="visual-diff-region" key={regionIndex}
            style={{ left: `${region.x / data.before.width * 100}%`, top: `${region.y / data.before.height * 100}%`, width: `${region.width / data.before.width * 100}%`, height: `${region.height / data.before.height * 100}%` }} />)}
        </div>
      </div>
    </section>)}</div>}
    <footer>{mode === "page" ? t("保存した前後のページを表示しています。リンク先への移動や動作の比較には使いません。") : data.kind === "pdf" ? t("PDFは同じページ・倍率を表示して比較してください。") : t("表示中の範囲を、保存した基準と比較しています。")}
      <span>{mode === "page" ? t("比較用ページは、このアプリ専用の一時領域だけで扱います。") : t("比較画像はこのアプリ内だけで処理し、外部へ送信しません。")}</span></footer>
  </dialog>, document.body);
}
