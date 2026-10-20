import { localPreviewUrl } from "./preview";

function cliText(output: string): string {
  // eslint-disable-next-line no-control-regex -- Strip ANSI escape sequences emitted by terminal CLIs.
  return output.slice(-16384).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
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
  const paths: string[] = [];
  const add = (value: string): void => {
    const source = value.trim().replace(/:\d+(?::\d+)?$/u, "");
    if (source.length <= 2048 && extension.test(source) && !source.includes("://") && !source.includes("\0") && !paths.includes(source)) paths.push(source);
  };
  // Quoted paths can contain spaces. Keep punctuation out of unquoted paths.
  const quoted = /[`"'「]([^`"'」\r\n]+)[`"'」]/gu;
  let remainder = text;
  for (const match of text.matchAll(quoted)) { add(match[1]); remainder = remainder.replace(match[0], " "); }
  for (const match of remainder.matchAll(/[^\s`"'<>()[\]{}、。，；：]+/gu)) {
    const token = match[0].replace(/^[*=]+|[.,;!?]+$/gu, "");
    if (!/^\w+:\/\//u.test(token)) add(token);
  }
  return paths.slice(-12);
}
