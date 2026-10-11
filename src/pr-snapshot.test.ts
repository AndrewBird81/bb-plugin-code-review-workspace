import { expect, test, vi } from "vitest";
import { readPrSnapshot } from "./pr-snapshot";
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
