import { expect, test } from "vitest";
import { blockMarkdown, isMarkdownPath, markdownBlocks } from "./markdown-blocks";

const lines = (text: string) => markdownBlocks(text).blocks.map((b) => [b.kind, b.start, b.end]);

test("top-level blocks keep their source lines: headings, paragraphs, lists, tables, and fences", () => {
  const doc = "# Title\n\nPara one\nline two\n\n- a\n- b\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n";
  expect(lines(doc)).toEqual([["heading", 1, 1], ["paragraph", 3, 4], ["listItem", 6, 6], ["listItem", 7, 8], ["table", 10, 12], ["code", 14, 16]]);
  expect(markdownBlocks(doc).blocks[1].source).toBe("Para one\nline two");
});

test("frontmatter is one block, shown as a table, and the rest keeps its line numbers", () => {
  const doc = "---\ntitle: Tokens\nowner: a|b\n---\n# Heading\n";
  const { blocks } = markdownBlocks(doc);
  expect(blocks.map((b) => [b.kind, b.start, b.end])).toEqual([["frontmatter", 1, 4], ["heading", 5, 5]]);
  expect(blockMarkdown(blocks[0], "")).toBe("| title | owner |\n| --- | --- |\n| Tokens | a\\|b |");
});

test("frontmatter that isn't key: value lines shows as YAML", () => {
  const { blocks } = markdownBlocks("---\ntags:\n  - a\n---\nText\n");
  expect(blockMarkdown(blocks[0], "")).toBe("```yaml\ntags:\n  - a\n```");
});

test("a <details> element with blank lines inside is one block, through its closing tag", () => {
  expect(lines("Intro\n\n<details><summary>s</summary>\n\nhidden\n\n</details>\n\nAfter\n")).toEqual([["paragraph", 1, 1], ["html", 3, 7], ["paragraph", 9, 9]]);
});

test("nested <details> are one block, through the outer closing tag", () => {
  const doc = "<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\nInner.\n\n</details>\n\nOuter tail.\n\n</details>\n\nEnd.\n";
  expect(lines(doc)).toEqual([["html", 1, 13], ["paragraph", 15, 15]]);
});

test("many void or unclosed HTML blocks read in linear time", () => {
  const doc = Array.from({ length: 8000 }, (_, i) => `<img src="a${i}.png">`).join("\n\n") + "\n";
  const start = performance.now();
  expect(markdownBlocks(doc).blocks).toHaveLength(8000);
  expect(performance.now() - start).toBeLessThan(3000);
});

test("link definitions inside an element still resolve links in other blocks", () => {
  const doc = markdownBlocks("<div>\n\n[x]: http://a\n\n</div>\n\nSee [link][x].\n");
  expect(doc.definitions).toBe("[x]: http://a");
});

test("an unclosed element stays the block CommonMark reads", () => {
  expect(lines("<details>\n\ntext\n")).toEqual([["html", 1, 1], ["paragraph", 3, 3]]);
});

test("link reference definitions are one block, and each block's slice carries those it may use", () => {
  const doc = markdownBlocks("See [the docs][d].\n\n[d]: https://example.com/d\n[e]: https://example.com/e\n");
  expect(doc.blocks.map((b) => [b.kind, b.start, b.end])).toEqual([["paragraph", 1, 1], ["definition", 3, 4]]);
  expect(doc.definitions).toBe("[d]: https://example.com/d\n[e]: https://example.com/e");
  expect(blockMarkdown(doc.blocks[0], doc.definitions)).toBe("See [the docs][d].\n\n[d]: https://example.com/d");
});

test("a block carries the definitions its labels match as CommonMark matches them, in any case and spacing", () => {
  const doc = markdownBlocks("Read [The  Guide] and ![Logo], not [x](y).\n\nOther.\n\n[the guide]: https://g.io\n[LOGO]: logo.png\n[unused]: https://u.io\n");
  expect(blockMarkdown(doc.blocks[0], doc.definitions)).toBe("Read [The  Guide] and ![Logo], not [x](y).\n\n[the guide]: https://g.io\n[LOGO]: logo.png");
  expect(blockMarkdown(doc.blocks[1], doc.definitions)).toBe("Other.");
});

test("a Keep a Changelog file's versions each carry their own definition, not every version's", () => {
  const versions = Array.from({ length: 300 }, (_, i) => `1.${300 - i}.0`);
  const doc = markdownBlocks(`${versions.map((v) => `## [${v}]\n\n- A change in ${v}.`).join("\n\n")}\n\n${versions.map((v) => `[${v}]: https://github.com/o/r/compare/v${v}`).join("\n")}\n`);
  expect(blockMarkdown(doc.blocks[0], doc.definitions)).toBe("## [1.300.0]\n\n[1.300.0]: https://github.com/o/r/compare/v1.300.0");
  expect(blockMarkdown(doc.blocks[1], doc.definitions)).toBe("- A change in 1.300.0.");
});

test("a footnote's definition shows its label in bold", () => {
  const { blocks } = markdownBlocks("Text[^1].\n\n[^1]: The note.\n");
  expect(blockMarkdown(blocks[1], "")).toBe("**[^1]** The note.");
});

test("CRLF line endings and a byte order mark leave the line numbers as they are", () => {
  expect(lines("\uFEFF# A\r\n\r\nB\r\nC\r\n")).toEqual([["heading", 1, 1], ["paragraph", 3, 4]]);
  expect(markdownBlocks("# A\r\n\r\nB\r\n").blocks[1].source).toBe("B");
});

test("headings say their depth, setext ones too", () => {
  expect(markdownBlocks("## Two\n\nThree\n=====\n").blocks.map((b) => b.depth)).toEqual([2, 1]);
});

test("a list is a block for each of its top-level items, nested lists in theirs", () => {
  const { blocks } = markdownBlocks("- a\n- b\n  - nested\n\n* other\n\n1. one\n\n   more\n2. two\n");
  expect(blocks.map((b) => [b.start, b.end, b.list])).toEqual([
    [1, 1, { marker: "-", loose: false }], [2, 3, { marker: "-", loose: false }], [5, 5, { marker: "*", loose: false }],
    [7, 9, { marker: ".", loose: true, number: 1 }], [10, 10, { marker: ".", loose: true, number: 2 }],
  ]);
  expect(blocks[1].source).toBe("- b\n  - nested");
});

test("an ordered list's item draws with its number in the list, however the source numbers it", () => {
  const { blocks } = markdownBlocks("3. three\n1. four\n1. five\n");
  expect(blocks.map((b) => blockMarkdown(b, ""))).toEqual(["3. three", "4. four", "5. five"]);
});

test("a table knows each row's line: the header's, then the body's", () => {
  const { blocks } = markdownBlocks("Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
  expect(blocks[1].rows).toEqual([3, 5, 6]);
});

test("only .md and .markdown files render", () => {
  expect(["README.md", "docs/a.MARKDOWN", "x.mdx", "a.md.ts"].map(isMarkdownPath)).toEqual([true, true, false, false]);
});
