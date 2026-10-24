import { isPreviewContextFile } from "./preview-paths";

const contextName = "(?:agents(?:\\.override)?|claude(?:\\.local)?|design|skill|current_status|handoff(?:[_-][a-z0-9_-]+)?|readme(?:\\.[a-z]{2}(?:-[a-z]{2})?)?)\\.md";

function contextPaths(text: string): string[] {
  const paths: string[] = [];
  let remainder = text;
  for (const match of text.matchAll(/[`"'「]([^`"'」\r\n]+)[`"'」]/gu)) {
    if (isPreviewContextFile(match[1])) paths.push(match[1]);
    remainder = remainder.replace(match[0], " ");
  }
  for (const match of remainder.matchAll(new RegExp(`${contextName}(?=$|[^a-z0-9_.-])`, "giu"))) {
    const before = remainder.slice(0, match.index);
    const prefix = /(?:[a-z]:)?(?:[^\s`"'<>()[\]{}、。，；：\\/:]*[\\/])+$/iu.exec(before)?.[0] ?? "";
    if (!prefix && /[a-z0-9_.-]$/iu.test(before)) continue;
    paths.push(prefix + match[0]);
  }
  return [...new Set(paths)].filter((path) => path.length <= 2048).slice(0, 12);
}

/** Local heuristics on submitted user input only; never infer requests from CLI output. */
export function requestedContextPaths(text: string): string[] {
  const positive = /(?:確認|修正|編集|変更|更新|見直|レビュー|チェック|表示|開|見せ|見て|見たい|読|直|治|\b(?:read|review|check|inspect|edit|change|modify|revise|fix|update|show|display|open|cat|type|get-content|less|more|vim|nano)\b)/iu;
  const negative = /(?:開|表示|確認|見|読|修正|編集|変更|更新|触|治).{0,12}(?:ない|なく|不要|せず|禁止)|そのまま|対象外|除外|不要|(?:do\s+not|don't|never)\s+(?:open|read|show|display|edit|change|modify|revise|update|check|inspect)|\b(?:skip|ignore)\b|\bleave\b.{0,64}\balone\b/iu;
  const clauses = text.split(/[。\n;；、]|\bbut\b/iu);
  if (!clauses.some((clause) => positive.test(clause) && !negative.test(clause))) return [];
  const key = (path: string): string => path.replaceAll("\\", "/").toLowerCase();
  const excluded = new Set(clauses.filter((clause) => negative.test(clause)).flatMap(contextPaths).map(key));
  return [...new Set(clauses.flatMap((clause) => {
    if (negative.test(clause)) return [];
    const paths = contextPaths(clause);
    if (positive.test(clause)) return paths;
    // A filename-only list item can share the instruction in the next clause.
    let remainder = clause;
    for (const path of paths) remainder = remainder.replace(path, "");
    return remainder.replace(/[`"'「」\s]/gu, "") ? [] : paths;
  }))].filter((path) => !excluded.has(key(path))).slice(0, 12);
}

/** Bounded, ephemeral line state. Editing we cannot reconstruct suppresses detection. */
export class ContextPreviewInput {
  private text = "";
  private escape = "";
  private pasting = false;
  private uncertain = false;

  push(data: string): string[] {
    const requests: string[] = [];
    for (const character of data) {
      if (character === "\u0003") {
        this.text = ""; this.escape = ""; this.pasting = false; this.uncertain = false; continue;
      }
      if (this.escape) {
        this.escape += character;
        if (this.escape.length === 2 && character !== "[" && character !== "O") {
          this.text = ""; this.escape = ""; this.uncertain = true;
        } else if (this.escape.length > 64) {
          this.escape = ""; this.uncertain = true;
        } else if (this.escape.length > 2 && /[@-~]/u.test(character)) {
          if (this.escape === "\u001b[200~") this.pasting = true;
          else if (this.escape === "\u001b[201~") this.pasting = false;
          else if (/^\[(?:13;\d+u|27;\d+;13~)$/u.test(this.escape.slice(1))) this.text += "\n";
          else if (/^(?:\[[0-9;]*[ABCDHF~]|O[ABCDHF])$/u.test(this.escape.slice(1))) this.uncertain = true;
          this.escape = "";
        }
        continue;
      }
      if (character === "\u001b") { this.escape = character; continue; }
      if (character === "\u0015" || character === "\u0017") {
        this.text = ""; this.uncertain = true; continue;
      }
      if (character === "\u007f" || character === "\b") { this.text = [...this.text].slice(0, -1).join(""); continue; }
      if (character === "\r" || character === "\n") {
        if (this.pasting) this.text += "\n";
        else {
          if (!this.uncertain) requests.push(...requestedContextPaths(this.text));
          this.text = ""; this.uncertain = false;
        }
      } else if (character >= " ") this.text += character;
      else this.uncertain = true;
      if (this.text.length > 4096) { this.text = ""; this.uncertain = true; }
    }
    return [...new Set(requests)].slice(0, 12);
  }
}
