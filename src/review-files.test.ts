import { expect, test } from "vitest";
import { describeReviewFiles, patchPage } from "./review-files";

const file = (path: string, body: string) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const patch = [
  file("src/a.ts", "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n"),
  "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
  "diff --git a/b.ts b/b.ts\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+x\n",
  "diff --git a/c.ts b/c.ts\ndeleted file mode 100644\nindex 1..0\n--- a/c.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-y\n",
  file("package-lock.json", "@@ -1 +1 @@\n-{}\n+{ }\n"),
  file("m.sql", "@@ -1,2 +1,2 @@\n--- note\n+++i;\n keep\n"),
].join("");

test("list_review_files lists each file with its status, line counts, size, and kind", () => {
  const text = describeReviewFiles(patch);
  expect(text).toContain("6 files");
  expect(text).toMatch(/^src\/a\.ts · modified · \+2 −1 · \d+ chars · code$/m);
  expect(text).toMatch(/^new\.ts · renamed from old\.ts · \+0 −0 · \d+ chars · code$/m);
  expect(text).toMatch(/^b\.ts · added · \+1 −0/m);
  expect(text).toMatch(/^c\.ts · deleted · \+0 −1/m);
  expect(text).toMatch(/^package-lock\.json · modified · \+1 −1 · \d+ chars · lockfile$/m);
  // Changed lines that look like file headers still count.
  expect(text).toMatch(/^m\.sql · modified · \+1 −1/m);
  // Files the repo's .gitattributes marks generated say so.
  expect(describeReviewFiles(patch, ["src/a.ts"])).toMatch(/^src\/a\.ts · modified · \+2 −1 · \d+ chars · generated$/m);
});

test("list_review_files marks a file GitHub sent no diff for, and not one whose changed line says so", () => {
  const unsent = "diff --git a/huge.sql b/huge.sql\nGitHub didn't send this file's diff: it's too large or binary.\n";
  const quoting = file("notes.md", "@@ -1 +1 @@\n-a\n+GitHub didn't send this file's diff: it's too large or binary.\n");
  const text = describeReviewFiles(unsent + quoting);
  expect(text).toMatch(/^huge\.sql · modified · \+0 −0 · \d+ chars · code · diff unavailable: read it on GitHub$/m);
  expect(text).toMatch(/^notes\.md · modified · \+1 −1 · \d+ chars · docs$/m);
});

test("patch pages end on file boundaries, unless one file is longer than the page", () => {
  const first = file("a.ts", "@@ -1 +1 @@\n-a\n+b\n");
  const second = file("b.ts", "@@ -1 +1 @@\n-c\n+d\n");
  const page = patchPage(first + second, 0, first.length + 10);
  expect(page).toEqual({ text: first, end: first.length });
  expect(patchPage(first + second, first.length, 100_000)).toEqual({ text: second, end: first.length + second.length });
  expect(patchPage(first + second, 0, first.length + 3)).toEqual({ text: first, end: first.length });
  expect(patchPage(first + second, 0, 20)).toEqual({ text: first.slice(0, 20), end: 20 });
});
