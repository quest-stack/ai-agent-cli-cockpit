import { localPreviewUrl } from "./preview";

const artifactExtension = /\.(?:html?|md|png|jpe?g|gif|webp|svg|pdf|mp4)(?::\d+(?::\d+)?)?$/iu;

function cliText(output: string): string {
  const text = output.slice(-16384)
    // A cooked POSIX PTY can expand a CLI's CRLF into CRCRLF via ONLCR.
    // Collapse only CR runs followed by LF; lone repaint CRs stay unchanged.
    .replace(/\r+(?=\n)/gu, "\r")
    // eslint-disable-next-line no-control-regex -- Preserve the destination of a completed OSC 8 terminal hyperlink.
    .replace(/\x1b\]8;[^\x07\x1b;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;[^\x07\x1b;]*;(?:\x07|\x1b\\)/gu,
      (_match, url: string, label: string) => `[${label.replace(/\r?\n[\t ]*/gu, " ")}](<${url}>)`)
    // eslint-disable-next-line no-control-regex -- Strip the remaining OSC and CSI formatting controls.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  // Some CLI Markdown renderers display links as "label (destination)". Only
  // reconstruct standalone links, retaining path spaces and bounded wrapping.
  return text
    // Claude presents delivered image blocks as a marker, path and byte size.
    // The size terminator keeps partial output from opening mid-path.
    .replace(/^[\t ]*(?:[›❯>][\t ]*)?\[image\][\t ]+([^\r\n]+?\.(?:png|jpe?g|gif|webp|svg))[\t ]+\(\d+(?:\.\d+)?[\t ]*(?:B|KB|MB|GB)\)[\t ]*\r?$/gimu,
      (_match, source: string) => `[image](<${source.trim()}>)`)
    .replace(/^([\t ]*)((?:[-*•>][\t ]+)?[^\r\n()[\]]{1,160}?)[\t ]+[(（]((?:[^\r\n()（）]*\r?\n){0,3}[^\r\n()（）]*)[)）][.!。]?[\t ]*\r?$/gmu,
    (match, indent: string, label: string, destination: string) => {
      const source = destination.split(/\r?\n/u).map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join("").trim();
      return artifactExtension.test(source) ? `${indent}[${label}](<${source}>)` : match;
    });
}

