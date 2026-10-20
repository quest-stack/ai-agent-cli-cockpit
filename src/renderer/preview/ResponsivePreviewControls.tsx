import { RotateCw } from "lucide-react";
import { useState } from "react";

import { t } from "../../shared/i18n";
import { previewViewportPresets, previewViewportSchema } from "../../shared/preview";

import type { PreviewViewport } from "../../shared/preview";

function SizeForm({ value, onChange }: { value?: PreviewViewport; onChange: (value?: PreviewViewport) => void }) {
  const [width, setWidth] = useState(String(value?.width ?? 1440));
  const [height, setHeight] = useState(String(value?.height ?? 900));
  return <form className="preview-viewport-size" onSubmit={(event) => {
    event.preventDefault();
    const parsed = previewViewportSchema.safeParse({ width: Number(width), height: Number(height) });
    if (parsed.success) onChange(parsed.data);
  }}>
    <label>{t("幅")}<input aria-label={t("プレビュー幅（px）")} max={3840} min={240} onChange={(event) => setWidth(event.target.value)} required step={1} type="number" value={width} /></label>
    <span aria-hidden="true">×</span>
    <label>{t("高さ")}<input aria-label={t("プレビュー高さ（px）")} max={3840} min={240} onChange={(event) => setHeight(event.target.value)} required step={1} type="number" value={height} /></label>
    <span>px</span><button type="submit">{t("適用")}</button>
  </form>;
}

export function ResponsivePreviewControls({ value, scale, onChange }: { value?: PreviewViewport; scale: number; onChange: (value?: PreviewViewport) => void }) {
  return <div aria-label={t("レスポンシブ表示")} className="preview-viewport-controls" data-testid="preview-viewport-controls"
    title={t("画面サイズの確認です。端末固有の動作は実機で確認してください。") }>
    <div aria-label={t("表示サイズ")} className="preview-viewport-presets" role="group">
      <button aria-pressed={!value} onClick={() => onChange(undefined)} type="button">{t("自動")}</button>
      {previewViewportPresets.map((preset) => <button aria-pressed={value?.width === preset.width && value?.height === preset.height} key={preset.name}
        onClick={() => onChange({ width: preset.width, height: preset.height })} title={`${preset.width} × ${preset.height} px`} type="button">{preset.name === "desktop" ? t("PC") : preset.name === "tablet" ? t("タブレット") : t("スマホ")}</button>)}
      <button aria-label={t("縦横を入れ替える")} disabled={!value} onClick={() => value && onChange({ width: value.height, height: value.width })} type="button"><RotateCw aria-hidden="true" size={13} /></button>
    </div>
    <SizeForm key={value ? `${value.width}x${value.height}` : "auto"} onChange={onChange} value={value} />
    <output aria-live="polite" className="preview-viewport-scale">{value ? t("表示 {value0}%", { value0: Math.round(scale * 100) }) : t("枠に合わせる")}</output>
  </div>;
}
