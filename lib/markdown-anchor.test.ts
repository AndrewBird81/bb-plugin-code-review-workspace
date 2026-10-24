import { expect, test } from "vitest";
import { invalidComments, rangeProblem } from "../src/review-positions";
import { rng } from "../src/fuzz-gen.test-support";
import { blockAnchor, blockAt, fileLines, rangeAnchor, selectedBlocks, selectionAnchor } from "./markdown-anchor";
import { markdownDiff, type RenderedBlock } from "./markdown-diff";
import { gitPatch } from "./markdown-test-patch.test-support";

const FILE = "doc.md";
const setup = (old: string | null, now: string | null, context = 3) => {
  const patch = gitPatch(FILE, old, now, context);
  return { patch, lines: fileLines(patch, FILE), items: markdownDiff(old, now, patch).blocks };
};
const find = (items: RenderedBlock[], status: string, start: number) => items.find((item) => item.status === status && item.block.start === start)!;

const PARA = "Tokens expire after 1 hour.\nThey refresh on use.\nNo rotation.";
const BASE = `# Tokens\n\n${PARA}\n\n${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((word) => `${word} is a word.`).join("\n\n")}\n`;

test("a changed block's comment takes its lines in the diff, in the hunk of its change", () => {
  const { items, lines } = setup(BASE, BASE.replace("1 hour", "15 minutes"));
  expect(blockAnchor(lines, find(items, "changed", 3))).toEqual({ line: 5, side: "RIGHT", startLine: 3 });
});

test("a block the diff shows as context takes a comment; one it doesn't show takes none", () => {
  const { items, lines } = setup(BASE, BASE.replace("1 hour", "15 minutes"));
  expect(blockAnchor(lines, find(items, "unchanged", 1))).toEqual({ line: 1, side: "RIGHT" });
  expect(blockAnchor(lines, find(items, "unchanged", 17))).toBeNull();
});

test("a removed block's comment is on the old lines the diff removes, never on context", () => {
  const { items, lines } = setup(BASE, BASE.replace(`${PARA}\n\n`, ""));
  expect(blockAnchor(lines, find(items, "removed", 3))).toEqual({ line: 5, side: "LEFT", startLine: 3 });
});

test("a block cut by a hunk's edge keeps to the hunk of its change", () => {
  const old = `${Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")}\n`;
  const { items, lines } = setup(old, old.replace("line 1\n", "line one\n").replace("line 10\n", "line ten\n"), 1);
  expect(blockAnchor(lines, items[0])).toEqual({ line: 3, side: "RIGHT", startLine: 1 });
});

test("a selection's comment runs from its first block to its last on the side it ends on, in one hunk", () => {
  const { items, lines } = setup(BASE, BASE.replace("1 hour", "15 minutes").replace("Alpha is", "Alpha was"));
  expect(selectionAnchor(lines, [find(items, "changed", 3), find(items, "changed", 7)])).toEqual({ line: 7, side: "RIGHT", startLine: 3 });
  // Ending in a block the diff doesn't show, the comment goes on the selected blocks it does.
  expect(selectionAnchor(lines, [find(items, "changed", 7), find(items, "unchanged", 17)])).toEqual({ line: 10, side: "RIGHT", startLine: 7 });
  expect(selectionAnchor(lines, [find(items, "unchanged", 15), find(items, "unchanged", 17)])).toBeNull();
});

test("a table row's, a code line's, or part of a block's comment takes those lines, in the hunk of their end", () => {
  const old = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\n";
  const now = old.replace("| 3 | 4 |", "| 3 | 5 |").replace("const y = 2;", "const y = 3;");
  const { lines, items } = setup(old, now, 1);
  // A row the diff shows, and one it doesn't.
  expect(rangeAnchor(lines, "RIGHT", 4, 4)).toEqual({ line: 4, side: "RIGHT" });
  expect(rangeAnchor(lines, "RIGHT", 1, 1)).toBeNull();
  // Lines across two hunks keep to the end's.
  expect(rangeAnchor(lines, "RIGHT", 3, 8)).toEqual({ line: 8, side: "RIGHT", startLine: 7 });
  // A selection from a line of the table to a line of the code.
  expect(selectionAnchor(lines, items, 4, 8)).toEqual({ line: 8, side: "RIGHT", startLine: 7 });
  expect(selectionAnchor(lines, items.slice(0, 1), 3, 4)).toEqual({ line: 4, side: "RIGHT", startLine: 3 });
});

test("threads and drafts show after the block holding their line", () => {
  const old = `# Tokens\n\n${PARA}\n\nAlpha beta gamma.\n\nDelta epsilon zeta.\n`;
  const { items, lines } = setup(old, old.replace(`${PARA}\n\n`, "").replace("zeta", "eta"));
  const at = (line: number, side: "LEFT" | "RIGHT") => { const item = items[blockAt(items, lines, { line, side })]; return [item.status, item.block.start]; };
  expect(at(4, "LEFT")).toEqual(["removed", 3]);
  expect(at(5, "RIGHT")).toEqual(["changed", 5]);
  // The old line of a changed block goes with it; an old context line with the new line it is; a blank line with the block before.
  expect(at(9, "LEFT")).toEqual(["changed", 5]);
  expect(at(7, "LEFT")).toEqual(["unchanged", 3]);
  expect(at(4, "RIGHT")).toEqual(["unchanged", 3]);
});

