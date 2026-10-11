import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { diffAt, pruneOldDiffs, sinceReview } from "./feedback-view";
import { changedFiles } from "./patch";

const tooLarge = { code: 1, stdout: '{"message":"Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull requests files\' API or locally cloning the repository instead.","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}', stderr: "gh: HTTP 406" };
const DAY = 86_400_000;
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

test("diffs of reviews out of play for a month are dropped, keeping the guide, the draft, notes, and what Since your review needs", () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  const now = 100 * DAY;
  const old = now - 31 * DAY;
  const reviews: Array<Partial<ReviewMeta> & { targetKey: string }> = [
    { targetKey: "merged", prState: "MERGED", archivedAt: old, submittedAt: 1, submittedHeadSha: "sha0" },
    { targetKey: "closed", prState: "CLOSED", archivedAt: old },
    // An open PR you archived can come back with a re-request, and agents read its diff before you open it.
    { targetKey: "archived", prState: "OPEN", userArchivedAt: old },
    { targetKey: "recent", prState: "CLOSED", archivedAt: now - 29 * DAY },
    { targetKey: "open" },
    { targetKey: "commented", prState: "CLOSED", archivedAt: old },
    { targetKey: "rebuilding", prState: "CLOSED", archivedAt: old, status: "generating" },
    { targetKey: "local", kind: "ref", gitRef: "main...x", userArchivedAt: old },
    // GitHub can't rebuild an earlier head's diff once the PR is merged into its base, or its base branch is gone.
    { targetKey: "merged-later", prState: "MERGED", archivedAt: old, latestHeadSha: "sha9" },
    { targetKey: "closed-later", prState: "CLOSED", archivedAt: old, latestHeadSha: "sha9" },
  ];
  for (const r of reviews) {
    store.saveReview({ kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha1", ...r } as ReviewMeta);
    const { targetKey, kind: _kind, gitRef: _gitRef, status: _status, ...lifecycle } = r;
    store.setLifecycle(targetKey, lifecycle);
    store.savePatch(r.targetKey, "diff --git a/a.ts b/a.ts\n");
    store.saveSnapshot(r.targetKey, "sha0", "then");
    store.saveSnapshot(r.targetKey, "sha1", "now");
    store.saveGuide(r.targetKey, { title: "t", intent: "i", sections: [], unplacedFiles: [] });
    store.saveReviewerNotes(r.targetKey, "note", 0);
    store.setVerdict(r.targetKey, "APPROVE", "LGTM");
  }
  store.upsertDraftComment("commented", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  expect(pruneOldDiffs(store, now)).toEqual(["merged", "closed"]);
  expect(store.readPatch("merged").total).toBe(0);
  expect(store.hasPatch("merged")).toBe(false);
  // Since your review compares with the diff you reviewed.
  expect(store.getSnapshot("merged", "sha0")).toBe("then");
  expect(store.getSnapshot("merged", "sha1")).toBeNull();
  expect(store.getSnapshot("closed", "sha0")).toBeNull();
  expect(store.getGuide("merged")?.intent).toBe("i");
  expect(store.getDraft("merged").body).toBe("LGTM");
  expect(store.getReviewerNotes("merged").body).toBe("note");
  for (const kept of ["recent", "open", "archived", "commented", "rebuilding", "local", "merged-later", "closed-later"]) expect(store.hasPatch(kept)).toBe(true);
});
