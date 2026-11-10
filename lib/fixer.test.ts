import { expect, test } from "vitest";
import { isFixer, usesFixer, yoursByFolder } from "./fixer";

const feature = { environmentId: "env1", hostId: "h", machine: "MaxBook", path: "/src/web", branch: "feat", baseRef: "main", repo: "acme/web" };
const adopted = { threadId: "coder", environmentId: "env1", origin: "adopted" as const, since: 1 };
// A fixer as it's recorded when it's made: its folder and branch may not be known yet.
const fixer = { threadId: "fixer", environmentId: null, origin: "fresh" as const, since: 2, fixer: { sha: "a".repeat(40), at: 2 } };

test("one answer to whether a review's Sends go to a fixer, for every route and button", () => {
  const cases: Array<[string, Parameters<typeof usesFixer>[0], boolean]> = [
    ["a PR with no folder of its own", { kind: "pr", feature: null, mainThread: null }, true],
    ["a PR whose folder BB removed", { kind: "pr", feature: { ...feature, folderGone: true }, mainThread: adopted }, true],
    ["a PR whose folder a fresh thread took over, the review reading its worktree", { kind: "pr", feature: { ...feature, environmentId: "env_fix", workBranch: "bb/fix" }, mainThread: adopted }, true],
    ["a PR whose main thread is a fixer, its worktree still being made", { kind: "pr", feature, mainThread: fixer }, true],
    ["a PR whose folder is there, with its own thread", { kind: "pr", feature, mainThread: adopted }, false],
    ["a PR's folder with a fresh thread the plugin started in it, no fixer", { kind: "pr", feature, mainThread: { ...adopted, origin: "fresh", branch: "feat" } }, false],
    ["a local review, whatever its main thread", { kind: "ref", feature: { ...feature, folderGone: true, workBranch: "bb/x" }, mainThread: fixer }, false],
  ];
  for (const [what, review, expected] of cases) expect(usesFixer(review), what).toBe(expected);
  expect(isFixer(fixer)).toBe(true);
  // A fixer is one by its record, not its branch, which BB says only later.
  expect(isFixer({ ...adopted, origin: "fresh", branch: "bb/fix" })).toBe(false);
  expect(isFixer(null)).toBe(false);
});

test("a folder makes the change yours where the review began as it, not where it joined a PR's review, for Send, Submit and the comments' status alike", () => {
  const cases: Array<[string, Parameters<typeof yoursByFolder>[0], boolean]> = [
    ["a local review", { kind: "ref", feature }, true],
    ["a folder's review that became its PR's", { kind: "pr", feature }, true],
    ["a PR's review a folder joined", { kind: "pr", feature: { ...feature, joinedAt: 2 } }, false],
    ["a PR's review with no folder", { kind: "pr", feature: null }, false],
    ["no review", null, false],
  ];
  for (const [what, review, expected] of cases) expect(yoursByFolder(review), what).toBe(expected);
});
