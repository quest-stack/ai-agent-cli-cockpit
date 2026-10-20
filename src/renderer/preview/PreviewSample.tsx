import { ArrowRight, Image, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { t } from "../../shared/i18n";

import type { PreviewSampleId } from "./prototype-state";

function SampleArtwork({ version = 1 }: { version?: number }) {
  return <svg aria-label={t("机と椅子のある、緑の部屋のイラスト")} className="preview-artwork" role="img" viewBox="0 0 640 480">
    <rect width="640" height="480" fill={version % 2 === 1 ? "#e9e6d7" : "#e3e9df"} />
    <path d="M0 360H640V480H0Z" fill="#c4af93" /><path d="M0 360H640M160 360L80 480M360 360L400 480M560 360L640 480" stroke="#b19a7d" strokeWidth="2" />
    <path d="M75 75H360V300H75Z" fill="#faf9f2" /><path d="M88 88H347V287H88Z" fill="#bdd4c9" />
    <path d="M88 220L155 153L215 215L290 132L347 185V287H88Z" fill="#8eaaa0" /><path d="M215 88V287M88 185H347" stroke="#faf9f2" strokeWidth="12" />
    <path d="M130 345L110 435M490 345L510 435" stroke="#735137" strokeWidth="16" /><rect x="100" y="325" width="435" height="22" rx="9" fill="#aa7446" />
    <rect x="268" y="270" width="140" height="82" rx="24" fill="#739183" /><path d="M272 348V410M402 348V410M270 385H405" stroke="#637d70" strokeWidth="12" />
    <rect x="565" y="338" width="55" height="66" rx="4" fill="#d9bc91" /><path d="M592 340V208M592 270C540 275 536 235 538 224C580 223 595 242 592 270ZM592 244C630 245 638 218 634 205C605 205 594 222 592 244Z" fill="#60866b" stroke="#54775d" strokeWidth="5" />
    <rect x="451" y="302" width="34" height="20" rx="5" fill="#fffcf0" /><path d="M485 307C505 301 506 319 485 317" fill="none" stroke="#fffcf0" strokeWidth="5" />
  </svg>;
}

function VideoSample({ version, visible }: { version: number; visible: boolean }) {
  const videoRef = useRef<globalThis.HTMLVideoElement>(null);
  const positionRef = useRef(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible) videoRef.current?.pause();
  }, [visible]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Sample version replacement follows the same explicit, paused rule as the proposed player.
    positionRef.current = video.currentTime || positionRef.current;
    video.pause();
    video.load();
  }, [version]);

  return <div className="preview-video-shell">
    <div className="preview-media-caption"><span>{t("操作ガイド")}</span><strong>Capture. Paste. Ask.</strong><p>{t("動画を見ながら、AIに修正を頼む。")}</p></div>
    <video controls data-testid="preview-video" muted onError={() => setFailed(true)}
      onLoadedMetadata={() => { const video = videoRef.current; if (video) video.currentTime = Math.min(positionRef.current, video.duration); }}
      onTimeUpdate={() => { const video = videoRef.current; if (video && video.readyState >= 2) positionRef.current = video.currentTime; }} playsInline preload="metadata" ref={videoRef}
      src={`/__preview-sample/walkthrough.mp4?version=${version}`} />
    {failed && <p role="alert">{t("サンプル動画を読み込めませんでした。試作サーバーで開き直してください。")}</p>}
    <p className="preview-video-note"><VolumeX aria-hidden="true" size={13} />{t("サンプルは消音で開始。切り替えると一時停止します。")}</p>
  </div>;
}

export function PreviewSample({ id, version, visible }: { id: PreviewSampleId; version: number; visible: boolean }) {
  const [zoom, setZoom] = useState(1);
  const [contact, setContact] = useState(false);

  if (id === "web") return <div className="preview-web-sample">
    <nav><strong>SAMPLE STUDIO</strong><button onClick={() => setContact((current) => !current)} type="button">{contact ? t("トップへ") : t("お問い合わせ")}</button></nav>
    {contact ? <div className="preview-web-contact"><span>LET’S TALK</span><h2>{t("次の仕事を、一緒に。")}</h2><p>{t("ボタン操作も、プレビュー内で確認できます。")}</p><button onClick={() => setContact(false)} type="button">{t("トップへ戻る")}<ArrowRight aria-hidden="true" size={14} /></button></div>
      : <><section><div><span>SPACE FOR YOUR IDEAS</span><h2>{t("毎日の仕事に、")}<br />{t("心地よい余白を。")}</h2><p>{t("働く場所から、毎日を整える。あなたに合う空間づくりを一緒に。")}</p><button onClick={() => setContact(true)} type="button">{t("サービスを見る")}<ArrowRight aria-hidden="true" size={14} /></button></div><SampleArtwork version={version} /></section><footer><span>01 / WORKSPACE</span><p>{t("小さな変化が、いい仕事につながる。")}</p></footer></>}
  </div>;
  if (id === "markdown") return <article className="preview-markdown-sample"><span className="preview-eyebrow">TEAM NOTE · v{version}</span><h1>{t("スクショで伝える、画面の修正依頼")}</h1><p>{t("文字だけでは説明しにくい違和感も、画面を添えると伝わりやすくなります。")}</p><h2>{t("3つの手順")}</h2><ol><li>{t("気になる画面をスクリーンショットで撮る。")}</li><li>{t("CockpitのAIペインに貼り付ける。")}</li><li>{t("直したい場所をひとことで添える。")}</li></ol><blockquote>{t("「この見出しと画像の重なりを直して。スマホ幅でも確認して」")}</blockquote><h2>{t("仕上がりを確認する")}</h2><p>{t("会話の隣にプレビューを開いて、修正した画面を確かめます。別の成果物もタブで切り替えられます。")}</p><table><thead><tr><th>{t("対象")}</th><th>{t("確認すること")}</th></tr></thead><tbody><tr><td>HTML</td><td>{t("配置とボタンの動き")}</td></tr><tr><td>PDF / MP4</td><td>{t("内容を確認して、新しい版へ切り替え")}</td></tr></tbody></table><pre><code>sample-project/<br />  index.html<br />  guide.md<br />  overview.pdf<br />  walkthrough.mp4</code></pre></article>;
  if (id === "image") return <div className="preview-image-sample"><div className="preview-image-toolbar"><Image aria-hidden="true" size={13} /><span>640 × 480 · SVG</span><button onClick={() => setZoom((current) => current === 1 ? 1.5 : 1)} type="button">{zoom === 1 ? t("拡大する") : t("全体を表示")}</button></div><div className="preview-image-canvas"><div style={{ width: `${zoom * 100}%` }}><SampleArtwork version={version} /></div></div></div>;
  if (id === "pdf") return <div className="preview-pdf-sample">{visible && <iframe className="preview-pdf-frame" key={version} src={`/__preview-sample/overview.pdf?version=${version}#view=FitH`} title={t("PDFサンプル")} />}</div>;
  return <VideoSample version={version} visible={visible} />;
}