function incidentalOutput(line: string): boolean {
  return /^\s*(?:(?:PS\s+[^>\r\n]+>|[$>%])\s*)?(?:&\s*)?(?:Write-(?:Output|Host)|echo|printf|python\d?|node|pwsh|powershell)(?:\.exe)?\b/iu.test(line)
    || /(?:^|[\s[])(?:read(?:ing)?|get-content|view_image|reference|input file)(?=\s|[:(\]])|(?:読み込|読み取|参照元|入力ファイル)/iu.test(line);
}

function deliveredLink(line: string): boolean {
  return /^\s*(?:[-*•>]\s*)?!?\[[^\]\r\n]+\]\([^\r\n]+\)[.!。]?\s*$/u.test(line);
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

/** An explicit delivery label owns its whole path, including spaces and bounded line wrapping. */
function deliveredFiles(text: string): Array<{ source: string; offset: number; end: number }> {
  const files: Array<{ source: string; offset: number; end: number }> = [];
  const labels = /^[\t ]*(?:[-*•>][\t ]+)?(?:ファイル|成果物|出力ファイル|保存先|file|artifact|output(?: file)?)[\t ]*[:：][\t ]*([^\r\n]*)/gimu;
  for (const match of text.matchAll(labels)) {
    let value = match[1], end = match.index + match[0].length;
    for (let lines = 0; lines < 4 && value.length <= 2048; lines++) {
      const source = value.trim().replace(/^[`"'「]|[`"'」]$/gu, "");
      if (artifactExtension.test(source)) {
        if (!source.includes("://") && !/[\0<>|]/u.test(source) && !source.startsWith("[") && !source.startsWith("![")) files.push({ source, offset: match.index, end });
        break;
      }
      // Preserve actual spaces, insert none, and never cross blank lines or new output blocks.
      if (value.trim() && !/[\\/]/u.test(value)) break;
      const next = /^\r?\n([^\r\n]+)/u.exec(text.slice(end));
      if (!next || /^\s*(?:[-*•>#│┃┌└╭╰]|(?:reading|read|view_image|get-content)\b|(?:ファイル|成果物|file|artifact|output)\s*[:：])/iu.test(next[1])) break;
      value += next[1]; end += next[0].length;
    }
  }
  return files;
}

/** A site is delivered explicitly; arbitrary directory mentions never start a preview. */
function deliveredSites(text: string): Array<{ source: string; offset: number }> {
  const sites: Array<{ source: string; offset: number }> = [];
  for (const match of text.matchAll(/^[\t ]*(?:[-*•>][\t ]+)?(?:サイト|プレビュー|成果物|保存先|site|preview|artifact|output)[\t ]*[:：][\t ]*([^\r\n]+)/gimu)) {
    const source = match[1].trim().replace(/^[`"'「]|[`"'」]$/gu, "");
    if (source.length <= 2048 && !source.includes("://") && !/[\0<>|]/u.test(source)
      && !artifactExtension.test(source) && !/\.[a-z0-9]+$/iu.test(source.replace(/[\\/]+$/u, ""))) sites.push({ source, offset: match.index });
  }
  return sites.slice(-12);
}

/** Bounded extraction of supported artifacts from CLI text, not a project scan. */
export function previewPaths(output: string): string[] {
  const text = cliText(output);
  const extension = /\.(?:html?|md|png|jpe?g|gif|webp|svg|pdf|mp4)$/iu;
  const paths = new Map<string, number>();
  for (const site of deliveredSites(text)) paths.set(site.source, site.offset);
  const add = (value: string, offset: number): void => {
    const source = value.trim().replace(/:\d+(?::\d+)?$/u, "");
    if (source.length <= 2048 && extension.test(source) && !isPreviewContextFile(source) && !source.includes("://") && !source.includes("\0")) paths.set(source, offset);
  };
  // Decode link destinations rather than treating URL escapes as literal filenames.
  const linked = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\r\n)]+))\s*\)/gu;
  let linkedText = text;
  for (const file of deliveredFiles(text)) {
    add(file.source, file.offset);
    linkedText = linkedText.slice(0, file.offset) + " ".repeat(file.end - file.offset) + linkedText.slice(file.end);
  }
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

/** Explicit deliveries may open a new tab even while another artifact is manually selected. */
export function previewDeliveredPaths(output: string): string[] {
  const text = cliText(output);
  const artifacts = new Set([...deliveredFiles(text).flatMap((file) => previewPaths(`"${file.source}"`)), ...deliveredSites(text).map((site) => site.source)]);
  for (const line of text.split(/\r?\n/u)) {
    if (!incidentalOutput(line) && deliveredLink(line)) for (const path of previewPaths(line)) artifacts.add(path);
  }
  return previewPaths(text).filter((source) => artifacts.has(source)).slice(-12);
}

/** Only delivery/generation output can select a preview; incidental paths stay manual candidates. */
export function previewArtifactPaths(output: string): string[] {
  const text = cliText(output);
  const artifacts = new Set(previewDeliveredPaths(text));
  for (const line of text.split(/\r?\n/u)) {
    if (incidentalOutput(line)) continue;
    const generated = /(?<![\w/\\.-])(?:created|generated|saved|wrote|written|rendered|exported)(?![\w/\\.-])|\boutput(?:\s+file)?\s*:|(?:生成|作成|保存|出力|完成)(?:しました|完了|済|[:：])|書き出(?:しました|し(?:完了|済|[:：]))/iu.test(line);
    if (generated) for (const path of previewPaths(line)) artifacts.add(path);
  }
  return previewPaths(text).filter((source) => artifacts.has(source)).slice(-12);
}
