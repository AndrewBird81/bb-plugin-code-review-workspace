// @vitest-environment jsdom
import { expect, test } from "vitest";
import { pointLine, textLines } from "./markdown-points";
import { markdownBlocks, type MarkdownBlock } from "./markdown-blocks";

/** A block, as markdownBlocks reads it from `doc`, at `index`, drawn as `html` in an element, as BB's Markdown draws it. */
function drawn(doc: string, index: number, html: string): { block: MarkdownBlock; el: HTMLElement } {
  const block = markdownBlocks(doc).blocks[index];
  const el = document.createElement("div");
  el.innerHTML = html;
  return { block, el };
}
const textIn = (el: HTMLElement, text: string): [Node, number] => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(text);
    if (at >= 0) return [node, at];
  }
  throw new Error(`no ${text}`);
};

test("a point in a table's row is that row's line, the header's too", () => {
  const { block, el } = drawn("Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n", 1,
    "<div><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>");
  expect(pointLine(block, el, ...textIn(el, "3"), "start")).toBe(6);
  expect(pointLine(block, el, ...textIn(el, "a"), "end")).toBe(3);
});

test("a table drawn with other rows than its source has, as a host's that changed would, gives the block's edge", () => {
  const { block, el } = drawn("| a |\n|---|\n| 1 |\n", 0, "<table><tbody><tr><td>a</td></tr><tr><td>1</td></tr><tr><td>x</td></tr></tbody></table>");
  expect(pointLine(block, el, ...textIn(el, "1"), "start")).toBe(1);
  expect(pointLine(block, el, ...textIn(el, "1"), "end")).toBe(3);
});

test("a point in fenced code is its line, by the highlighter's line spans or else its newlines", () => {
  const doc = "```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\n";
  const spans = drawn(doc, 0, '<div><span>TS</span><pre><code><span class="line">const x = 1;</span>\n<span class="line">const y = 2;</span>\n<span class="line">const z = 3;</span></code></pre></div>');
  expect(pointLine(spans.block, spans.el, ...textIn(spans.el, "y = 2"), "start")).toBe(3);
  expect(pointLine(spans.block, spans.el, ...textIn(spans.el, "z = 3"), "end")).toBe(4);
  const plain = drawn(doc, 0, "<pre><code>const x = 1;\nconst y = 2;\nconst z = 3;\n</code></pre>");
  const [node] = textIn(plain.el, "const z");
  expect(pointLine(plain.block, plain.el, node, node.textContent!.indexOf("const z") + 2, "end")).toBe(4);
  expect(pointLine(plain.block, plain.el, node, 3, "start")).toBe(2);
});

test("a point in prose is the line holding the words around it, found in the source", () => {
  const doc = "Tokens expire after **15 minutes**,\nwhich keeps a stolen token\nuseful for a short while only.\n";
  const { block, el } = drawn(doc, 0, "<p>Tokens expire after <strong>15 minutes</strong>,\nwhich keeps a stolen token\nuseful for a short while only.</p>");
  expect(pointLine(block, el, ...textIn(el, "stolen"), "start")).toBe(2);
  const [node, at] = textIn(el, "short while");
  expect(pointLine(block, el, node, at + "short".length, "end")).toBe(3);
  // The words before an end at "15 minutes", across the bold.
  const [bold] = textIn(el, "15 minutes");
  expect(pointLine(block, el, bold, 2, "end")).toBe(1);
});

// The words around the point are the drawn text's: a link's URL is in the source between them, not in what draws.
test("words found once in the source but more than once as drawn give the block's edge", () => {
  const doc = "click [see docs](https://x.io/a) now please\nmore text here\nalso see docs now please\n";
  const { block, el } = drawn(doc, 0, '<p>click <a href="https://x.io/a">see docs</a> now please\nmore text here\nalso see docs now please</p>');
  expect(pointLine(block, el, ...textIn(el, "see docs"), "start")).toBe(1);
});

test("words around the point are read without deleted words or the block's words for screen readers", () => {
  const doc = "Tokens expire after 15 minutes,\nwhich keeps a stolen token useful briefly.\n";
  const { block, el } = drawn(doc, 0, '<span class="sr-only">Changed, lines 1–2</span><p>Tokens expire after <del>1 hour</del><ins>15 minutes</ins>,\nwhich keeps a stolen token useful briefly.</p>');
  const [node, at] = textIn(el, "15 minutes");
  expect(pointLine(block, el, node, at + 2, "end")).toBe(1);
  expect(pointLine(block, el, ...textIn(el, "Tokens"), "start")).toBe(1);
  const [which] = textIn(el, "which keeps");
  expect(pointLine(block, el, which, 0, "start")).toBe(2);
});

test("words found more than once, or not at all, give the block's edge", () => {
  const doc = "Same words here.\nSame words here.\n";
  const { block, el } = drawn(doc, 0, "<p>Same words here.\nSame words here.</p>");
  expect(pointLine(block, el, ...textIn(el, "words"), "start")).toBe(1);
  expect(pointLine(block, el, ...textIn(el, "words"), "end")).toBe(2);
});

test("a block's source lines from one to another, for a question about them", () => {
  const { blocks } = markdownBlocks("One.\n\nTwo\nlines.\n\nThree.\n");
  expect(textLines(blocks, 4, 6)).toBe("lines.\n\nThree.");
  expect(textLines(blocks, 1, 1)).toBe("One.");
});
