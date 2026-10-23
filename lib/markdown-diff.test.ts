import { expect, test } from "vitest";
import { markdownDiff } from "./markdown-diff";
import { gitPatch } from "./markdown-test-patch.test-support";

const statuses = (old: string | null, now: string | null, hideWhitespace = false) =>
  markdownDiff(old, now, gitPatch("doc.md", old, now), hideWhitespace).blocks.map((b) => [b.status, b.side, b.block.start, b.block.end, b.previous?.start ?? null]);

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
    ["added", "RIGHT", 1, 1, null], ["added", "RIGHT", 3, 3, null], ["removed", "LEFT", 5, 5, null], ["changed", "RIGHT", 7, 7, 3], ["changed", "RIGHT", 9, 12, 7], ["changed", "RIGHT", 14, 16, 11],
  ]);
});

// Rewriting every paragraph compared each old one with every new one by a full word diff: 100 took 6 s, 300 took 55 s.
test("a document rewritten throughout reads in reasonable time", () => {
  const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => (seed >= 100000 ? "b" : "a") + ((seed * 7919 + i * 104729) % 5000)).join(" ");
  for (const [count, ms] of [[100, 200], [300, 600]]) {
    const old = Array.from({ length: count }, (_, i) => words(i, 60)).join("\n\n") + "\n";
    const now = Array.from({ length: count }, (_, i) => words(i + 100000, 60)).join("\n\n") + "\n";
    const patch = gitPatch("doc.md", old, now);
    const start = performance.now();
    const { blocks } = markdownDiff(old, now, patch);
    expect(performance.now() - start).toBeLessThan(ms);
    expect([blocks.filter((b) => b.status === "removed").length, blocks.filter((b) => b.status === "added").length]).toEqual([count, count]);
  }
});

test("a list, table or fence changed in two hunks is one changed block", () => {
  const items = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n");
  const list = `# T\n\n${items(20, (i) => `- item ${i}`)}\n`;
  expect(statuses(list, list.replace("- item 0\n", "- item 0\n- new item\n").replace("- item 18\n", ""))).toEqual([["unchanged", "RIGHT", 1, 1, null], ["changed", "RIGHT", 3, 22, 3]]);
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

test("a paragraph split by a blank line, or two joined, is changed", () => {
  expect(statuses("Line one of para.\nLine two of para.\n", "Line one of para.\n\nLine two of para.\n")).toEqual([["changed", "RIGHT", 1, 1, 1], ["changed", "RIGHT", 3, 3, null]]);
  expect(statuses("Line one.\n\nLine two.\n", "Line one.\nLine two.\n")).toEqual([["changed", "RIGHT", 1, 2, 1]]);
  // A blank line added between blocks changes nothing that renders.
  expect(statuses("A.\n\nB.\n", "A.\n\n\nB.\n")).toEqual([["unchanged", "RIGHT", 1, 1, null], ["unchanged", "RIGHT", 4, 4, null]]);
});

test("a rewritten block pairs with the one most like it", () => {
  expect(statuses("A para.\n\nB para.\n\nC para.\n\nD para.\n", "A para.\n\nC para changed.\n\nD para.\n")).toEqual([
    ["unchanged", "RIGHT", 1, 1, null], ["removed", "LEFT", 3, 3, null], ["changed", "RIGHT", 3, 3, 5], ["unchanged", "RIGHT", 5, 5, null],
  ]);
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
