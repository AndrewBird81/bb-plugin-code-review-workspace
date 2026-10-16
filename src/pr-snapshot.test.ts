import { expect, test, vi } from "vitest";
import { readPrDiff, readPrSnapshot } from "./pr-snapshot";
import { describeReviewFiles, patchPage, stubSkippedFiles } from "./review-files";
import { splitPatchByFile } from "./patch";
import { diffPositions } from "./review-positions";

const pr = { headRefOid: "old", title: "Change", baseRefName: "main", headRefName: "feature", url: "https://github.com/acme/web/pull/7" };
test("a commit pushed while fetching the diff cannot be saved under the previous head", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(pr), stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: "a diff", stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ headRefOid: "new" }), stderr: "" });
  await expect(readPrSnapshot(run, 7, "acme/web")).rejects.toThrow("PR changed");
});

test("gh output that doesn't name the PR's head is refused, saying why", async () => {
  const run = vi.fn().mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ...pr, headRefOid: "" }), stderr: "" });
  await expect(readPrSnapshot(run, 7, "acme/web")).rejects.toThrow("Unexpected gh PR output. Couldn't identify the revision to review.");
});

test("a failed head check preserves the GitHub error and rejects the snapshot", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(pr), stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: "a diff", stderr: "" })
    .mockResolvedValueOnce({ code: 1, stdout: '{"message":"Bad credentials"}', stderr: "HTTP 401" });
  await expect(readPrSnapshot(run, 7, "acme/web")).rejects.toThrow("Bad credentials");
});

const tooLarge = { code: 1, stdout: "", stderr: "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/acme/web/pulls/7)" };
const files = [
  { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
  { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", patch: "@@ -1 +1 @@\n-x\n+y" },
  { filename: "src/added.ts", status: "added", patch: "@@ -0,0 +1 @@\n+n" },
  { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-g" },
  { filename: "dist/huge.js", status: "modified" },
  { filename: 'odd"name b/x.ts', status: "modified", patch: "@@ -1 +1 @@\n-p\n+q" },
];

test("a PR too big for GitHub's diff is rebuilt from its files", async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "diff") return tooLarge;
    if (args[0] === "api") return { code: 0, stdout: files.map((f) => JSON.stringify(f)).join("\n") + "\n", stderr: "" };
    return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
  });
  const { patch } = await readPrSnapshot(run, 7, "acme/web");
  expect(run).toHaveBeenCalledWith(["api", "--paginate", "repos/acme/web/pulls/7/files?per_page=100", "--jq", ".[] | @json"], { cwd: undefined });
  const split = splitPatchByFile(patch);
  expect(split.map(({ path, oldPath }) => ({ path, oldPath }))).toEqual([
    { path: "src/a.ts" }, { path: "src/new.ts", oldPath: "src/old.ts" }, { path: "src/added.ts" }, { path: "src/gone.ts" }, { path: "dist/huge.js" }, { path: 'odd"name b/x.ts' },
  ]);
  expect(diffPositions(patch).get("src/new.ts")?.right.get(1)).toBe("y");
  expect(diffPositions(patch).get("src/gone.ts")?.left.get(1)).toBe("g");
  expect(diffPositions(patch).get('odd"name b/x.ts')?.right.get(1)).toBe("q");
  expect(split[4].text).toContain("GitHub didn't send this file's diff");
});

test("other diff failures still fail with GitHub's message", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(pr), stderr: "" })
    .mockResolvedValueOnce({ code: 1, stdout: '{"message":"Not Found"}', stderr: "HTTP 404" });
  await expect(readPrSnapshot(run, 7, "acme/web")).rejects.toThrow("Not Found");
  expect(run).toHaveBeenCalledTimes(2);
});

test("a pure rename rebuilt from the PR's files has no note about a missing diff", async () => {
  const renamed = [{ filename: "src/b.ts", previous_filename: "src/a.ts", status: "renamed", changes: 0 }];
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "diff") return tooLarge;
    if (args[0] === "api") return { code: 0, stdout: renamed.map((f) => JSON.stringify(f)).join("\n") + "\n", stderr: "" };
    return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
  });
  const [file] = splitPatchByFile((await readPrSnapshot(run, 7, "acme/web")).patch);
  expect(file).toMatchObject({ path: "src/b.ts", oldPath: "src/a.ts" });
  expect(file.text).not.toContain("GitHub didn't send");
});

