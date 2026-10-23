import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

/**
 * A Markdown document's top-level block: its kind (mdast's node type, or `frontmatter`), its first and last line
 * (1-based), and its source lines. A rendered review draws each block through BB's Markdown and anchors comments to its
 * lines.
 */
export interface MarkdownBlock {
  kind: string;
  start: number;
  end: number;
  source: string;
  /** A heading's level, 1 to 6. */
  depth?: number;
}

/** A document's blocks, and its link reference definitions, which each block's slice needs to resolve its links. */
export interface MarkdownDoc {
  blocks: MarkdownBlock[];
  definitions: string;
}

/** YAML frontmatter at the document's start, which GitHub shows as a table; parsed, it reads as a rule and a heading. */
const FRONTMATTER = /^---\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;
/** An HTML block's opening tag, whose element may hold Markdown blocks up to its closing tag, as `<details>` does. */
const OPEN_TAG = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/;

/** `text` read as Markdown: without a byte order mark, its line endings `\n`. Line numbers stay as they were. */
export const normalMarkdown = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/** Whether a file is Markdown that renders: `.md` and `.markdown`. MDX has components BB's Markdown can't run. */
export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

/**
 * `text`'s top-level blocks, as GitHub's Markdown (CommonMark and GFM) reads them, in order. An HTML element whose
 * opening tag starts a block, such as `<details>`, is one block through its closing tag; consecutive link reference
 * definitions are one block.
 */
export function markdownBlocks(text: string): MarkdownDoc {
  const lines = normalMarkdown(text).split("\n");
  const slice = (start: number, end: number) => lines.slice(start - 1, end).join("\n");
  const blocks: MarkdownBlock[] = [];
  // Frontmatter's lines read as blank, so the rest keeps its line numbers.
  let body = lines;
  const front = normalMarkdown(text).match(FRONTMATTER);
  if (front) {
    const end = front[0].replace(/\n$/, "").split("\n").length;
    blocks.push({ kind: "frontmatter", start: 1, end, source: slice(1, end) });
    body = lines.map((line, index) => (index < end ? "" : line));
  }
  const tree = fromMarkdown(body.join("\n"), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const nodes = tree.children.flatMap((node) => node.position ? [{ kind: node.type as string, start: node.position.start.line, end: node.position.end.line, html: node.type === "html" ? node.value : null, depth: node.type === "heading" ? node.depth : undefined }] : []);
  const definitions: string[] = [];
  // The elements some HTML block closes: an <img>, or an element never closed, ends where CommonMark ends it.
  const closed = new Set(nodes.flatMap((node) => [...node.html?.matchAll(/<\/([A-Za-z][A-Za-z0-9-]*)\s*>/g) ?? []].map((match) => match[1].toLowerCase())));
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    let end = node.end;
    if (node.kind === "definition") {
      while (nodes[i + 1]?.kind === "definition") end = nodes[++i].end;
      definitions.push(slice(node.start, end));
    }
    // Elements of the same name nest: the block ends where the opening tag's own closing tag does.
    const tag = node.html?.match(OPEN_TAG)?.[1].toLowerCase();
    const opened = (html: string) => (html.match(new RegExp(`<${tag}(?=[\\s/>]|$)`, "gi"))?.length ?? 0) - (html.match(new RegExp(`</${tag}\\s*>`, "gi"))?.length ?? 0);
    let open = tag && closed.has(tag) ? opened(node.html!) : 0;
    for (let at = i + 1; open > 0 && at < nodes.length; at++) {
      if (nodes[at].kind === "html") open += opened(nodes[at].html!);
      if (open > 0) continue;
      // Its definitions still resolve links in the rest of the document.
      for (const inside of nodes.slice(i + 1, at)) if (inside.kind === "definition") definitions.push(slice(inside.start, inside.end));
      end = nodes[at].end;
      i = at;
    }
    blocks.push({ kind: node.kind, start: node.start, end, source: slice(node.start, end), ...(node.depth ? { depth: node.depth } : {}) });
  }
  return { blocks, definitions: definitions.join("\n") };
}

/** The block of `blocks`, in order, that holds `line`. */
export function blockHolding(blocks: MarkdownBlock[], line: number): MarkdownBlock | undefined {
  let [low, high] = [0, blocks.length - 1];
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].end < line) low = mid + 1;
    else if (blocks[mid].start > line) high = mid - 1;
    else return blocks[mid];
  }
  return undefined;
}

/** A block as BB's Markdown draws it alone: with the document's definitions, frontmatter as a table. */
export function blockMarkdown(block: MarkdownBlock, definitions: string): string {
  if (block.kind === "frontmatter") return frontmatterTable(block.source);
  if (block.kind === "definition") return codeFence(block.source);
  // A footnote's definition renders nothing without a reference: its label shows as text, in bold.
  const source = block.kind === "footnoteDefinition" ? block.source.replace(/^ {0,3}\[\^([^\]]+)\]:/, (_all, label: string) => `**[^${label}]**`) : block.source;
  return definitions ? `${source}\n\n${definitions}` : source;
}

/** Frontmatter's `key: value` lines as a table, as GitHub shows them; any other YAML as code. */
function frontmatterTable(source: string): string {
  const inner = source.split("\n").slice(1, -1).filter((line) => line.trim());
  const pairs = inner.map((line) => line.match(/^([\w.-]+):[ \t]*(.*)$/));
  if (!inner.length || pairs.some((pair) => !pair)) return codeFence(inner.join("\n"), "yaml");
  const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[<`*_[\]]/g, "\\$&");
  return [`| ${pairs.map((pair) => cell(pair![1])).join(" | ")} |`, `|${pairs.map(() => " --- ").join("|")}|`, `| ${pairs.map((pair) => cell(pair![2])).join(" | ")} |`].join("\n");
}

function codeFence(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}
