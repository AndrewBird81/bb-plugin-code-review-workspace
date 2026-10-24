import { expect, test } from "vitest";
import { markdownDiff, rowChanges } from "./markdown-diff";
import { gitPatch } from "./markdown-test-patch.test-support";
import { markdownBlocks } from "./markdown-blocks";
import { blockAnchor, fileLines } from "./markdown-anchor";

const statuses = (old: string | null, now: string | null, hideWhitespace = false) =>
  markdownDiff(old, now, gitPatch("doc.md", old, now), hideWhitespace).blocks.map((b) => [b.status, b.side, b.block.start, b.block.end, b.previous?.[0].start ?? null]);

const BASE = "# Tokens\n\nWe want short-lived tokens so a stolen token is useless.\n\n## Lifetime\n\nTokens expire after 1 hour.\n\nRefresh tokens are never rotated.\n\n## Fields\n\nOne field.\n";

test("a block with a changed word is changed, paired with its version before", () => {
  const now = BASE.replace("1 hour", "15 minutes");
  expect(statuses(BASE, now)).toEqual([
    ["unchanged", "RIGHT", 1, 1, null], ["unchanged", "RIGHT", 3, 3, null], ["unchanged", "RIGHT", 5, 5, null],
    ["changed", "RIGHT", 7, 7, 7], ["unchanged", "RIGHT", 9, 9, null], ["unchanged", "RIGHT", 11, 11, null], ["unchanged", "RIGHT", 13, 13, null],
  ]);
});

test("a removed block shows from the old file where it was, before what follows it", () => {
  const now = BASE.replace("Refresh tokens are never rotated.\n\n", "");
  expect(statuses(BASE, now).slice(3, 6)).toEqual([["unchanged", "RIGHT", 7, 7, null], ["removed", "LEFT", 9, 9, null], ["unchanged", "RIGHT", 9, 9, null]]);
});

test("an added section is added, heading and paragraph", () => {
  const now = BASE.replace("## Fields", "## Rotation\n\nRotate on every use.\n\n## Fields");
  expect(statuses(BASE, now).filter(([status]) => status !== "unchanged")).toEqual([["added", "RIGHT", 11, 11, null], ["added", "RIGHT", 13, 13, null]]);
});

test("a block rewritten with other words is removed, and the new one added", () => {
  const now = BASE.replace("Refresh tokens are never rotated.", "Mobile clients cache credentials offline for days.");
  expect(statuses(BASE, now).filter(([status]) => status !== "unchanged")).toEqual([["removed", "LEFT", 9, 9, null], ["added", "RIGHT", 9, 9, null]]);
});

test("a line removed from inside a paragraph changes it", () => {
  const old = "Para\nline two\nline three\n\nNext\n";
  const now = "Para\nline three\n\nNext\n";
  expect(statuses(old, now)).toEqual([["changed", "RIGHT", 1, 2, 1], ["unchanged", "RIGHT", 4, 4, null]]);
});

test("a row added to a table changes the table", async () => {
  const old = "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n";
  const now = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n";
  expect(statuses(old, now)).toEqual([["changed", "RIGHT", 1, 4, 1], ["unchanged", "RIGHT", 6, 6, null]]);
});

test("blocks a kept line links pair in document order", async () => {
  const old = "## Lifetime\n\nTokens expire after 1 hour.\n\nNever rotated.\n\n| a |\n|---|\n| 1 |\n\n```ts\nconst x = 1;\n```\n";
  const now = "## Rotation\n\nOnce each.\n\n## Lifetime\n\nTokens expire after 15 minutes.\n\n| a |\n|---|\n| 1 |\n| 2 |\n\n```ts\nconst x = 2;\n```\n";
  expect(statuses(old, now).filter(([status]) => status !== "unchanged")).toEqual([
    ["added", "RIGHT", 1, 1, null], ["added", "RIGHT", 3, 3, null], ["changed", "RIGHT", 7, 7, 3], ["removed", "LEFT", 5, 5, null], ["changed", "RIGHT", 9, 12, 7], ["changed", "RIGHT", 14, 16, 11],
  ]);
});

