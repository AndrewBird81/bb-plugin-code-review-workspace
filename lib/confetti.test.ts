import { expect, test } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { confettiCSS, confettiRows } from "./confetti";

const parse = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)[0]!;

// A Terraform file handing its bucket to another stack: each deleted line is paired with an added one that has
// nothing to do with it, so pierre would mark nearly every word of all six pairs.
const movedOut = `diff --git a/infra/s3.tf b/infra/s3.tf
--- a/infra/s3.tf
+++ b/infra/s3.tf
@@ -1,12 +1,12 @@
-resource "aws_s3_bucket" "media" {
-  bucket = "media-\${var.env}"
+# media-{env} and its bucket policy now live in the platform stack, which
+# applies them from CI. Two stacks owning one bucket kept undoing each other.
+# Forget them here without touching the bucket.
+removed {
+  from = aws_s3_bucket.media
 
-  grant {
-    id = "a1b2c3d4" // staging
-    permissions = ["READ", "WRITE"]
-    type = "CanonicalUser"
+  lifecycle {
+    destroy = false
   }
-resource "aws_s3_bucket_policy" "media" {
-  bucket = aws_s3_bucket.media.id
-  policy = data.aws_iam_policy_document.media.json
+removed {
+  from = aws_s3_bucket_policy.media
 }
`;

// Code Review Workspace's own src/patch.ts, three real edits: their changed words are what to read.
const edits = `diff --git a/src/patch.ts b/src/patch.ts
--- a/src/patch.ts
+++ b/src/patch.ts
@@ -94,8 +94,9 @@ export function splitPatchByFile(patch: string): readonly PatchFile[] {
   if (lastSplit?.patch === patch) return lastSplit.files;
   const normalized = ensureGitHeaders(patch);
   const chunks = normalized.split(/\\n(?=diff --git )/g).filter((c) => c.startsWith("diff --git "));
-  const files = Object.freeze(chunks.map((text) => Object.freeze({ ...fileNames(text), text: text.endsWith("\\n") ? text : text + "\\n" })));
+  const files: readonly PatchFile[] = Object.freeze(chunks.map((text) => Object.freeze({ ...fileNames(text), text: text.endsWith("\\n") ? text : text + "\\n" })));
   if (files.length > 1 || !lastSplit || lastSplit.files.length <= 1) lastSplit = { patch, files };
+  if (!files.length) return EMPTY;
   return files;
 }
 
@@ -154,7 +155,7 @@ export function unquote(name: string): string {
 /** A \`---\`/\`+++\` name: null for /dev/null. Git ends an unquoted name that has a space with a tab. */
 function markerName(rest: string, prefix: "a/" | "b/"): string | null {
   const raw = rest.replace(/\\r$/, "");
-  const name = raw.startsWith('"') ? unquote(raw) : raw.split("\\t")[0];
+  const name = raw.startsWith('"') ? unquote(raw) : raw.split("\\t")[0].trimEnd();
   if (name === "/dev/null") return null;
   return name.startsWith(prefix) ? name.slice(2) : name;
 }
@@ -194,7 +195,7 @@ function fileNames(text: string): { path: string; oldPath?: string } {
   let renameFrom: string | undefined, renameTo: string | undefined, copyTo: string | undefined;
   let minus: string | null | undefined, plus: string | null | undefined;
   // Only the header: the hunks can be most of the text.
-  const end = text.indexOf("\\n@@");
+  const end = text.search(/\\n@@ -\\d/);
   for (const { kind, text: line } of patchRows(end < 0 ? text : text.slice(0, end))) {
     if (kind === "hunk") break;
     if (line.startsWith("diff --git ")) header = headerNames(line);
`;

test("pairs of lines that share almost nothing lose their word emphasis: all six where a file hands its resources away", () => {
  const rows = confettiRows(parse(movedOut));
  expect(rows.map((row) => [row.old, row.new])).toEqual([[1, 1], [2, 2], [4, 7], [5, 8], [9, 10], [10, 11]]);
  expect(rows.filter((row) => row.noisy)).toHaveLength(6);
  expect(Math.max(...rows.map((row) => row.similarity))).toBeLessThan(0.4);
});

test("real edits keep theirs: three of three in src/patch.ts", () => {
  const rows = confettiRows(parse(edits));
  expect(rows.map((row) => [row.old, row.new])).toEqual([[97, 97], [157, 158], [197, 198]]);
  expect(rows.filter((row) => row.noisy)).toEqual([]);
  expect(confettiCSS(rows)).toBe("");
});

test("a pair with a line over 1,000 characters is left as pierre draws it", () => {
  const long = "x".repeat(1001);
  const rows = confettiRows(parse(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-${long}\n+short\n-alpha beta\n+gamma delta\n`));
  expect(rows.map((row) => row.old)).toEqual([2]);
});

test("the styles name each noisy pair's deleted and added row, by their numbers", () => {
  const css = confettiCSS([{ old: 4, new: 7, similarity: 0.1, noisy: true }, { old: 9, new: 9, similarity: 0.9, noisy: false }]);
  expect(css).toBe('[data-line-type="change-deletion"][data-line="4"] [data-diff-span],\n[data-line-type="change-addition"][data-line="7"] [data-diff-span] { background-color: transparent; }\n');
});
