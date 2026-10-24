import type { MarkdownBlock } from "./markdown-blocks";

/** How many words around a point in prose find its line in the source. */
const WORDS_AROUND = 3;

/**
 * The text a block draws before a point and after it, as a reader sees it: without deleted words, which aren't in the new
 * source, or what's there for screen readers alone.
 */
function drawnText(el: Element, node: Node, offset: number): [before: string, after: string] {
  const point = document.createRange();
  point.setStart(node, offset);
  let [before, after] = ["", ""];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement?.closest("del, .sr-only")) continue;
    const value = text.textContent ?? "";
    if (text === node) { before += value.slice(0, offset); after += value.slice(offset); }
    else if (point.comparePoint(text, 0) < 0) before += value;
    else after += value;
  }
  return [before, after];
}

const textBetween = (el: Element, node: Node, offset: number, toEnd: boolean): string => {
  const range = document.createRange();
  if (toEnd) { range.setStart(node, offset); range.setEnd(el, el.childNodes.length); } else { range.setStart(el, 0); range.setEnd(node, offset); }
  return range.toString();
};

/**
 * The source line of a point in a block as BB's Markdown drew it, `el`, where a selection starts (`edge` "start") or
 * ends. Read from the drawing, never changing it: in a table, its row's (`tr`, in the order they draw); in code, its
 * line's, by the highlighter's line spans or its newlines; in prose, the line of the words around the point as drawn,
 * found once in the source and once in the drawing. Otherwise, as where a table draws other rows than its source has,
 * or the words show more than once, the block's edge on that side.
 */
export function pointLine(block: MarkdownBlock, el: Element, node: Node, offset: number, edge: "start" | "end"): number {
  const fallback = edge === "start" ? block.start : block.end;
  const at = node instanceof Element ? node : node.parentElement;
  if (!at || !el.contains(at)) return fallback;
  if (block.rows) {
    const rows = Array.from(el.querySelectorAll("tr"));
    const row = at.closest("tr");
    return row && rows.length === block.rows.length ? block.rows[rows.indexOf(row)] : fallback;
  }
  if (block.kind === "code") {
    const code = at.closest("pre");
    if (!code) return fallback;
    const spans = Array.from(code.querySelectorAll(".line"));
    const index = spans.findIndex((span) => span.contains(at));
    const line = index >= 0 ? index : textBetween(code, node, offset, false).split("\n").length - 1;
    // A fenced block's first line is its fence.
    const fenced = /^ {0,3}(?:```|~~~)/.test(block.source);
    return Math.min(block.start + (fenced ? 1 : 0) + line, block.end - (fenced ? 1 : 0));
  }
  const [before, after] = drawnText(el, node, offset);
  const words = [...(edge === "start" ? after : before).matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
  const around = edge === "start" ? words.slice(0, WORDS_AROUND) : words.slice(-WORDS_AROUND);
  if (!around.length) return fallback;
  // Once in the source, and once as drawn: else it may be other words that read the same, as a link's around its URL.
  const pattern = new RegExp(around.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"), "gu");
  const found = [...block.source.matchAll(pattern)];
  if (found.length !== 1 || [...(before + after).matchAll(pattern)].length !== 1) return fallback;
  const index = edge === "start" ? found[0].index : found[0].index + found[0][0].length - 1;
  return block.start + (block.source.slice(0, index).match(/\n/g)?.length ?? 0);
}

/** The source of `blocks`' lines from `from` to `to`, a blank line between blocks. */
export function textLines(blocks: MarkdownBlock[], from: number, to: number): string {
  return blocks.filter((block) => block.end >= from && block.start <= to)
    .map((block) => block.source.split("\n").slice(Math.max(from - block.start, 0), to - block.start + 1).join("\n")).join("\n\n");
}
