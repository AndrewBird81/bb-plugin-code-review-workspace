import { test, expect } from "vitest";
import { ensureGitHeaders, splitPatchByFile, changedFiles } from "./patch";

const withHeader = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

const noHeader = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

test("ensureGitHeaders adds a missing diff --git line", () => {
  expect(ensureGitHeaders(noHeader)).toContain("diff --git a/src/a.ts b/src/a.ts");
});

test("ensureGitHeaders leaves an existing header untouched", () => {
  expect(ensureGitHeaders(withHeader)).toBe(withHeader);
});

test("changedFiles lists repo-relative paths", () => {
  const two = withHeader + `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;
  expect(changedFiles(two)).toEqual(["src/a.ts", "src/b.ts"]);
});

test("splitPatchByFile returns one entry per file with its own header", () => {
  const files = splitPatchByFile(withHeader);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("src/a.ts");
  expect(files[0].text).toContain("diff --git a/src/a.ts");
});

test("ensureGitHeaders leaves real git diff (with index lines) unchanged — no duplicate headers", () => {
  const real = `diff --git a/src/a.ts b/src/a.ts
index abc123..def456 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
index 111..222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;
  // header already present → unchanged, and each file appears exactly once
  expect(ensureGitHeaders(real)).toBe(real);
  expect(changedFiles(real)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(splitPatchByFile(real)).toHaveLength(2);
});

test("a hunk line that looks like a file header stays in its file", () => {
  const patch = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,1 @@\n--- a/other.md\n keep\n";
  expect(ensureGitHeaders(patch)).toBe(patch);
  expect(changedFiles(patch)).toEqual(["notes.md"]);
});
