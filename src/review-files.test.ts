import { expect, test } from "vitest";
import { describeReviewFiles, patchPage, stubSkippedFiles } from "./review-files";

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

test("pages stub lockfiles and generated files after their headers, keeping what comes before the first file", () => {
  const code = file("src/a.ts", "@@ -1 +1 @@\n-a\n+b\n");
  expect(stubSkippedFiles(code)).toBe(code);
  const lock = file("yarn.lock", "@@ -1 +1,2 @@\n-a\n+b\n+c\n");
  const binary = "diff --git a/dist/logo.png b/dist/logo.png\nBinary files a/dist/logo.png and b/dist/logo.png differ\n";
  const note = "GitHub listed only the first 3,000 changed files; later files aren't in this review.\n";
  expect(stubSkippedFiles(note + code + lock + binary + file("src/api.ts", "@@ -1 +1 @@\n-x\n+y\n"), ["src/api.ts"])).toBe(note + code
    + "diff --git a/yarn.lock b/yarn.lock\nindex 1..2 100644\n--- a/yarn.lock\n+++ b/yarn.lock\n[lockfile: +2 −1 lines; pass file to read it]\n"
    + binary
    + "diff --git a/src/api.ts b/src/api.ts\nindex 1..2 100644\n--- a/src/api.ts\n+++ b/src/api.ts\n[generated: +1 −1 lines; pass file to read it]\n");
});

test("list_review_files marks a test whose diff removes assertions or skips tests, while Settings flags weakened tests", () => {
  const weakened = file("src/sum.test.ts", "@@ -1,3 +1,2 @@\n-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+it.skip(\"sums\", () => {\n keep();\n");
  const text = describeReviewFiles(weakened + file("src/sum.ts", "@@ -1 +1 @@\n-  assert(a);\n+  b();\n"), [], { testWeakening: true });
  expect(text).toMatch(/^src\/sum\.test\.ts · modified · \+1 −2 · \d+ chars · test · weakened: 2 assertions removed, 1 skip added$/m);
  expect(text).toMatch(/^src\/sum\.ts · modified · \+1 −1 · \d+ chars · code$/m);
  expect(describeReviewFiles(weakened)).not.toContain("weakened");
});

test("list_review_files and a page's lockfile stub summarize a lockfile while Settings summarizes lockfile changes", () => {
  const lockfile = file("package-lock.json", '@@ -1,2 +1,3 @@\n-    "node_modules/is-odd": {\n+    "node_modules/tiny": {\n+      "resolved": "https://evil.example.com/tiny-1.0.0.tgz",\n     "node_modules/left-pad": {\n');
  expect(describeReviewFiles(lockfile, [], { lockfileDigest: true })).toMatch(/^package-lock\.json · modified · \+2 −1 · \d+ chars · lockfile · \+1 −1 packages, downloads from evil\.example\.com$/m);
  expect(stubSkippedFiles(lockfile, [], { lockfileDigest: true })).toContain("[lockfile: +2 −1 lines; +1 −1 packages, downloads from evil.example.com; pass file to read it]");
  expect(describeReviewFiles(lockfile)).toMatch(/^package-lock\.json · modified · \+2 −1 · \d+ chars · lockfile$/m);
  // Off, the stub still names a host an added package downloads from (71-security F1).
  expect(stubSkippedFiles(lockfile)).toContain("[lockfile: +2 −1 lines; downloads from evil.example.com; pass file to read it]");
  const bump = file("package-lock.json", '@@ -1,2 +1,2 @@\n-    "node_modules/is-odd": {\n+    "node_modules/tiny": {\n');
  expect(stubSkippedFiles(bump)).toContain("[lockfile: +1 −1 lines; pass file to read it]");
});

test("a file the PR adds under a path that reads as generated is paged in full and listed as code; one it changes there stays a stub", () => {
  const added = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,2 @@\n+import { exec } from "child_process";\n+exec(process.env.PAYLOAD!);\n`;
  for (const path of ["src/vendor/telemetry.ts", "lib/pods/start.ts", "server/build/hooks.ts", "api/out/auth.ts", "src/api_pb2.py"]) {
    expect(stubSkippedFiles(added(path))).toBe(added(path));
    expect(describeReviewFiles(added(path))).toMatch(new RegExp(`^${path.replace(/\./g, "\\.")} · added · \\+2 −0 · \\d+ chars · code$`, "m"));
  }
  const moved = "diff --git a/src/hook.ts b/vendor/hook.ts\nsimilarity index 90%\nrename from src/hook.ts\nrename to vendor/hook.ts\n--- a/src/hook.ts\n+++ b/vendor/hook.ts\n@@ -1 +1 @@\n-a\n+exec(x);\n";
  expect(stubSkippedFiles(moved)).toBe(moved);
  const changed = file("vendor/lib.js", "@@ -1 +1 @@\n-a\n+b\n");
  expect(stubSkippedFiles(changed)).toContain("[generated: +1 −1 lines; pass file to read it]");
});
