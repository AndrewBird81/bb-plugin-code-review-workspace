import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { diffAt, pruneOldDiffs, sinceReview } from "./feedback-view";
import { changedFiles } from "./patch";
import { queueStore } from "./store-queue";

const tooLarge = { code: 1, stdout: '{"message":"Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull requests files\' API or locally cloning the repository instead.","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}', stderr: "gh: HTTP 406" };
const DAY = 86_400_000;
const file = (filename: string) => JSON.stringify({ filename, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" });

async function setup() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  const review: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "sha1", latestHeadSha: "sha2", status: "ready", createdAt: 1 };
  await store.saveReview(review);
  return { store, review };
}

test("the PR's head diff, too big for GitHub's diff, is rebuilt from the PR's files", async () => {
  const { store, review } = await setup();
  const run = vi.fn(async (args: string[]) => (args[1] === "diff" ? tooLarge : args[1] === "view" ? { code: 0, stdout: '{"headRefOid":"sha2"}', stderr: "" }
    : { code: 0, stdout: file("now.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha2"))).toEqual(["now.ts"]);
  expect(run.mock.calls[2][0]).toEqual(["api", "--paginate", "repos/acme/web/pulls/1/files?per_page=100", "--jq", ".[] | @json"]);
});

test("an earlier commit's diff, too big for GitHub's diff, is rebuilt from the comparison's files", async () => {
  const { store, review } = await setup();
  const run = vi.fn(async (args: string[]) => (args.includes("Accept: application/vnd.github.diff") ? tooLarge : { code: 0, stdout: file("then.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha0"))).toEqual(["then.ts"]);
  expect(run.mock.calls[1][0]).toEqual(["api", "repos/acme/web/compare/main...sha0", "--jq", ".files[] | @json"]);
});

test("an earlier commit's diff that hits the comparison's 300-file limit fails, and isn't kept", async () => {
  const { store, review } = await setup();
  const files = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`)).join("\n") + "\n";
  const run = vi.fn(async (args: string[]) => (args.includes("Accept: application/vnd.github.diff") ? tooLarge : { code: 0, stdout: files, stderr: "" }));
  await expect(diffAt(store, run, review, "sha0")).rejects.toThrow("more than 300 files");
  expect(await store.getSnapshot("pr-1", "sha0")).toBeNull();
});

const one = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+${line}\n`;
// The guide is at sha1; the sync last read the PR at sha2 (which you reviewed on GitHub); the author has since pushed sha3.
const AT = { sha1: one("a.ts", "guide"), sha2: one("a.ts", "reviewed"), sha3: one("a.ts", "pushed-later") };

/** GitHub: the PR's diff is the newest push's; a comparison gives the diff at the commit asked for. */
async function pushedLater() {
  const { store } = await setup();
  const signals = { lastReviewAt: 10, lastReviewSha: "sha2" } as ReviewMeta["signals"];
  await store.setLifecycle("pr-1", { latestHeadSha: "sha2", signals, submittedVerdict: "REQUEST_CHANGES" });
  await store.savePatch("pr-1", AT.sha1);
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "diff") return { code: 0, stdout: AT.sha3, stderr: "" };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: "sha3", baseRefName: "main" }), stderr: "" };
    const sha = args.find((a) => a.includes("/compare/"))?.split("...")[1] as keyof typeof AT | undefined;
    if (sha && AT[sha]) return { code: 0, stdout: AT[sha], stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  return { store, review: (await store.getReview("pr-1"))!, run };
}

test("the diff at the head the sync last read is that commit's, not a later push's", async () => {
  const { store, review, run } = await pushedLater();
  expect(await diffAt(store, run, review, "sha2")).toBe(AT.sha2);
  expect(await store.getSnapshot("pr-1", "sha2")).toBe(AT.sha2);
  expect(run.mock.calls.map(([args]) => args.join(" "))).not.toContain("pr diff 1 --color never -R acme/web");
});

test("the PR's diff read while the author pushes isn't kept as the head's", async () => {
  const { store, review, run } = await pushedLater();
  let views = 0;
  run.mockImplementation(async (args: string[]) => args[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: views++ ? "sha3" : "sha2" }), stderr: "" }
    : args[1] === "diff" ? { code: 0, stdout: AT.sha3, stderr: "" } : { code: 0, stdout: AT.sha2, stderr: "" });
  expect(await diffAt(store, run, review, "sha2")).toBe(AT.sha2);
  expect(run.mock.calls.at(-1)![0]).toEqual(["api", "-H", "Accept: application/vnd.github.diff", "repos/acme/web/compare/main...sha2"]);
});

test("the head of a retargeted PR is compared with the base it targets now", async () => {
  const { store, review, run } = await pushedLater();
  await diffAt(store, run, { ...review, latestBase: "release/2" }, "sha2");
  expect(run.mock.calls.at(-1)![0]).toEqual(["api", "-H", "Accept: application/vnd.github.diff", "repos/acme/web/compare/release%2F2...sha2"]);
});

