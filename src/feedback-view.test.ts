import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { diffAt, sinceReview } from "./feedback-view";
import { changedFiles } from "./patch";

const tooLarge = { code: 1, stdout: '{"message":"Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull requests files\' API or locally cloning the repository instead.","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}', stderr: "gh: HTTP 406" };
const file = (filename: string) => JSON.stringify({ filename, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" });

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  const review: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "sha1", latestHeadSha: "sha2", status: "ready", createdAt: 1 };
  store.saveReview(review);
  return { store, review };
}

test("the PR's head diff, too big for GitHub's diff, is rebuilt from the PR's files", async () => {
  const { store, review } = setup();
  const run = vi.fn(async (args: string[]) => (args[1] === "diff" ? tooLarge : { code: 0, stdout: file("now.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha2"))).toEqual(["now.ts"]);
  expect(run.mock.calls[1][0]).toEqual(["api", "--paginate", "repos/acme/web/pulls/1/files?per_page=100", "--jq", ".[] | @json"]);
});

test("an earlier commit's diff, too big for GitHub's diff, is rebuilt from the comparison's files", async () => {
  const { store, review } = setup();
  const run = vi.fn(async (args: string[]) => (args.includes("Accept: application/vnd.github.diff") ? tooLarge : { code: 0, stdout: file("then.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha0"))).toEqual(["then.ts"]);
  expect(run.mock.calls[1][0]).toEqual(["api", "repos/acme/web/compare/main...sha0", "--jq", ".files[] | @json"]);
});

test("an earlier commit's diff that hits the comparison's 300-file limit fails, and isn't kept", async () => {
  const { store, review } = setup();
  const files = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`)).join("\n") + "\n";
  const run = vi.fn(async (args: string[]) => (args.includes("Accept: application/vnd.github.diff") ? tooLarge : { code: 0, stdout: files, stderr: "" }));
  await expect(diffAt(store, run, review, "sha0")).rejects.toThrow("more than 300 files");
  expect(store.getSnapshot("pr-1", "sha0")).toBeNull();
});

test("Since your review is compared once per baseline and diff, and leaves out added files' diffs the page has", async () => {
  const { store, review } = setup();
  const one = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+${line}\n`;
  store.saveSnapshot("pr-1", "sha0", one("a.ts", "b"));
  store.savePatch("pr-1", one("a.ts", "c") + one("added.ts", "n"));
  const reviewed = { ...review, submittedAt: 5, submittedHeadSha: "sha0" };
  const run = vi.fn();
  const first = await sinceReview(store, run, reviewed);
  expect(first?.files.map((f) => [f.file, f.status, f.patch === ""])).toEqual([["a.ts", "changed", false], ["added.ts", "added", true]]);
  expect(await sinceReview(store, run, reviewed)).toBe(first);
  store.savePatch("pr-1", one("a.ts", "d"));
  expect((await sinceReview(store, run, reviewed))?.files.map((f) => f.file)).toEqual(["a.ts"]);
  expect(run).not.toHaveBeenCalled();
});