// Rewriting every paragraph compared each old one with every new one by a full word diff: 100 took 6 s, 300 took 55 s.
test("a document rewritten throughout reads in reasonable time", () => {
  const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => (seed >= 100000 ? "b" : "a") + ((seed * 7919 + i * 104729) % 5000)).join(" ");
  // Loose enough for a loaded CI machine; the freeze took seconds.
  for (const [count, ms] of [[100, 1500], [300, 3000]]) {
    const old = Array.from({ length: count }, (_, i) => words(i, 60)).join("\n\n") + "\n";
    const now = Array.from({ length: count }, (_, i) => words(i + 100000, 60)).join("\n\n") + "\n";
    const patch = gitPatch("doc.md", old, now);
    const start = performance.now();
    const { blocks } = markdownDiff(old, now, patch);
    expect(performance.now() - start).toBeLessThan(ms);
    expect([blocks.filter((b) => b.status === "removed").length, blocks.filter((b) => b.status === "added").length]).toEqual([count, count]);
  }
});

// Timed as a ratio, which load slows on both sides: from 250 to 1,000 paragraphs the time grows 4 to 6 times, where the
// pairing that recursed, cubic, grew 20 to 30 times.
test("a search and replace over every paragraph, or a rewrite of each a little more than the last, takes time near in proportion", () => {
  const replace = (count: number) => {
    const old = Array.from({ length: count }, (_, i) => `The foo service handles request number ${i} quickly.`).join("\n\n") + "\n";
    return [old, old.replace(/foo/g, "bar")] as const;
  };
  const rewrite = (count: number) => {
    const words = (i: number, keep: number) => Array.from({ length: 20 }, (_, k) => (k < keep ? `w${i}x${k}` : `z${i}y${k}`)).join(" ");
    return [Array.from({ length: count }, (_, i) => words(i, 20)).join("\n\n") + "\n", Array.from({ length: count }, (_, i) => words(i, 20 - Math.floor((i * 10) / count))).join("\n\n") + "\n"] as const;
  };
  for (const make of [replace, rewrite]) {
    // The median of three runs.
    const time = (count: number) => {
      const [old, now] = make(count);
      const patch = gitPatch("doc.md", old, now);
      return [0, 1, 2].map(() => { const start = performance.now(); markdownDiff(old, now, patch); return performance.now() - start; }).sort((a, b) => a - b)[1];
    };
    const [small, large] = [time(250), time(1000)];
    expect(large / small).toBeLessThan(10);
    expect(large).toBeLessThan(10_000);
  }
  const [old, now] = replace(200);
  expect(markdownDiff(old, now, gitPatch("doc.md", old, now)).blocks.every((b) => b.status === "changed")).toBe(true);
});

test("blank lines added or removed between blocks change nothing, with any context", () => {
  const gap = "\n".repeat(9);
  const old = `Alpha para.\n${gap}Bravo para.\n\nCharlie.\n`;
  for (const now of [`Alpha para.\n${gap.slice(1)}Bravo para.\n\nCharlie.\n`, `Alpha para.\n${gap}\nBravo para.\n\nCharlie.\n`]) {
    for (const context of [0, 1, 3]) {
      expect(markdownDiff(old, now, gitPatch("doc.md", old, now, context)).blocks.map((b) => [b.status, b.block.source])).toEqual([["unchanged", "Alpha para."], ["unchanged", "Bravo para."], ["unchanged", "Charlie."]]);
    }
  }
});

test("a moved section shows as removed where it was and added where it went", () => {
  const section = (name: string) => `## Section ${name}\n\nBody of section ${name} with its own words.\n`;
  const old = [section("one"), section("two"), section("three")].join("\n");
  const now = [section("two"), section("one"), section("three")].join("\n");
  const shown = markdownDiff(old, now, gitPatch("doc.md", old, now)).blocks.filter((b) => b.status !== "unchanged").map((b) => [b.status, b.block.source]);
  expect(shown).toEqual(expect.arrayContaining([["removed", "## Section one"], ["removed", "Body of section one with its own words."], ["added", "## Section one"], ["added", "Body of section one with its own words."]]));
});

test("blocks joined across a removed heading show the heading removed, and each joined block before", () => {
  const old = "x line one\n\n## Heading Y\n\nz line two\n\nEnd.\n";
  const now = "x line one\nz line two\n\nEnd.\n";
  const { blocks } = markdownDiff(old, now, gitPatch("doc.md", old, now));
  expect(blocks.map((b) => [b.status, b.side, b.block.start, b.previous?.map((p) => [p.kind, p.start]) ?? null])).toEqual([
    ["changed", "RIGHT", 1, [["paragraph", 1], ["paragraph", 5]]], ["removed", "LEFT", 3, null], ["unchanged", "RIGHT", 4, null],
  ]);
});