test("Since your review, once the guide catches up, still shows what changed after the commit you reviewed", async () => {
  const { store, review, run } = await pushedLater();
  // Opening Comments' Since your review while the sync is a push behind used to keep the later push's diff as sha2's.
  await sinceReview(store, run, review).catch(() => null);
  // The guide is rebuilt at sha3, as Update guide does.
  await store.savePatch("pr-1", AT.sha3);
  await store.saveReview({ ...review, headSha: "sha3" });
  await store.setLifecycle("pr-1", { latestHeadSha: "sha3" });
  const since = await sinceReview(store, run, (await store.getReview("pr-1"))!);
  // sha2 → sha3 changed a.ts; with the wrong snapshot it compares sha3 with itself and shows nothing.
  expect(since?.files.map((f) => [f.file, f.status])).toEqual([["a.ts", "changed"]]);
});

test("Since your review is compared once per baseline and diff, and leaves out added files' diffs the page has", async () => {
  const { store, review } = await setup();
  await store.saveSnapshot("pr-1", "sha0", one("a.ts", "b"));
  await store.savePatch("pr-1", one("a.ts", "c") + one("added.ts", "n"));
  const reviewed = { ...review, submittedAt: 5, submittedHeadSha: "sha0" };
  const run = vi.fn();
  const first = await sinceReview(store, run, reviewed);
  expect(first?.files.map((f) => [f.file, f.status, f.patch === ""])).toEqual([["a.ts", "changed", false], ["added.ts", "added", true]]);
  expect(await sinceReview(store, run, reviewed)).toBe(first);
  await store.savePatch("pr-1", one("a.ts", "d"));
  expect((await sinceReview(store, run, reviewed))?.files.map((f) => f.file)).toEqual(["a.ts"]);
  expect(run).not.toHaveBeenCalled();
});

test("diffs of reviews out of play for a month are dropped, keeping the guide, the draft, notes, and what Since your review needs", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
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
    await store.saveReview({ kind: "pr", repo: "acme/web", number: 1, status: "ready", createdAt: 1, headSha: "sha1", ...r } as ReviewMeta);
    const { targetKey, kind: _kind, gitRef: _gitRef, status: _status, ...lifecycle } = r;
    await store.setLifecycle(targetKey, lifecycle);
    await store.savePatch(r.targetKey, "diff --git a/a.ts b/a.ts\n");
    await store.saveSnapshot(r.targetKey, "sha0", "then");
    await store.saveSnapshot(r.targetKey, "sha1", "now");
    await store.saveGuide(r.targetKey, { title: "t", intent: "i", sections: [], unplacedFiles: [] });
    await store.saveReviewerNotes(r.targetKey, "note", 0);
    await store.setVerdict(r.targetKey, "APPROVE", "LGTM");
  }
  await store.upsertDraftComment("commented", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  // Reviews created at once are listed by key.
  expect(await pruneOldDiffs(store, now)).toEqual(["closed", "merged"]);
  expect(await store.patch("merged")).toBe("");
  expect(await store.hasPatch("merged")).toBe(false);
  // Since your review compares with the diff you reviewed.
  expect(await store.getSnapshot("merged", "sha0")).toBe("then");
  expect(await store.getSnapshot("merged", "sha1")).toBeNull();
  expect(await store.getSnapshot("closed", "sha0")).toBeNull();
  expect((await store.getGuide("merged"))?.intent).toBe("i");
  expect((await store.getDraft("merged")).body).toBe("LGTM");
  expect((await store.getReviewerNotes("merged")).body).toBe("note");
  for (const kept of ["recent", "open", "archived", "commented", "rebuilding", "local", "merged-later", "closed-later"]) expect(await store.hasPatch(kept)).toBe(true);
});

test("picking commits to compare with doesn't keep a stored diff for each, only the diffs the review needs", async () => {
  const { store, review } = await setup();
  await store.savePatch("pr-1", one("a.ts", "head"));
  const reviewed = { ...review, submittedAt: 5, submittedHeadSha: "sha0" };
  const run = vi.fn(async (args: string[]) => ({ code: 0, stdout: one("a.ts", args.at(-1)!.split("...")[1]), stderr: "" }));
  const commits = Array.from({ length: 30 }, (_, i) => `c${i}`);
  for (const from of commits) await sinceReview(store, run, reviewed, from);
  const kept: string[] = [];
  for (const sha of commits) if (await store.getSnapshot("pr-1", sha) !== null) kept.push(sha);
  expect(kept).toEqual([]);
  // Your review's diff is kept, as pruneDiffs keeps it.
  await sinceReview(store, run, reviewed);
  expect(await store.getSnapshot("pr-1", "sha0")).toBe(one("a.ts", "sha0"));
});
