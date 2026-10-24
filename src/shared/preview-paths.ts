import { localPreviewUrl } from "./preview";

function cliText(output: string): string {
  return output.slice(-16384)
    // eslint-disable-next-line no-control-regex -- Preserve the destination of a completed OSC 8 terminal hyperlink.
    .replace(/\x1b\]8;[^\x07\x1b;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)([^\r\n]*?)\x1b\]8;[^\x07\x1b;]*;(?:\x07|\x1b\\)/gu,
      (_match, url: string, label: string) => `[${label}](<${url}>)`)
    // eslint-disable-next-line no-control-regex -- Strip the remaining OSC and CSI formatting controls.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

/** Project instructions and housekeeping documents are not generated artifacts. Manual preview remains available. */
export function isPreviewContextFile(source: string): boolean {
  const name = source.split(/[\\/]/u).at(-1) ?? "";
  return /^(?:agents(?:\.override)?|claude(?:\.local)?|design|skill|current_status|handoff(?:[_-].+)?)\.md$/iu.test(name)
    || /^readme(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.md$/iu.test(name);
}

/** Wait for a token terminator so streamed hostnames and ports are never opened mid-token. */
export function previewUrls(output: string): string[] {
  const urls: string[] = [];
  for (const match of cliText(output).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?(?=[\s"'<>])/gu)) {
    const url = localPreviewUrl(match[0].replace(/[),.;]+$/u, ""));
    if (url) urls.push(url);
  }
  return [...new Set(urls.reverse())].slice(0, 5);
}

/** Bounded extraction of supported artifacts from CLI text, not a project scan. */
export function previewPaths(output: string): string[] {
  const text = cliText(output);
  const extension = /\.(?:html?|md|png|jpe?g|gif|webp|svg|pdf|mp4)$/iu;
  const paths = new Map<string, number>();
  const add = (value: string, offset: number): void => {
    const source = value.trim().replace(/:\d+(?::\d+)?$/u, "");
    if (source.length <= 2048 && extension.test(source) && !isPreviewContextFile(source) && !source.includes("://") && !source.includes("\0")) paths.set(source, offset);
  };
  // Decode link destinations rather than treating URL escapes as literal filenames.
  const linked = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\r\n)]+))\s*\)/gu;
  let linkedText = text;
  for (const match of text.matchAll(linked)) {
    let source = (match[1] ?? match[2]).trim().replace(/\s+["'][^"']*["']$/u, "");
    try {
      if (source.startsWith("file://")) {
        const url = new globalThis.URL(source);
        if (url.hostname || url.search || url.hash) continue;
        source = url.pathname.replace(/^\/(?=[a-z]:\/)/iu, "");
      }
      add(decodeURIComponent(source), match.index);
    } catch { /* Invalid URL escapes are not filesystem paths. */ }
    linkedText = linkedText.replace(match[0], " ".repeat(match[0].length));
  }
  // Quoted paths can contain spaces. Keep punctuation out of unquoted paths.
  const quoted = /[`"'「]([^`"'」\r\n]+)[`"'」]/gu;
  let remainder = linkedText;
  for (const match of linkedText.matchAll(quoted)) { add(match[1], match.index); remainder = remainder.replace(match[0], " ".repeat(match[0].length)); }
  for (const match of remainder.matchAll(/[^\s`"'<>()[\]{}、。，；：]+/gu)) {
    const token = match[0].replace(/^[*=]+|[.,;!?]+$/gu, "");
    if (!/^\w+:\/\//u.test(token)) add(token, match.index);
  }
  return [...paths].sort((left, right) => left[1] - right[1]).slice(-12).map(([source]) => source);
}

/** Only delivery/generation output can select a preview; incidental paths stay manual candidates. */
export function previewArtifactPaths(output: string): string[] {
  const artifacts = new Set<string>();
  for (const line of cliText(output).split(/\r?\n/u)) {
    if (/^\s*(?:(?:PS\s+[^>\r\n]+>|[$>%])\s*)?(?:&\s*)?(?:Write-(?:Output|Host)|echo|printf|python\d?|node|pwsh|powershell)(?:\.exe)?\b/iu.test(line)) continue;
    if (/(?:^|\s)(?:read(?:ing)?|get-content|view_image|reference|input file)(?=\s|[:(])|(?:読み込|読み取|参照元|入力ファイル)/iu.test(line)) continue;
    const generated = /(?<![\w/\\.-])(?:created|generated|saved|wrote|written|rendered|exported)(?![\w/\\.-])|\boutput(?:\s+file)?\s*:|(?:生成|作成|保存|出力|完成)(?:しました|完了|済|[:：])|書き出(?:しました|し(?:完了|済|[:：]))/iu.test(line);
    const deliveredLink = /^\s*(?:[-*•>]\s*)?!?\[[^\]\r\n]+\]\([^\r\n]+\)[.!。]?\s*$/u.test(line);
    if (generated || deliveredLink) for (const path of previewPaths(line)) artifacts.add(path);
  }
  return [...artifacts].slice(-12);
}
