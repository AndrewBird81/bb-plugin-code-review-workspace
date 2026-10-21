import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { testStore } from "./test-store.test-support";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const one = (line: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+${line}\n`;
const commit = (sha: string, at: string, message: string) => JSON.stringify({ sha, at, headline: message.split("\n")[0] });
// Oldest first, as GitHub lists them; c4 came after the diff shown.
const COMMITS = [commit("c1aaaaa", "2026-10-01T00:00:00Z", "Add cache"), commit("c2bbbbb", "2026-10-02T00:00:00Z", "Invalidate on write"),
  commit("c3ccccc", "2026-10-03T00:00:00Z", "Rename key"), commit("c4ddddd", "2026-10-04T00:00:00Z", "Later push")].join("\n") + "\n";

async function setUp() {
  runGh.mockReset();
  runGh.mockImplementation(async (args: string[]) => {
    if (String(args[2]).includes("/pulls/1/commits")) return ok(COMMITS);
    const compare = args.find((arg) => arg.includes("/compare/"));
    if (compare?.endsWith("...c1aaaaa")) return ok(one("first"));
    if (compare?.endsWith("...c2bbbbb")) return ok(one("second"));
    return { stdout: "", stderr: "HTTP 404", code: 1 };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "c3ccccc", latestHeadSha: "c4ddddd", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", one("third"));
  return { harness, store, call: (method: string, input: unknown) => harness.behavior.callRpc(method as any, input as any) as Promise<any> };
}

test("getPrCommits lists the PR's commits up to the diff shown, newest first, read once per head", async () => {
  const { call } = await setUp();
  const { commits } = await call("getPrCommits", { targetKey: "pr-1" });
  expect(commits).toEqual([
    { sha: "c3ccccc", headline: "Rename key", committedAt: Date.parse("2026-10-03T00:00:00Z") },
    { sha: "c2bbbbb", headline: "Invalidate on write", committedAt: Date.parse("2026-10-02T00:00:00Z") },
    { sha: "c1aaaaa", headline: "Add cache", committedAt: Date.parse("2026-10-01T00:00:00Z") },
  ]);
  await call("getPrCommits", { targetKey: "pr-1" });
  expect(runGh.mock.calls.filter(([args]) => String(args[2]).includes("/commits"))).toHaveLength(1);
});

test("getSinceReview compares the diff shown with the diff at a picked commit, once per commit", async () => {
  const { call } = await setUp();
  const since = await call("getSinceReview", { targetKey: "pr-1", from: "c1aaaaa" });
  expect(since.baseline).toEqual({ sha: "c1aaaaa", at: null, verdict: null });
  expect(since.files).toMatchObject([{ file: "a.ts", status: "changed", newLines: [1] }]);
  expect((await call("getSinceReview", { targetKey: "pr-1", from: "c2bbbbb" })).baseline.sha).toBe("c2bbbbb");
  // Back to the first: no new read, from GitHub or the stored diffs.
  runGh.mockClear();
  expect((await call("getSinceReview", { targetKey: "pr-1", from: "c1aaaaa" })).files).toEqual(since.files);
  expect(runGh).not.toHaveBeenCalled();
  // A commit GitHub can't compare says so.
  expect((await call("getSinceReview", { targetKey: "pr-1", from: "c9999999" })).error).toContain("c999999");
});

test("getSinceReview takes only a commit sha to compare from", async () => {
  const { call } = await setUp();
  await expect(call("getSinceReview", { targetKey: "pr-1", from: "main;rm" })).rejects.toThrow();
});

test("a local review has no commits to pick", async () => {
  const { call, store } = await setUp();
  await store.saveReview({ targetKey: "local-1", kind: "ref", cwd: "/tmp", gitRef: "main..HEAD", status: "ready", createdAt: 1 });
  expect(await call("getPrCommits", { targetKey: "local-1" })).toEqual({ commits: [] });
});
