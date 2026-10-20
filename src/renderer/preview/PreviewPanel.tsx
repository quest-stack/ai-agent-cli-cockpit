import { FileImage, FileText, Globe, Plus, RefreshCw, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../../shared/i18n";
import { PreviewSample } from "./PreviewSample";
import { PREVIEW_SAMPLE_IDS } from "./prototype-state";

import type { PreviewSampleId, PreviewTrialState } from "./prototype-state";

const icons = { web: Globe, markdown: FileText, image: FileImage, pdf: FileText, video: Video };
const names = { web: "sample.studio", markdown: "guide.md", image: "cover.svg", pdf: "overview.pdf", video: "walkthrough.mp4" };
const kinds = { web: "HTML / WEB", markdown: "MARKDOWN", image: "IMAGE", pdf: "PDF", video: "MP4" };
const emptyVersions: Record<PreviewSampleId, number> = { web: 1, markdown: 1, image: 1, pdf: 1, video: 1 };

interface PreviewPanelProps {
  onChange: (updater: (current: PreviewTrialState) => PreviewTrialState) => void;
  state: PreviewTrialState;
  tabId: string;
  visible: boolean;
}

export function PreviewPanel({ onChange, state, tabId, visible }: PreviewPanelProps) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [versions, setVersions] = useState(emptyVersions);
  const [applied, setApplied] = useState(emptyVersions);
  const stripRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const selected = state.selected;
  const manual = selected === "pdf" || selected === "video";
  const pending = selected !== null && versions[selected] > applied[selected];

  useEffect(() => {
    if (!visible) return;
    stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [visible, selected]);

  const add = (id: PreviewSampleId): void => {
    onChange((current) => ({ ...current, selected: id,
      targets: current.targets.includes(id) ? current.targets : [...current.targets, id] }));
    setChooserOpen(false);
    // The selected target, rather than the CLI, receives focus after a deliberate add.
    requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus());
  };
  const remove = (id: PreviewSampleId): void => {
    onChange((current) => {
      const index = current.targets.indexOf(id);
      const targets = current.targets.filter((target) => target !== id);
      return { ...current, targets, selected: current.selected === id ? targets[Math.min(index, targets.length - 1)] ?? null : current.selected };
    });
    requestAnimationFrame(() => {
      const target = stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']");
      (target ?? addRef.current)?.focus();
    });
  };
  const simulateSave = (): void => {
    // Fixed sample versions only. No filesystem watcher or terminal-output detector exists yet.
    const next = Object.fromEntries(PREVIEW_SAMPLE_IDS.map((id) => [id, versions[id] + 1])) as Record<PreviewSampleId, number>;
    setVersions(next);
    setApplied((current) => ({ ...current, web: next.web, markdown: next.markdown, image: next.image }));
  };

  return (
    <div className="preview-panel">
      <div className="preview-target-bar">
        <div aria-label={t("プレビュー対象")} className="preview-target-tabs" ref={stripRef} role="tablist">
          {state.targets.map((id) => {
            const Icon = icons[id];
            return <div className={`preview-target ${selected === id ? "is-selected" : ""}`} key={id}>
              <button aria-controls={`preview-content-${tabId}-${id}`} aria-selected={selected === id}
                id={`preview-target-${tabId}-${id}`} onClick={() => onChange((current) => ({ ...current, selected: id }))}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const index = state.targets.indexOf(id);
                  const next = event.key === "Home" ? state.targets[0] : event.key === "End" ? state.targets.at(-1)!
                    : state.targets[(index + (event.key === "ArrowLeft" ? -1 : 1) + state.targets.length) % state.targets.length];
                  onChange((current) => ({ ...current, selected: next }));
                  requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus());
                }}
                role="tab" tabIndex={selected === id ? 0 : -1} title={`${names[id]} · ${kinds[id]}`} type="button">
                <Icon aria-hidden="true" size={13} /><span>{names[id]}</span>
                {versions[id] > applied[id] && <span aria-label={t("更新あり")} className="preview-update-dot" />}
              </button>
              <button aria-label={t("{value0}を閉じる", { value0: names[id] })} className="preview-target-close" onClick={() => remove(id)} type="button"><X aria-hidden="true" size={12} /></button>
            </div>;
          })}
        </div>
        <button aria-expanded={chooserOpen} aria-label={t("プレビュー対象を追加")}
          className="preview-add" onClick={() => setChooserOpen((current) => !current)} ref={addRef} type="button"><Plus aria-hidden="true" size={16} /></button>
      </div>
      {chooserOpen && <div aria-label={t("サンプルを選ぶ")} className="preview-chooser" role="dialog"
        onKeyDown={(event) => { if (event.key === "Escape") { setChooserOpen(false); addRef.current?.focus(); } }}>
        <div className="preview-chooser-heading"><strong>{t("サンプルを選ぶ")}</strong><button aria-label={t("閉じる")} onClick={() => { setChooserOpen(false); addRef.current?.focus(); }} type="button"><X aria-hidden="true" size={14} /></button></div>
        {PREVIEW_SAMPLE_IDS.map((id) => { const Icon = icons[id]; return <button key={id} onClick={() => add(id)} type="button"><Icon aria-hidden="true" size={16} /><span>{names[id]}<small>{kinds[id]}</small></span><Plus aria-hidden="true" size={13} /></button>; })}
        <p>{t("実ファイル・URLの追加と保存検知は、次の実装で接続します。")}</p>
      </div>}
      {!selected ? <div className="preview-empty">
        <div className="preview-empty-mark"><Globe aria-hidden="true" size={28} /></div>
        <span className="preview-eyebrow">YOUR WORK, IN VIEW</span>
        <h2>{t("作ったものを、ここで見る。")}</h2>
        <p>{t("AIとの会話を続けながら、仕上がりを確認できます。")}</p>
        <div className="preview-sample-list">{PREVIEW_SAMPLE_IDS.map((id) => { const Icon = icons[id]; return <button key={id} onClick={() => add(id)} type="button"><Icon aria-hidden="true" size={17} /><span>{names[id]}<small>{kinds[id]}</small></span><Plus aria-hidden="true" size={14} /></button>; })}</div>
        <small>{t("UI試作です。まずはサンプルで切り替えを試せます。")}</small>
      </div> : <>
        <div className="preview-location"><span>{kinds[selected]}</span><code>{selected === "web" ? "http://localhost:3000" : `sample-project / ${names[selected]}`}</code><span>v{applied[selected]}</span></div>
        {manual && pending && <div className="preview-update-banner" role="status"><span>{t("新しい版ができました")}</span><button onClick={() => setApplied((current) => ({ ...current, [selected]: versions[selected] }))} type="button"><RefreshCw aria-hidden="true" size={12} />{t("新しい版を表示")}</button></div>}
        <div className="preview-content">
          {state.targets.map((id) => <div aria-labelledby={`preview-target-${tabId}-${id}`} className="preview-content-panel"
            hidden={selected !== id} id={`preview-content-${tabId}-${id}`} key={id} role="tabpanel" tabIndex={0}>
            <PreviewSample id={id} version={applied[id]} visible={visible && selected === id} />
          </div>)}
        </div>
        <footer className="preview-footer"><span role="status">{manual ? t("新しい版は、自分のタイミングで表示") : t("保存すると表示も更新")}</span><button onClick={simulateSave} title={t("開いているサンプル全体の更新を再現します。選択中の対象は変わりません。")} type="button"><RefreshCw aria-hidden="true" size={12} />{t("更新を試す")}</button></footer>
      </>}
    </div>
  );
}
