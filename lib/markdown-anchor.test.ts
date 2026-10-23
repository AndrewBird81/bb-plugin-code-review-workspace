import { expect, test } from "vitest";
import { invalidComments, rangeProblem } from "../src/review-positions";
import { rng } from "../src/fuzz-gen.test-support";
import { blockAnchor, blockAt, fileLines, selectionAnchor } from "./markdown-anchor";
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

// Every anchor the rendered view makes is one GitHub takes: its line in the diff, a range in one hunk in order, and a
// removed block's only on lines the diff removes.
test("every block's and every selection's anchor is valid on GitHub", () => {
  const r = rng(20261023);
  const pool = ["# Heading", "## Sub", "Short paragraph.", "Two-line\nparagraph here.", "- a\n- b\n- c", "1. one\n2. two", "| a | b |\n|---|---|\n| 1 | 2 |", "```ts\nconst x = 1;\nconst y = 2;\n```", "> quote", "---", "<details>\n\nhidden\n\n</details>", "[d]: https://example.com"];
  const words = ["token", "rotation", "expires", "client", "gateway", "refresh"];
  const doc = () => Array.from({ length: r.int(3, 14) }, () => r.pick(pool)).join("\n\n") + "\n";
  const edit = (text: string) => {
    const blocks = text.trimEnd().split("\n\n");
    for (let i = r.int(1, 4); i > 0; i--) {
      const at = r.int(0, blocks.length - 1);
      const kind = r.int(0, 3);
      if (kind === 0) blocks.splice(at, 1);
      else if (kind === 1) blocks.splice(at, 0, r.pick(pool));
      else if (kind === 2) blocks[at] = blocks[at].replace(/\w+/, r.pick(words));
      else blocks[at] = `${blocks[at]}\n${r.pick(words)} line`;
    }
    return blocks.join("\n\n") + "\n";
  };
  let checked = 0;
  for (let run = 0; run < 300; run++) {
    const old = r.bool(0.1) ? null : doc();
    const now = old === null ? doc() : r.bool(0.05) ? null : edit(old);
    if (old === now) continue;
    const { patch, lines, items } = setup(old, now, r.pick([0, 1, 3]));
    // Show previous draws a changed block's version before as a removed block.
    const anchors = items.flatMap((item) => [blockAnchor(lines, item), ...(item.previous ?? []).map((old) => blockAnchor(lines, { status: "removed", side: "LEFT", block: old }))]);
    for (let i = 0; i < items.length; i++) for (let j = i; j < items.length; j++) anchors.push(selectionAnchor(lines, items.slice(i, j + 1)));
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
