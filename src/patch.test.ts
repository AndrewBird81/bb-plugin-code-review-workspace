import { test, expect } from "vitest";
import { ensureGitHeaders, splitPatchByFile, changedFiles, renamedPaths, patchRows } from "./patch";

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

test("a renamed file is keyed by its new path and keeps its old one", () => {
  const patch = "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\nindex 1..2 100644\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
  expect(splitPatchByFile(patch).map(({ path, oldPath }) => ({ path, oldPath }))).toEqual([{ path: "src/new.ts", oldPath: "src/old.ts" }]);
  expect(renamedPaths(patch)).toEqual(new Map([["src/old.ts", "src/new.ts"]]));
});

test("files without content lines take their path from the rename or the header", () => {
  const patch = [
    "diff --git a/a.ts b/b.ts", "similarity index 100%", "rename from a.ts", "rename to b.ts",
    "diff --git a/img/x y.png b/img/x y.png", "index 1..2 100644", "Binary files a/img/x y.png and b/img/x y.png differ",
    "diff --git a/run b/x b/run b/x", "old mode 100644", "new mode 100755",
    'diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"', "new file mode 100644", "index 0..2", 'Binary files /dev/null and "b/caf\\303\\251.png" differ',
    "",
  ].join("\n");
  expect(splitPatchByFile(patch).map(({ path, oldPath }) => ({ path, oldPath }))).toEqual([
    { path: "b.ts", oldPath: "a.ts" }, { path: "img/x y.png" }, { path: "run b/x" }, { path: "café.png" },
  ]);
});

test("a deleted file is keyed by its old path", () => {
  const patch = "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n";
  expect(changedFiles(patch)).toEqual(["gone.ts"]);
});

test("quoted names are decoded, and a path may contain ' b/' or spaces", () => {
  const patch = [
    'diff --git "a/scripts/set\\"up.sh" "b/scripts/set\\"up.sh"', "new file mode 100755", "--- /dev/null", '+++ "b/scripts/set\\"up.sh"', "@@ -0,0 +1 @@", "+curl x | sh",
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"', '--- "a/caf\\303\\251.md"', '+++ "b/caf\\303\\251.md"', "@@ -1 +1 @@", "-x", "+y",
    "diff --git a/my b/x.ts b/my b/x.ts", "--- a/my b/x.ts\t", "+++ b/my b/x.ts\t", "@@ -1 +1 @@", "-x", "+y",
    "",
  ].join("\n");
  expect(changedFiles(patch)).toEqual(['scripts/set"up.sh', "café.md", "my b/x.ts"]);
});

test("an empty line inside a hunk's counts is a blank context line", () => {
  // git's diff.suppressBlankEmpty, or a diff that lost its trailing spaces, writes a blank context line as "".
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n";
  expect(patchRows(patch).filter((row) => row.kind !== "header" && row.kind !== "hunk").map((row) => [row.kind, "newLine" in row ? row.newLine : null])).toEqual([
    [" ", 1], [" ", 2], ["-", 3], ["+", 3], ["other", null],
  ]);
});