test("a selection's blocks take a changed block's version before where an end of it is in one", () => {
  const block = (start: number) => ({ kind: "paragraph", start, end: start, source: `P${start}` });
  const items: RenderedBlock[] = [
    { status: "unchanged", side: "RIGHT", block: block(1) },
    { status: "changed", side: "RIGHT", block: block(3), previous: [block(3), block(5)] },
    { status: "added", side: "RIGHT", block: block(7) },
  ];
  const shown = (from: { index: number; ghost?: number }, to: { index: number; ghost?: number }) => selectedBlocks(items, from, to).map((item) => `${item.side}:${item.block.start}`);
  expect(shown({ index: 0 }, { index: 2 })).toEqual(["RIGHT:1", "RIGHT:3", "RIGHT:7"]);
  // From its first version before into the block itself, or on to the next.
  expect(shown({ index: 1, ghost: 0 }, { index: 1 })).toEqual(["LEFT:3", "RIGHT:3"]);
  expect(shown({ index: 1, ghost: 1 }, { index: 2 })).toEqual(["LEFT:5", "RIGHT:3", "RIGHT:7"]);
  // Ending in one: not the block after it.
  expect(shown({ index: 0 }, { index: 1, ghost: 1 })).toEqual(["RIGHT:1", "LEFT:5"]);
  expect(shown({ index: 1, ghost: 0 }, { index: 1, ghost: 1 })).toEqual(["LEFT:3", "LEFT:5"]);
  expect(shown({ index: 1, ghost: 1 }, { index: 1, ghost: 1 })).toEqual(["LEFT:5"]);
});

// Every anchor the rendered view makes is one GitHub takes: its line in the diff, a range in one hunk in order, and a
// removed block's only on lines the diff removes.
test("every block's and every selection's anchor is valid on GitHub", () => {
  const r = rng(20261023);
  const pool = ["# Heading", "## Sub", "Short paragraph.", "Two-line\nparagraph here.", "- a\n- b\n- c", "1. one\n2. two", "| a | b |\n|---|---|\n| 1 | 2 |", "```ts\nconst x = 1;\nconst y = 2;\n```", "> quote", "---", "<details>\n\nhidden\n\n</details>", "[d]: https://example.com",
    "- [ ] task one\n- [x] task two", "* loose one\n\n* loose two", "- a\n  - nested\n- b", "3. three\n1. four",
    "| h | i |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |", "```sh\nnpm ci\nnpm test\nnpm run build\n```"];
  const words = ["token", "rotation", "expires", "client", "gateway", "refresh"];
  const doc = () => Array.from({ length: r.int(3, 14) }, () => r.pick(pool)).join("\n\n") + "\n";
  const edit = (text: string) => {
    const blocks = text.trimEnd().split("\n\n");
    for (let i = r.int(1, 4); i > 0; i--) {
      const at = r.int(0, blocks.length - 1);
      const kind = r.int(0, 6);
      // A line of the block: a list's item, as often as not.
      const lines = blocks[at].split("\n");
      const line = r.int(0, lines.length - 1);
      if (kind === 0) blocks.splice(at, 1);
      else if (kind === 1) blocks.splice(at, 0, r.pick(pool));
      else if (kind === 2) blocks[at] = blocks[at].replace(/\w+/, r.pick(words));
      else if (kind === 3) blocks[at] = `${blocks[at]}\n${r.pick(words)} line`;
      else if (kind === 4) { lines[line] = lines[line].replace(/\w+$/, r.pick(words)); blocks[at] = lines.join("\n"); }
      else if (kind === 5) { lines.splice(line, 0, `- ${r.pick(words)}`); blocks[at] = lines.join("\n"); }
      else if (lines.length > 1) { lines.splice(line, 1); blocks[at] = lines.join("\n"); }
    }
    return blocks.join("\n\n") + "\n";
  };
  let checked = 0;
  for (let run = 0; run < 400; run++) {
    const old = r.bool(0.1) ? null : doc();
    const now = old === null ? doc() : r.bool(0.05) ? null : edit(old);
    if (old === now) continue;
    const { patch, lines, items } = setup(old, now, r.pick([0, 1, 3]));
    // Show previous draws a changed block's version before as a removed block.
    const anchors = items.flatMap((item) => [blockAnchor(lines, item), ...(item.previous ?? []).map((old) => blockAnchor(lines, { status: "removed", side: "LEFT", block: old }))]);
    for (let i = 0; i < items.length; i++) for (let j = i; j < items.length; j++) anchors.push(selectionAnchor(lines, items.slice(i, j + 1)));
    // A table's rows, and any line or lines within blocks, as a row's comment, a code line's, or part of a selection.
    for (const item of items) for (const row of item.block.rows ?? []) anchors.push(rangeAnchor(lines, item.side, row, row));
    for (let k = 0; k < 20 && items.length; k++) {
      const i = r.int(0, items.length - 1), j = r.int(i, Math.min(items.length - 1, i + 3));
      const from = r.int(items[i].block.start, items[i].block.end), to = r.int(items[j].block.start, items[j].block.end);
      anchors.push(selectionAnchor(lines, items.slice(i, j + 1), from, j === i ? Math.max(from, to) : to));
      anchors.push(rangeAnchor(lines, items[i].side, from, items[i].block.end));
    }
    for (const anchor of anchors) {
      if (!anchor) continue;
      const comment = { file: FILE, body: "x", ...anchor };
      expect(invalidComments(patch, [comment]), JSON.stringify({ old, now, anchor })).toEqual([]);
      expect(rangeProblem(patch, comment)).toBeNull();
      if (anchor.side === "LEFT") expect([anchor.startLine ?? anchor.line, anchor.line].every((line) => lines.removed.has(line))).toBe(true);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(1000);
});