test("a table or fence changed in two hunks is one changed block; a list's items change on their own", () => {
  const items = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n");
  const list = `# T\n\n${items(20, (i) => `- item ${i}`)}\n`;
  expect(statuses(list, list.replace("- item 0\n", "- item 0\n- new item\n").replace("- item 18\n", "")).filter(([status]) => status !== "unchanged"))
    .toEqual([["added", "RIGHT", 4, 4, null], ["removed", "LEFT", 21, 21, null]]);
  const table = `| a | b |\n|---|---|\n${items(20, (i) => `| r${i} | v |`)}\n`;
  expect(statuses(table, table.replace("| r1 | v |\n", "| r1 | v |\n| new | v |\n").replace("| r17 | v |\n", ""))).toEqual([["changed", "RIGHT", 1, 22, 1]]);
  const fence = `\`\`\`js\n${items(20, (i) => `let x${i} = ${i};`)}\n\`\`\`\n`;
  expect(statuses(fence, fence.replace("let x1 = 1;\n", "let x1 = 1;\nlet added = 0;\n").replace("let x17 = 17;\n", ""))).toEqual([["changed", "RIGHT", 1, 22, 1]]);
});

test("a paragraph that keeps its first line and grows is changed, however much it grows", () => {
  const old = "# T\n\nShort para.\n\nNext.\n";
  expect(statuses(old, old.replace("Short para.\n", "Short para.\nAnd a much longer continuation sentence that adds many words to it here.\n"))).toEqual([
    ["unchanged", "RIGHT", 1, 1, null], ["changed", "RIGHT", 3, 4, 3], ["unchanged", "RIGHT", 6, 6, null],
  ]);
});

test("blocks that keep each other's lines are one change with no context lines in the diff too", () => {
  const old = "# T\n\n- a\n- b\n\nTwo-line\nparagraph here.\n\nEnd.\n";
  const now = "# T\n\n- a\n- b\nTwo-line\nparagraph here.\n\nEnd.\n";
  for (const context of [0, 1, 3]) {
    expect(markdownDiff(old, now, gitPatch("doc.md", old, now, context)).blocks.map((b) => [b.status, b.block.start, b.previous?.map((p) => p.start) ?? null]))
      .toEqual([["unchanged", 1, null], ["unchanged", 3, null], ["changed", 4, [4, 6]], ["unchanged", 8, null]]);
  }
});

test("a paragraph split by a blank line, or two joined, is changed, each half with the paragraph it was", () => {
  expect(statuses("Line one of para.\nLine two of para.\n", "Line one of para.\n\nLine two of para.\n")).toEqual([["changed", "RIGHT", 1, 1, 1], ["changed", "RIGHT", 3, 3, 1]]);
  expect(statuses("Line one.\n\nLine two.\n", "Line one.\nLine two.\n")).toEqual([["changed", "RIGHT", 1, 2, 1]]);
  // A blank line added between blocks changes nothing that renders.
  expect(statuses("A.\n\nB.\n", "A.\n\n\nB.\n")).toEqual([["unchanged", "RIGHT", 1, 1, null], ["unchanged", "RIGHT", 4, 4, null]]);
});

test("a rewritten block pairs with the one most like it", () => {
  expect(statuses("A para.\n\nB para.\n\nC para.\n\nD para.\n", "A para.\n\nC para changed.\n\nD para.\n")).toEqual([
    ["unchanged", "RIGHT", 1, 1, null], ["removed", "LEFT", 3, 3, null], ["changed", "RIGHT", 3, 3, 5], ["unchanged", "RIGHT", 5, 5, null],
  ]);
});

