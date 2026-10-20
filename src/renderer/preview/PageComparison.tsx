import { useEffect, useRef, useState } from "react";

import { t } from "../../shared/i18n";
import { cockpitApi } from "../bridge";

import type { VisualComparisonData } from "./VisualComparison";

export function PageComparison({ data, highlight }: { data: VisualComparisonData; highlight: boolean }) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const page = data.page!;
  const highlightRef = useRef(highlight);
  useEffect(() => { highlightRef.current = highlight; }, [highlight]);

  useEffect(() => {
    let disposed = false;
    let presenting = false;
    let again = false;
    const present = async (): Promise<void> => {
      if (disposed) return;
      if (presenting) { again = true; return; }
      const before = beforeRef.current?.getBoundingClientRect();
      const after = afterRef.current?.getBoundingClientRect();
      if (!before || !after || before.width < 2 || after.width < 2) return;
      presenting = true;
      const bounds = (box: { x: number; y: number; width: number; height: number }) => ({ x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)), width: Math.max(1, Math.floor(box.width)), height: Math.max(1, Math.floor(box.height)) });
      try {
        const result = await cockpitApi.preview!.request({ action: "review-pages", tabId: page.tabId, targetId: page.targetId,
          before: bounds(before), after: bounds(after), highlight: highlightRef.current });
        if (!disposed) { setFailed(!result.ok); setReady(result.ok); }
      } catch { if (!disposed) setFailed(true); }
      finally { presenting = false; if (again && !disposed) { again = false; void present(); } }
    };
    const observer = new ResizeObserver(() => { void present(); });
    if (beforeRef.current) observer.observe(beforeRef.current);
    if (afterRef.current) observer.observe(afterRef.current);
    const update = (): void => { void present(); };
    window.addEventListener("resize", update);
    window.addEventListener("cockpit:review-highlight", update);
    void present();
    return () => {
      disposed = true; observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("cockpit:review-highlight", update);
      void cockpitApi.preview!.request({ action: "hide-review", tabId: page.tabId, targetId: page.targetId });
    };
  }, [page.tabId, page.targetId]);
  useEffect(() => { window.dispatchEvent(new window.Event("cockpit:review-highlight")); }, [highlight]);

  return <div className="visual-comparison-images" data-testid="comparison-pages" data-ready={ready || undefined}>
    {[data.before, data.after].map((capture, index) => <section className="visual-comparison-side" key={index}>
      <h3>{data.versions?.length ? index === 0 ? t("左の版") : t("右の版") : index === 0 ? t("変更前（保存した基準）") : t("変更後（現在）")}<small>{t("ページ全体・スクロール可")} · {new Date(capture.capturedAt).toLocaleTimeString()}</small></h3>
      <div className="comparison-page-surface" data-testid={`comparison-page-${index === 0 ? "before" : "after"}`} ref={index === 0 ? beforeRef : afterRef}>
        {failed ? <p role="alert">{t("ページを表示できませんでした。「画像」に切り替えて確認できます。")}</p> : <p>{t("比較用ページを読み込んでいます…")}</p>}
      </div>
    </section>)}
  </div>;
}
