import { expect, test } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { diffPositions } from "../src/review-positions";
import { genHunks, rng } from "../src/fuzz-gen.test-support";
import { withBlankContext } from "./blank-context";

/** Each line pierre draws, by side and number, with its text. */
function drawn(text: string) {
  const file = parsePatchFiles(withBlankContext(text)).flatMap((p) => p.files)[0];
  const right = new Map<number, string>(), left = new Map<number, string>();
  if (!file) return { right, left };
  const strip = (s: string | undefined) => (s ?? "<none>").replace(/\r?\n$/, "");
  for (const hunk of file.hunks) {
    let o = hunk.deletionStart, n = hunk.additionStart;
    for (const c of hunk.hunkContent) {
      if (c.type === "context") for (let k = 0; k < c.lines; k++) { right.set(n++, strip(file.additionLines[c.additionLineIndex + k])); left.set(o++, strip(file.deletionLines[c.deletionLineIndex + k])); }
      else {
        for (let k = 0; k < c.deletions; k++) left.set(o++, strip(file.deletionLines[c.deletionLineIndex + k]));
        for (let k = 0; k < c.additions; k++) right.set(n++, strip(file.additionLines[c.additionLineIndex + k]));
      }
    }
  }
  return { right, left };
}
const sorted = (m: Map<number, string>) => [...m].sort((a, b) => a[0] - b[0]);

// bug bash FUZ-3: with git's diff.suppressBlankEmpty, which a local review's `git diff` honors, the diff drew every
// line after a blank context line one number short of where comments are saved and checked.
test("a blank context line written as \"\" is drawn, so the lines after it keep the numbers comments are saved and checked at", () => {
  // `git -c diff.suppressBlankEmpty=true diff` of "a\n\nb\nc\n" → "a\n\nB\nc\n".
  const patch = "diff --git a/f b/f\nindex 068025d..852bc95 100644\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n\n-b\n+B\n c\n";
  const server = diffPositions(patch).get("f")!;
  expect(server.left.get(3)).toBe("b");
  expect(server.right.get(3)).toBe("B");
  const { left, right } = drawn(patch);
  expect(left.get(3)).toBe("b");
  expect(right.get(3)).toBe("B");
  expect(right.get(2)).toBe("");
});

test("only a blank line inside a hunk's counts is context: one between files, or a diff without one, stays as it was", () => {
  const two = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n\ndiff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n";
  expect(withBlankContext(two)).toBe(two);
  const plain = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
  expect(withBlankContext(plain)).toBe(plain);
});

test("the lines the diff draws are the lines the server takes comments on, with the same text", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const r = rng(seed);
    const { text: body } = genHunks(r);
    const text = `diff --git a/f.ts b/f.ts\nindex 1..2 100644\n--- a/f.ts\n+++ b/f.ts\n${body}\n`;
    const server = diffPositions(text).get("f.ts")!;
    const ui = drawn(text);
    expect(JSON.stringify({ seed, right: sorted(ui.right) })).toBe(JSON.stringify({ seed, right: sorted(server.right) }));
    expect(JSON.stringify({ seed, left: sorted(ui.left) })).toBe(JSON.stringify({ seed, left: sorted(server.left) }));
  }
});