// Lined up by text alone, a moved section's `---` matched another copy than git's: a removed `---` with no removed line.
test("a block the diff keeps doesn't show as removed for matching another copy of its text", () => {
  const section = (n: number) => `## Step ${n}\n\nDo the thing number ${n} carefully.\n\n---\n`;
  const doc = (order: number[]) => `# Guide\n\n${order.map(section).join("\n")}`;
  const [old, now] = [doc([1, 2, 3, 4, 5]), doc([1, 4, 2, 3, 5])];
  // git diff's own (myers), which keeps every `---` where it was.
  const patch = ["diff --git a/doc.md b/doc.md", "--- a/doc.md", "+++ b/doc.md", "@@ -6,21 +6,21 @@ Do the thing number 1 carefully.", " ", " ---", " ",
    ...[[2, 4], [3, 2], [4, 3]].flatMap(([was, is]) => [`-## Step ${was}`, `+## Step ${is}`, " ", `-Do the thing number ${was} carefully.`, `+Do the thing number ${is} carefully.`, " ", " ---", " "]), ""].join("\n");
  const { blocks } = markdownDiff(old, now, patch);
  const lines = fileLines(patch, "doc.md");
  expect(blocks.filter((b) => b.side === "LEFT" && !blockAnchor(lines, b))).toEqual([]);
  expect(blocks.filter((b) => b.block.source === "---").map((b) => b.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
});

// Past jsdiff's edit cap, a run paired nothing: every paragraph showed twice, removed and added.
test("a run with more edits than the pairing's cap still pairs its blocks in order", () => {
  const paragraphs = Array.from({ length: 200 }, (_, i) => `The foo service handles request number ${i} quickly.`);
  const old = paragraphs.join("\n\n") + "\n";
  const now = paragraphs.flatMap((p, i) => [p.replace("foo", "bar"), ...(i < 120 ? [`Brand new note ${i} about zebras.`] : [])]).join("\n\n") + "\n";
  const counts = markdownDiff(old, now, gitPatch("doc.md", old, now)).blocks.reduce<Record<string, number>>((n, b) => ({ ...n, [b.status]: (n[b.status] ?? 0) + 1 }), {});
  expect(counts).toEqual({ changed: 200, added: 120 });
});

test("a list's added, changed and removed items each show as such", () => {
  const old = "Steps:\n\n- Install the CLI.\n- Sign in with your token.\n- Run the tests.\n- Clean up.\n";
  const now = "Steps:\n\n- Install the CLI.\n- Sign in with your SSO account.\n- Configure the project.\n- Run the tests.\n";
  expect(statuses(old, now)).toEqual([
    ["unchanged", "RIGHT", 1, 1, null], ["unchanged", "RIGHT", 3, 3, null], ["changed", "RIGHT", 4, 4, 4], ["added", "RIGHT", 5, 5, null],
    ["unchanged", "RIGHT", 6, 6, null], ["removed", "LEFT", 6, 6, null],
  ]);
});

test("an ordered list's items renumbered by an insertion are unchanged", () => {
  const old = "1. one\n2. two\n3. three\n";
  const now = "1. one\n2. new\n3. two\n4. three\n";
  expect(statuses(old, now)).toEqual([["unchanged", "RIGHT", 1, 1, null], ["added", "RIGHT", 2, 2, null], ["unchanged", "RIGHT", 3, 3, null], ["unchanged", "RIGHT", 4, 4, null]]);
});

test("a block reworded with a word's case changed is changed, not removed and added", () => {
  expect(statuses("## Goals\n\nText.\n", "## Design goals\n\nText.\n")).toEqual([["changed", "RIGHT", 1, 1, 1], ["unchanged", "RIGHT", 3, 3, null]]);
});

test("a changed table's rows say whether each is new or changed, against its version before", () => {
  const { blocks: [old] } = markdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n");
  const { blocks: [now] } = markdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 9 |\n| 7 | 8 |\n| 5 | 6 |\n");
  expect(rowChanges(old, now)).toEqual([null, null, "changed", "added", null]);
  // The header too; a table with no version before has none.
  const { blocks: [header] } = markdownBlocks("| a | c |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n");
  expect(rowChanges(old, header)).toEqual(["changed", null, null, null]);
});

test("a new file is all added, a deleted one all removed", () => {
  expect(statuses(null, "# A\n\nB\n")).toEqual([["added", "RIGHT", 1, 1, null], ["added", "RIGHT", 3, 3, null]]);
  expect(statuses("# A\n\nB\n", null)).toEqual([["removed", "LEFT", 1, 1, null], ["removed", "LEFT", 3, 3, null]]);
});

test("with whitespace hidden, a block whose change is only whitespace is unchanged", () => {
  const now = BASE.replace("Tokens expire after 1 hour.", "Tokens  expire after 1 hour. ");
  expect(statuses(BASE, now)[3]).toEqual(["changed", "RIGHT", 7, 7, 7]);
  expect(statuses(BASE, now, true)[3]).toEqual(["unchanged", "RIGHT", 7, 7, null]);
});

test("blocks in two hunks each pair within their own hunk", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} says something.`).join("\n\n") + "\n";
  const now = long.replace("Paragraph 1 says", "Paragraph 1 now says").replace("Paragraph 10 says", "Paragraph 10 now says");
  expect(statuses(long, now).filter(([status]) => status !== "unchanged")).toEqual([["changed", "RIGHT", 3, 3, 3], ["changed", "RIGHT", 21, 21, 21]]);
});
