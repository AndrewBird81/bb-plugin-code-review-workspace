import { test, expect } from "vitest";
import { readPrDiff } from "./pr-snapshot";
import { computeFileViewState, fileHashCache, hashForFile } from "./file-views";
import { hashFileDiff, normalizedFileHash } from "./diff-hash";

test("hash is stable for identical input", () => {
  const a = hashFileDiff("diff --git a/x b/x\n+hello\n");
  const b = hashFileDiff("diff --git a/x b/x\n+hello\n");
  expect(a).toBe(b);
});

test("hash changes when the diff text changes", () => {
  const a = hashFileDiff("+hello\n");
  const b = hashFileDiff("+hello world\n");
  expect(a).not.toBe(b);
});

test("hash is a lowercase hex sha256 (64 chars)", () => {
  const h = hashFileDiff("anything");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
});

const fileDiff = (index: string, at: string, context: string, added = "+  run(a, b);") =>
  [
    "diff --git a/src/app.ts b/src/app.ts",
    `index ${index} 100644`,
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    at,
    context,
    "-  run(a);",
    added,
    " }",
    "",
  ].join("\n");

test("normalizedFileHash ignores @@ numbers, index SHAs and context lines", () => {
  const a = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;"));
  const b = normalizedFileHash(fileDiff("3333333..4444444", "@@ -14,3 +14,3 @@ start()", "   const a = 10;"));
  expect(a).toBe(b);
});

test("normalizedFileHash changes when a change line does", () => {
  const a = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;"));
  const b = normalizedFileHash(fileDiff("1111111..2222222", "@@ -10,3 +10,3 @@", "   const a = 1;", "+  run(b, a);"));
  expect(a).not.toBe(b);
});

test("normalizedFileHash of a binary diff keeps the new blob, ignores the base blob", () => {
  const bin = (index: string) => `diff --git a/x.png b/x.png\nindex ${index} 100644\nBinary files a/x.png and b/x.png differ\n`;
  expect(normalizedFileHash(bin("aaaaaaa..bbbbbbb"))).toBe(normalizedFileHash(bin("ccccccc..bbbbbbb")));
  expect(normalizedFileHash(bin("aaaaaaa..bbbbbbb"))).not.toBe(normalizedFileHash(bin("aaaaaaa..ddddddd")));
});

test("a Viewed mark on a file GitHub sent no diff for goes stale when the file's blob changes", async () => {
  const files = (sha: string) => async (args: string[]) => args[1] === "diff"
    ? { code: 1, stdout: "", stderr: "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" }
    : { code: 0, stderr: "", stdout: JSON.stringify({ filename: "data/big.json", status: "modified", sha, additions: 30000, deletions: 0, changes: 30000 }) + "\n" };
  const before = await readPrDiff(files("aaa1111222") as any, 1, "acme/web");
  const same = await readPrDiff(files("aaa1111222") as any, 1, "acme/web");
  const after = await readPrDiff(files("bbb2222333") as any, 1, "acme/web");
  expect(before).toContain("GitHub didn't send this file's diff: it's too large or binary. (blob aaa1111)");
  const viewed = [{ file: "data/big.json", hash: hashForFile(before, "data/big.json")!, viewedAt: 1 }];
  expect(computeFileViewState(viewed, fileHashCache(() => same))).toEqual([{ file: "data/big.json", viewed: true, stale: false, viewedAt: 1 }]);
  expect(computeFileViewState(viewed, fileHashCache(() => after))).toEqual([{ file: "data/big.json", viewed: false, stale: true, viewedAt: 1 }]);
});
