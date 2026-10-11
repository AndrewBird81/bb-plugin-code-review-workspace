import { expect, test } from "vitest";
import { hideWhitespaceChanges } from "./whitespace";
import { patchRows } from "./patch";

const file = (hunks: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks}`;

/** Every line's old and new numbers, by its text, so a changed layout can be checked against the original's numbering. */
function numbers(patch: string) {
  return patchRows(patch).flatMap((row) => row.kind === "+" || row.kind === "-" || row.kind === " " ? [[row.kind, row.text.slice(1), row.oldLine, row.newLine] as const] : []);
}

test("a reindented block shows as unchanged lines, with the new indentation", () => {
  const patch = file("@@ -1,3 +1,3 @@\n if (x) {\n-  a();\n-  b();\n+    a();\n+    b();\n");
  expect(hideWhitespaceChanges(patch)).toBe(file("@@ -1,3 +1,3 @@\n if (x) {\n     a();\n     b();\n"));
});

test("code wrapped in a new block keeps the wrapper as added and the moved line as unchanged", () => {
  const patch = file("@@ -1,2 +1,4 @@\n start();\n-run();\n+if (ok) {\n+  run();\n+}\n");
  const hidden = hideWhitespaceChanges(patch);
  expect(hidden).toBe(file("@@ -1,2 +1,4 @@\n start();\n+if (ok) {\n   run();\n+}\n"));
  // The unchanged line keeps the removed line's old number and the added line's new one.
  expect(numbers(hidden)).toEqual([[" ", "start();", 1, 1], ["+", "if (ok) {", 2, 2], [" ", "  run();", 2, 3], ["+", "}", 3, 4]]);
});

test("removed lines before the match keep their numbers, and the hunk's counts still add up", () => {
  const patch = file("@@ -10,4 +10,3 @@\n-gone();\n-  kept();\n-alsoGone();\n+kept();\n+added();\n keep();\n");
  const hidden = hideWhitespaceChanges(patch);
  expect(hidden).toBe(file("@@ -10,4 +10,3 @@\n-gone();\n kept();\n-alsoGone();\n+added();\n keep();\n"));
  expect(numbers(hidden)).toEqual([["-", "gone();", 10, 10], [" ", "kept();", 11, 10], ["-", "alsoGone();", 12, 11], ["+", "added();", 13, 11], [" ", "keep();", 13, 12]]);
});

test("only a line equal but for whitespace becomes unchanged; a real change stays", () => {
  const patch = file("@@ -1,2 +1,2 @@\n-a = 1;\n-call(x,y);\n+a = 2;\n+call(x, y);\n");
  expect(hideWhitespaceChanges(patch)).toBe(file("@@ -1,2 +1,2 @@\n-a = 1;\n+a = 2;\n call(x, y);\n"));
});

test("a diff with nothing but real changes comes back as it was", () => {
  const patch = file("@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -9 +9 @@\n-d\n+e\n");
  expect(hideWhitespaceChanges(patch)).toBe(patch);
});

test("line endings changed from CRLF count as whitespace", () => {
  const patch = file("@@ -1 +1 @@\n-a\r\n+a\n");
  expect(hideWhitespaceChanges(patch)).toBe(file("@@ -1 +1 @@\n a\n"));
});

test("a line that gains or loses its final newline stays a change, with its marker", () => {
  const patch = file("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n");
  expect(hideWhitespaceChanges(patch)).toBe(patch);
});

test("each hunk and each file is matched on its own", () => {
  const other = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+ x\n";
  const patch = file("@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-b\n+c\n") + other;
  // b is removed in one hunk and added in another: not a whitespace change.
  expect(hideWhitespaceChanges(patch)).toBe(file("@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-b\n+c\n") + "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n  x\n");
});

test("a removed '-- note' and an added '++i' are hunk lines, not headers", () => {
  const patch = file("@@ -1,2 +1,2 @@\n--- note\n-++i;\n+-- note\n+++i;\n");
  expect(hideWhitespaceChanges(patch)).toBe(file("@@ -1,2 +1,2 @@\n -- note\n ++i;\n"));
});