test("a diff rebuilt from GitHub's 3,000-file list says later files may be missing, first in list_review_files and the first page", async () => {
  const listed = (count: number) => Array.from({ length: count }, (_, i) => JSON.stringify({ filename: `f${i}.ts`, status: "modified", changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" })).join("\n") + "\n";
  const read = (count: number) => readPrDiff(vi.fn(async (args: string[]) => args[0] === "api" ? { code: 0, stderr: "", stdout: listed(count) } : tooLarge), 7, "acme/web");
  const note = "GitHub listed only the first 3,000 changed files; later files aren't in this review.";
  const patch = await read(3000);
  expect(patch.startsWith(`${note}\ndiff --git a/f0.ts b/f0.ts\n`)).toBe(true);
  // The diff itself doesn't show it.
  expect(splitPatchByFile(patch)).toHaveLength(3000);
  expect(splitPatchByFile(patch)[0].text.startsWith("diff --git a/f0.ts")).toBe(true);
  expect(describeReviewFiles(patch).split("\n").slice(0, 2)).toEqual([note, "3000 files (path · status · lines added and removed · diff size · kind):"]);
  expect(patchPage(patch, 0, 1000).text.startsWith(note)).toBe(true);
  expect(await read(2999)).not.toContain(note);
});

test("a file GitHub sent no diff for lists as unavailable in list_review_files", async () => {
  const run = vi.fn(async (args: string[]) => args[0] === "api" ? { code: 0, stderr: "", stdout: JSON.stringify({ filename: "huge.sql", status: "modified", changes: 90000 }) + "\n" } : tooLarge);
  expect(describeReviewFiles(await readPrDiff(run, 7, "acme/web"))).toMatch(/^huge\.sql · .* · diff unavailable: read it on GitHub$/m);
});

// Without git's header for an added or copied file, isChosenPath missed it, so a huge PR could still stub and fold its
// own code under a path that reads as generated (95-recheck P2 #3).
test("a file a PR too big for GitHub's diff adds or copies under a generated-looking path is paged in full and listed as code", async () => {
  const listed = [
    { filename: "src/vendor/hook.js", status: "added", patch: "@@ -0,0 +1 @@\n+exec(x);" },
    { filename: "dist/payload.js", status: "added" },
    { filename: "vendor/copy.js", previous_filename: "src/real.js", status: "copied", patch: "@@ -1 +1 @@\n-a\n+exec(y);" },
    { filename: "vendor/same.js", previous_filename: "src/same.js", status: "copied", changes: 0 },
    { filename: "vendor/gone.js", status: "removed", patch: "@@ -1 +0,0 @@\n-g" },
    { filename: "vendor/lib.js", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
  ];
  const run = vi.fn(async (args: string[]) => args[0] === "api" ? { code: 0, stderr: "", stdout: listed.map((f) => JSON.stringify(f)).join("\n") + "\n" } : tooLarge);
  const patch = await readPrDiff(run, 7, "acme/web");
  const list = describeReviewFiles(patch);
  expect(list).toMatch(/^src\/vendor\/hook\.js · added · \+1 −0 · \d+ chars · code$/m);
  expect(list).toMatch(/^dist\/payload\.js · added · \+0 −0 · \d+ chars · code · diff unavailable: read it on GitHub$/m);
  expect(list).toMatch(/^vendor\/copy\.js · copied from src\/real\.js · \+1 −1 · \d+ chars · code$/m);
  expect(list).toMatch(/^vendor\/gone\.js · deleted · \+0 −1 · \d+ chars · generated$/m);
  const pages = stubSkippedFiles(patch);
  expect(pages).toContain("+exec(x);");
  expect(pages).toContain("+exec(y);");
  expect(pages).toContain("[generated: +1 −1 lines; pass file to read it]");
  const same = splitPatchByFile(patch).find((file) => file.path === "vendor/same.js");
  expect(same?.text).toBe("diff --git a/src/same.js b/vendor/same.js\ncopy from src/same.js\ncopy to vendor/same.js\n");
});
