import { afterEach, expect, test, vi } from "vitest";

// Push reads the branch on GitHub when the main thread stops (src/push.ts): here GitHub can't be reached.
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh: vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })) }));
import { runReviewCommand } from "./review-command";
import { becomePr, checkFeature, updateFeature } from "./feature-review";
import { featureKey, prReviewKey, reviewNamed, targetKey } from "./targets";
import { folderHost, type Folder } from "./env-diff.test-support";
import { testSql, testStore } from "./test-store.test-support";
import { storeOn } from "./store";
import { queueStore } from "./store-queue";
import { changedFiles, splitPatchByFile } from "./patch";
import { defaultPreferences } from "./preferences";
import { computeTurn } from "../lib/turn";
import { pruneOldDiffs } from "./feedback-view";
import { rerunReview } from "./rereview";
import { readFileAt } from "./verification";
import { symlinkTarget } from "../lib/folder-files";
import plugin from "../server";
import { toolFailed, toolText } from "./fake-host.test-support";
import { createReviewSync, type GithubReads, type TurnActions } from "./review-lifecycle";
import { runGh } from "./gh";

afterEach(() => { vi.useRealTimers(); });

interface T { id: string; environmentId: string | null; parentThreadId?: string | null; title?: string | null; titleFallback?: string | null; archivedAt?: number | null; visibility?: "visible" | "hidden"; originPluginId?: string | null }
const full = (thread: T) => ({ parentThreadId: null, title: null, titleFallback: null, archivedAt: null, deletedAt: null, visibility: "visible", originPluginId: null, ...thread });

const BODY = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const PR_DIFF = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

/**
 * A folder (env1, on MaxBook, feat/qa) and the threads around it: `main` works in it and leads, `sub` is its subagent,
 * `orch` an orchestrator in another folder, `other` another top thread in the folder.
 */
function setup(folder: Folder = { files: [{ path: "src/a.ts", body: BODY }] }, threads: Record<string, T> = {}) {
  const all: Record<string, T> = {
    main: { id: "main", environmentId: "env1", title: "Snooze flaky checks" },
    sub: { id: "sub", environmentId: "env1", parentThreadId: "main", title: "Subagent" },
    other: { id: "other", environmentId: "env1", title: "Fix the docs" },
    ...threads,
  };
  const spawns: unknown[] = [];
  /** Threads BB fails to read, as when it's busy: not a 404. */
  const failing = new Set<string>();
  const host = folderHost(folder, { threads: {
    get: async ({ threadId }: { threadId: string }) => {
      if (failing.has(threadId)) throw Object.assign(new Error("HTTP 502: Bad gateway"), { status: 502 });
      if (!all[threadId]) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return full(all[threadId]!);
    },
    list: async ({ environmentId }: { environmentId: string }) => Object.values(all).filter((thread) => thread.environmentId === environmentId).map(full),
    experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((id) => ({ threadId: id, descendantIds: Object.values(all).filter((thread) => thread.parentThreadId === id).map((thread) => thread.id) })) }),
    // The guide writer: counted, and failing at once, so its guide ends.
    spawn: async (args: unknown) => { spawns.push(args); throw new Error("fixture worker"); },
    archive: async () => ({}), stop: async () => ({}), wait: async () => ({}),
  } });
  const store = testStore(host.bb);
  const ghCalls: string[][] = [];
  /** The PR as gh pr view gives it. */
  const view: Record<string, unknown> = { number: 7, title: "Snooze flaky checks for a day", author: { login: "me" }, baseRefName: "main", headRefName: "feat/qa", url: "https://github.com/acme/api/pull/7", headRefOid: "c0ffee", state: "OPEN" };
  const runGh = vi.fn(async (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stderr: "", stdout: JSON.stringify(view) };
    if (args[0] === "pr" && args[1] === "diff") return { code: 0, stderr: "", stdout: PR_DIFF };
    return { code: 1, stderr: "unexpected gh call", stdout: "" };
  });
  const changed = vi.fn();
  const deps = { bb: host.bb, store, gh: { runGh, runGit: vi.fn() }, changed, sync: { one: vi.fn(async () => {}) } };
  return { ...host, store, spawns, deps, all, ghCalls, folder, failing, view };
}
const key = featureKey("env1", "feat/qa");
const run = (s: ReturnType<typeof setup>, threadId: string | undefined, argv: string[] = [], cwd = "/Users/me/src/api", ownReview?: string) =>
  runReviewCommand(s.deps, argv, { projectId: "proj_api", threadId, cwd }, ownReview);
/** The guide the command began has ended: its writer failed at once, which the review shows as ready, as a guide would. */
const settled = async (s: ReturnType<typeof setup>) => {
  await vi.waitFor(async () => expect((await s.store.getReview(key))?.status).not.toBe("generating"));
  await s.store.setStatus(key, "ready");
};

test("three subagents sharing their thread's id make one review of the folder, addressed to that thread, with no checkout of its own", async () => {
  const s = setup();
  const results = await Promise.all([run(s, "main"), run(s, "main"), run(s, "main")]);
  expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
  expect(results.filter((r) => r.stdout?.startsWith("Started a review of ~/src/api on MaxBook: api:feat/qa \"Snooze flaky checks\""))).toHaveLength(1);
  expect(results.filter((r) => r.stdout?.startsWith("Opened the review of ~/src/api on MaxBook: api:feat/qa \"Snooze flaky checks\""))).toHaveLength(2);
  for (const r of results) expect(r.stdout).toContain(`Its main thread is "Snooze flaky checks" (main), the top thread working in this folder.`);
  const reviews = await s.store.listReviews();
  expect(reviews.map((r) => r.targetKey)).toEqual([key]);
  const review = reviews[0]!;
  expect(review).toMatchObject({ kind: "ref", gitRef: "feat/qa", title: "Snooze flaky checks", projectId: "proj_api", sourceThreadId: "main" });
  expect(review.cwd).toBeUndefined();
  expect(review.feature).toEqual({ environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", mergeBaseRef: expect.stringMatching(/^[0-9a-f]{40}$/), repo: "acme/api", pausedOn: null, changedFiles: null });
  expect(review.mainThread).toMatchObject({ threadId: "main", environmentId: "env1", origin: "adopted" });
  expect(changedFiles(await s.store.patch(key))).toEqual(["src/a.ts"]);
  await vi.waitFor(() => expect(s.spawns).toHaveLength(1));
});

test("a subagent under an orchestrator in another folder addresses the top thread working in the code's folder", async () => {
  const s = setup(undefined, {
    orch: { id: "orch", environmentId: "env_orch", title: "Orchestrator" },
    worker: { id: "worker", environmentId: "env1", parentThreadId: "orch", title: "Build snooze" },
    deep: { id: "deep", environmentId: "env1", parentThreadId: "worker", title: "Write tests" },
  });
  expect((await run(s, "deep")).stdout).toContain(`Its main thread is "Build snooze" (worker)`);
  expect((await s.store.getReview(key))?.mainThread?.threadId).toBe("worker");
});

test("run again from any thread in the folder, it only opens: no rebuild, and the main thread stays", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const before = await s.store.patch(key);
  s.folder.files.push({ path: "src/b.ts" });
  const again = await run(s, "other");
  expect(again).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("as it was; nothing was rebuilt") });
  expect(again.stdout).toContain(`Its main thread is "Snooze flaky checks" (main)`);
  expect(await s.store.patch(key)).toBe(before);
  expect((await s.store.getReview(key))?.mainThread?.threadId).toBe("main");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.spawns).toHaveLength(1);
});

test("a live thread in the folder replaces an archived main thread", async () => {
  const s = setup();
  await run(s, "main");
  s.all.main!.archivedAt = Date.now();
  const again = await run(s, "other");
  expect(again.stdout).toContain(`Its main thread is now "Fix the docs" (other), in place of "Snooze flaky checks", which is archived or deleted.`);
  const review = await s.store.getReview(key);
  expect(review?.mainThread?.threadId).toBe("other");
  expect(review?.implementers?.map((thread) => thread.threadId)).toEqual(["main"]);
  expect(review?.sourceThreadId).toBe("other");
});

test("a thread BB can't read now changes nothing: an existing review keeps its main thread, and a first run starts none", async () => {
  const s = setup();
  await run(s, "main");
  // Its main thread can't be read: whether it's archived is unknown, so it isn't replaced.
  s.failing.add("main");
  const again = await run(s, "other");
  expect(again.exitCode).toBe(0);
  expect((await s.store.getReview(key))?.mainThread?.threadId).toBe("main");
  // A subagent whose parent can't be read: the review opens as it is.
  const sub = await run(s, "sub");
  expect(sub.stdout).toContain("Its main thread is main, as before: BB couldn’t say which thread leads the work here now.");
  expect((await s.store.getReview(key))?.mainThread?.threadId).toBe("main");

  // With no review yet, it says so and starts none.
  const fresh = setup();
  fresh.failing.add("main");
  expect(await run(fresh, "sub")).toEqual({ exitCode: 1, stderr: "Couldn’t tell which thread leads the work in this folder: BB didn’t answer for one of this thread’s parents. Try again in a moment." });
  expect(await fresh.store.listReviews()).toEqual([]);
});

test("a main thread with no title yet names the review as BB shows it, as the command's output does", async () => {
  const s = setup(undefined, { main: { id: "main", environmentId: "env1", title: null, titleFallback: "Snooze the flaky checks for a day" } });
  expect((await run(s, "main")).stdout).toContain(`Its main thread is "Snooze the flaky checks for a day" (main)`);
  expect((await s.store.getReview(key))?.title).toBe("Snooze the flaky checks for a day");
});

test("the walk up a thread's parents ends at one BB no longer has, and at a cycle", async () => {
  const missing = setup(undefined, { lost: { id: "lost", environmentId: "env1", parentThreadId: "deleted-for-good", title: "Lost parent" } });
  expect((await run(missing, "lost")).stdout).toContain(`Its main thread is "Lost parent" (lost)`);
  const cycle = setup(undefined, {
    a: { id: "a", environmentId: "env1", parentThreadId: "b", title: "A" },
    b: { id: "b", environmentId: "env1", parentThreadId: "a", title: "B" },
  });
  const result = await run(cycle, "a");
  expect(result.exitCode).toBe(0);
  expect(["a", "b"]).toContain((await cycle.store.getReview(key))?.mainThread?.threadId);
});

test("refused: a review's own agent, a call from outside a thread, and --base with no ref; a folder elsewhere warns", async () => {
  const s = setup();
  expect(await run(s, "main", [], undefined, "pr-1")).toEqual({ exitCode: 2, stderr: "A review’s own agent can’t start a review of a folder." });
  expect((await run(s, undefined)).exitCode).toBe(2);
  expect((await run(s, "main", ["--base", "main"])).exitCode).toBe(2);
  expect(await s.store.listReviews()).toEqual([]);
  const elsewhere = await run(s, "main", [], "/Users/me/src/api-wt-sub");
  expect(elsewhere.stdout).toContain("You ran this in /Users/me/src/api-wt-sub, outside this thread’s folder, so changes made only there aren’t in the review.");
  expect((await run(s, "main", [], "/Users/me/src/api/web")).stdout).not.toContain("outside this thread’s folder");
});

test("a branch switch pauses the review, Update waits, and switching back resumes it", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  s.folder.env = { ...s.folder.env, branchName: "feat/other" };
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "paused", branch: "feat/other" });
  expect((await checkFeature(s.deps, key)).branchReview).toBeUndefined();
  // Once that branch has a review, Review ‹branch› opens it.
  await run(s, "main");
  expect((await checkFeature(s.deps, key)).branchReview).toBe(featureKey("env1", "feat/other"));
  const paused = (await s.store.getReview(key))!;
  expect(paused.feature?.pausedOn).toBe("feat/other");
  expect(computeTurn(paused)).toMatchObject({ group: "waiting", reason: "paused", label: "Paused" });
  expect(await updateFeature(s.deps, key)).toEqual({ ok: false, error: "The folder is on feat/other now, so this review waits until it’s back on feat/qa." });
  s.folder.env = { ...s.folder.env, branchName: "feat/qa" };
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  const resumed = (await s.store.getReview(key))!;
  expect(resumed.feature?.pausedOn).toBeNull();
  expect(computeTurn(resumed).group).toBe("needs");
});

/** The folder's git, as bb's Git plugin answers: its head, which commits it has, and whether its old branch is still there. */
function renaming(s: ReturnType<typeof setup>) {
  const git = { head: "a1".repeat(20), has: true, oldBranch: "missing" };
  s.folder.answers = {
    workspaceStatus: (input) => ({ outcome: "available", workspace: { checkout: { headSha: git.head }, mergeBase: input.mergeBaseBranch ? { behindCount: git.has ? 0 : 3 } : null } }),
    branches: (input) => ({ selectedBranch: { name: input.selectedBranch, kind: git.oldBranch } }),
  };
  return git;
}

test("a branch renamed in its folder is followed: the same review, its old branch gone and its last commit on the new one, says so", async () => {
  const s = setup();
  const git = renaming(s);
  await run(s, "main");
  await settled(s);
  await checkFeature(s.deps, key);
  expect((await s.store.getReview(key))?.feature?.headSha).toBe(git.head);
  // git branch -m feat/nice, and a commit since.
  s.folder.env = { ...s.folder.env, branchName: "feat/nice" };
  git.head = "b2".repeat(20);
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  const review = (await s.store.getReview(key))!;
  expect(review).toMatchObject({ gitRef: "feat/nice", feature: { branch: "feat/nice", pausedOn: null, headSha: git.head }, followed: { from: "feat/qa", branch: "feat/nice", at: expect.any(Number) } });
  // bb review there opens it, by its key; its id is the new branch's.
  expect((await run(s, "main")).stdout).toContain(`Opened the review of ~/src/api on MaxBook: api:feat/nice "Snooze flaky checks" (${key})`);
  expect((await s.store.listReviews()).map((r) => r.targetKey)).toEqual([key]);
  // Its id from before still names it, after Got it too.
  expect((await reviewNamed(s.store, s.bb, "api:feat/qa"))?.targetKey).toBe(key);
  await s.store.setLifecycle(key, { followed: null });
  expect((await reviewNamed(s.store, s.bb, "api:feat/qa"))?.targetKey).toBe(key);
});

test("a branch made from the review's (checkout -b), or one without its last commit, pauses it, with Follow and New review for that branch", async () => {
  const s = setup();
  await plugin(s.bb);
  const git = renaming(s);
  await run(s, "main");
  await settled(s);
  await checkFeature(s.deps, key);
  s.folder.env = { ...s.folder.env, branchName: "feat/nice" };
  // The old branch is still there: a stacked branch, say.
  git.oldBranch = "local";
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "paused", branch: "feat/nice" });
  // Gone, but the new branch hasn't the review's last commit.
  git.oldBranch = "missing";
  git.has = false;
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "paused", branch: "feat/nice" });
  expect(await s.store.getReview(key)).toMatchObject({ gitRef: "feat/qa", feature: { branch: "feat/qa", pausedOn: "feat/nice" } });
  expect((await s.store.getReview(key))?.followed).toBeUndefined();

  // Follow: the same review, now the branch's, with nothing to say.
  const call = (method: string) => s.harness.behavior.callRpc(method, { targetKey: key }) as Promise<any>;
  expect(await call("followFolderBranch")).toEqual({ ok: true });
  expect(await s.store.getReview(key)).toMatchObject({ gitRef: "feat/nice", feature: { branch: "feat/nice", pausedOn: null } });
  expect((await s.store.getReview(key))?.followed).toBeUndefined();
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  // Back on the old branch, which this review no longer is, bb review starts its own.
  s.folder.env = { ...s.folder.env, branchName: "feat/qa" };
  expect((await run(s, "main")).stdout).toMatch(/^Started a review/);
  expect((await s.store.listReviews()).map((r) => r.targetKey).sort()).toEqual([key, featureKey("env1", "feat/qa", 2)].sort());
  // The old branch's id is that review's now, not the one that followed off it.
  expect((await reviewNamed(s.store, s.bb, "api:feat/qa"))?.targetKey).toBe(featureKey("env1", "feat/qa", 2));
  // That one can't follow onto a branch with a review.
  s.folder.env = { ...s.folder.env, branchName: "feat/nice" };
  expect(await s.harness.behavior.callRpc("followFolderBranch", { targetKey: featureKey("env1", "feat/qa", 2) })).toMatchObject({ ok: false });
  // Got it on a followed branch's notice.
  await s.store.setLifecycle(key, { followed: { from: "feat/qa", branch: "feat/nice", at: 1 } });
  expect(await call("dismissFollowed")).toEqual({ ok: true });
  expect((await s.store.getReview(key))?.followed).toBeNull();
});

test("Got it stops the warning about a committed file that looks like a secret, in this review", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "config/.env.production", origin: "tracked" }] });
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  expect((await checkFeature(s.deps, key)).flagged).toEqual(["config/.env.production"]);
  expect(await s.harness.behavior.callRpc("dismissFlagged", { targetKey: key, files: ["config/.env.production"] })).toEqual({ ok: true });
  expect((await s.store.getReview(key))?.flaggedSeen).toEqual(["config/.env.production"]);
  expect((await checkFeature(s.deps, key)).flagged).toEqual([]);
});

test("changed files are counted; Update shows them with the comments moved and no guide writer; with the switch off it's not said", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  await s.store.upsertDraftComment(key, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Why upper case?", author: "reviewer" } as any);
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  // Two lines added above the comment's, and a new file.
  s.folder.files[0]!.body = "@@ -1,3 +1,5 @@\n+zero\n+half\n one\n-two\n+TWO\n three\n";
  s.folder.files.push({ path: "src/b.ts" });
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "changed", changedFiles: 2 });
  // Kept for the lists, until the next Update.
  expect((await s.store.getReview(key))?.feature?.changedFiles).toBe(2);
  expect(await updateFeature(s.deps, key)).toEqual({ ok: true });
  expect((await s.store.getReview(key))?.feature?.changedFiles).toBeNull();
  expect(changedFiles(await s.store.patch(key))).toEqual(["src/a.ts", "src/b.ts"]);
  expect((await s.store.getDraft(key)).comments.map((c) => [c.line, c.body])).toEqual([[4, "Why upper case?"]]);
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.spawns).toHaveLength(1);

  s.folder.files.push({ path: "src/c.ts" });
  const { revision } = await s.store.getPreferences();
  await s.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, localDiffChanges: false } }, revision);
  expect((await checkFeature(s.deps, key)).state).toBe("current");
});

test("once its branch has a PR, the same review becomes the PR's at its head, keeping its comments and folder, with no guide writer", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "src/b.ts" }] });
  await run(s, "main");
  await settled(s);
  await s.store.upsertDraftComment(key, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Keep this", author: "reviewer" } as any);
  // On a file the PR doesn't have.
  await s.store.upsertDraftComment(key, { file: "src/b.ts", line: 1, side: "RIGHT", body: "Not pushed", author: "reviewer" } as any);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  const review = (await s.store.getReview(key))!;
  expect(review).toMatchObject({ kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", headSha: "c0ffee", title: "Snooze flaky checks for a day", head: "feat/qa", base: "main" });
  expect(review.feature?.branch).toBe("feat/qa");
  expect(review.feature?.remoteBranch).toBeUndefined();
  expect(review.cwd).toBeUndefined();
  expect(await s.store.patch(key)).toBe(PR_DIFF);
  // One on a file the PR doesn't have, still in the folder, stays there, not on GitHub yet.
  expect((await s.store.getDraft(key)).comments.map((c) => [c.body, c.side])).toEqual([["Keep this", "RIGHT"], ["Not pushed", "LOCAL"]]);
  expect(await s.store.draftCommentCode(key, { file: "src/b.ts", line: 1, side: "LOCAL" })).toBe("b");
  expect(await prReviewKey(s.store, { repo: "acme/api", number: 7 })).toBe(key);
  // Yours, so Push carries on before the sync has read it, which it does at once; and said, for its notice.
  expect(review).toMatchObject({ ownPr: true, prPending: null, became: { at: expect.any(Number), number: 7, url: "https://github.com/acme/api/pull/7", from: "api:feat/qa", carried: 2, local: 1, outside: 0 } });
  expect(s.deps.sync.one).toHaveBeenCalledWith(key, true);
  expect(s.deps.changed).toHaveBeenCalledWith(key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.spawns).toHaveLength(1);
});

test("a PR whose diff differs from the local changes says the guide was written for them; one with the same diff doesn't", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr" });
  expect((await s.store.getReview(key))?.feature?.guideOlderThanDiff).toBeUndefined();

  // The folder has a file the PR doesn't.
  const t = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "src/b.ts" }] });
  await run(t, "main");
  await settled(t);
  Object.assign(t.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(t.deps, key);
  expect(await t.store.getReview(key)).toMatchObject({ kind: "pr", feature: { guideOlderThanDiff: "pr" } });

  // The same files, one changed otherwise.
  const u = setup({ files: [{ path: "src/a.ts", body: BODY.replace("+TWO", "+Two") }] });
  await run(u, "main");
  await settled(u);
  Object.assign(u.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(u.deps, key);
  expect(await u.store.getReview(key)).toMatchObject({ kind: "pr", feature: { guideOlderThanDiff: "pr" } });
});

// PR Status reports a draft as "draft" (1.9.0): `gh pr create --draft`, as agents often run it, never converted.
test("a draft PR on its branch makes the review the PR's, as an open one does", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa", state: "draft" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7, head: "feat/qa" });
});

// PR Status finds the folder's PR by its branch's upstream: one pushed as HEAD:feat/nice, or from a renamed branch, is the folder's.
test("a PR whose head has another name than the folder's branch makes the review its own, and keeps that name", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  s.view.headRefName = "feat/nice";
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/nice", state: "open" } });
  await checkFeature(s.deps, key);
  const review = (await s.store.getReview(key))!;
  expect(review).toMatchObject({ kind: "pr", number: 7, head: "feat/nice" });
  expect(review.feature).toMatchObject({ branch: "feat/qa", remoteBranch: "feat/nice" });
});

test("a PR's review with its folder says how many files there aren't on GitHub yet, read against the PR's head with no GitHub call; paused and offline as a local review", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "src/b.ts" }] });
  await run(s, "main");
  await settled(s);
  s.view.headRefOid = "c0ffee".padEnd(40, "0");
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect((await s.store.getReview(key))?.kind).toBe("pr");
  const gh = s.ghCalls.length;
  s.calls.length = 0;
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "ahead", aheadFiles: 2, aheadPaths: ["src/a.ts", "src/b.ts"], alsoActive: [] });
  expect(s.calls.find((call) => call.method === "files")?.input.target.mergeBaseBranch).toBe(s.view.headRefOid);
  expect(s.ghCalls).toHaveLength(gh);
  s.folder.files.length = 0;
  expect((await checkFeature(s.deps, key)).state).toBe("current");
  s.folder.env = { branchName: "feat/other" };
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "paused", branch: "feat/other" });
  s.folder.env = {};
  s.folder.connected = false;
  expect((await checkFeature(s.deps, key)).state).toBe("offline");
});

test("each read of Not pushed yet keeps what it showed, and a comment there follows its line", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "src/b.ts" }] });
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  await s.store.upsertDraftComment(key, { file: "src/b.ts", line: 1, side: "RIGHT", body: "Not pushed" });
  s.view.headRefOid = "c0ffee".padEnd(40, "0");
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect((await s.store.getDraft(key)).comments.find((c) => c.file === "src/b.ts")).toMatchObject({ line: 1, side: "LOCAL" });
  s.folder.files[1]!.body = "@@ -1 +1,2 @@\n-a\n+new\n+b\n";
  expect(await s.harness.behavior.callRpc("getNotPushed", { targetKey: key })).toMatchObject({ state: "available", base: s.view.headRefOid, branch: "feat/qa" });
  expect(await s.store.getSnapshot(key, "not-pushed")).toContain("+new\n+b\n");
  expect((await s.store.getDraft(key)).comments.find((c) => c.file === "src/b.ts")).toMatchObject({ line: 2, side: "LOCAL" });
  expect(await s.store.draftCommentCode(key, { file: "src/b.ts", line: 2, side: "LOCAL" })).toBe("b");
});

test("Update on a PR's review with its folder reads the PR at its new head, without the guide writer: a comment not on GitHub before is on its line there now, its id, Send and report kept", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: "src/b.ts" }] });
  await run(s, "main");
  await settled(s);
  await s.store.upsertDraftComment(key, { file: "src/b.ts", line: 1, side: "RIGHT", body: "Not pushed" });
  s.view.headRefOid = "c0ffee".padEnd(40, "0");
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  const local = { file: "src/b.ts", line: 1, side: "LOCAL" } as const;
  const claim = { outcome: "done" as const, threadId: "main", at: 1 };
  await s.store.trackComments(key, [{ at: local, id: "c1", state: "sent", sendN: 1, claim }]);
  // Pushed: the PR's head has b.ts now.
  const pushed = `${PR_DIFF}diff --git a/src/b.ts b/src/b.ts\nindex 1111111..2222222 100644\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b\n`;
  s.view.headRefOid = "beef".padEnd(40, "0");
  s.deps.gh.runGh.mockImplementation(async (args: string[]) => args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify(s.view) } : { code: 0, stderr: "", stdout: pushed });
  const spawns = s.spawns.length;
  expect(await updateFeature(s.deps, key)).toEqual({ ok: true });
  const review = (await s.store.getReview(key))!;
  expect(review).toMatchObject({ kind: "pr", headSha: s.view.headRefOid, feature: { guideOlderThanDiff: "update" } });
  expect(await s.store.patch(key)).toBe(pushed);
  expect((await s.store.getDraft(key)).comments).toEqual([{ file: "src/b.ts", line: 1, side: "RIGHT", body: "Not pushed", id: "c1", state: "sent", sendN: 1, claim }]);
  expect(await s.store.staleDraftComments(key)).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.spawns).toHaveLength(spawns);
});

test("once it's the PR's, the review answers to its old id as to its new one: bb review opens it as it is, and ready, comment and summary find it", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
  const reads = s.ghCalls.length;
  for (const id of ["api:feat/qa", "API#7", key]) {
    // Not a git ref: the review, opened as it is, nothing read again.
    expect(await run(s, "other", [id]), id).toEqual({ exitCode: 0, stdout: expect.stringMatching(new RegExp(`^Opened the review of api#7 "Snooze flaky checks for a day" \\(${key}\\), as it was; nothing was rebuilt\\.`)) });
    expect(JSON.parse((await s.harness.behavior.runCli(["comment", "list", id, "--json"])).stdout).review, id).toBe(key);
    expect(JSON.parse((await s.harness.behavior.runCli(["summary", id, "--json"])).stdout).review, id).toBe(key);
    expect(await s.harness.behavior.runCli(["ready", id]), id).toMatchObject({ exitCode: 0, stdout: "No comments from api#7 are out with a thread, so there's nothing to finish." });
  }
  expect(s.ghCalls).toHaveLength(reads);
  expect(await s.harness.behavior.runCli(["comment", "list", "api:feat/other"])).toMatchObject({ exitCode: 1, stderr: "No saved review for api:feat/other. Pass its id, the PR's URL or the review's key." });
});

test("of two reviews one old id names, one not archived opens, then the newer", async () => {
  const s = setup();
  const review = (targetKey: string, createdAt: number, archivedAt?: number) => s.store.saveReview({ targetKey, kind: "ref", gitRef: "feat/qa", status: "ready", createdAt, ...archivedAt ? { archivedAt } : {} } as any)
    .then(() => s.store.setLifecycle(targetKey, { feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", repo: "acme/api" }, ...archivedAt ? { archivedAt } : {} }));
  await review("br-old", 1);
  await review("br-new", 3, 4);
  await review("br-mid", 2);
  expect((await reviewNamed(s.store, s.bb, "api:feat/qa"))?.targetKey).toBe("br-mid");
});

test("bb review on a branch used again once its PR merged, or closed and went to Archive, starts a new review; a closed PR's review still in the list opens", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
  delete s.folder.pr;
  delete s.folder.prBase;
  await s.store.setLifecycle(key, { prState: "CLOSED" });
  expect((await run(s, "main")).stdout).toMatch(new RegExp(`^Opened the review .*\\(${key}\\)`));
  const again = featureKey("env1", "feat/qa", 2);
  for (const state of [{ prState: "CLOSED", archivedAt: 5 }, { prState: "MERGED", archivedAt: null }] as const) {
    await s.store.setLifecycle(key, state);
    await s.store.deleteReview(again).catch(() => {});
    expect((await run(s, "main")).stdout, state.prState).toMatch(new RegExp(`^Started a review of ~/src/api on MaxBook: .*\\(${again}\\)`));
    expect(await s.store.getReview(again)).toMatchObject({ kind: "ref", gitRef: "feat/qa" });
    // Asked again, the new one opens.
    expect((await run(s, "main")).stdout).toMatch(new RegExp(`^Opened the review .*\\(${again}\\)`));
  }
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
});

test("a PR opened while the guide is being written makes the review the PR's at once; the guide goes on", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  await s.store.setStatus(key, "generating");
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7, status: "generating" });
  expect(await s.store.patch(key)).toBe(PR_DIFF);
});

test("a PR opened before the review waits, unless the folder has its head; one GitHub didn't answer for waits for the next check", async () => {
  const s = setup();
  let behind = 2;
  s.folder.answers = { workspaceStatus: (input) => ({ outcome: "available", workspace: { mergeBase: input.mergeBaseBranch === "c0ffee" ? { aheadCount: 1, behindCount: behind, commits: [] } : null } }) };
  await run(s, "main");
  await settled(s);
  s.view.createdAt = new Date(Date.now() - 86_400_000).toISOString();
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "ref", prPending: { number: 7, url: "https://github.com/acme/api/pull/7", why: "older", at: expect.any(Number) } });
  // Found again, it isn't read again: it waits for your click.
  const reads = s.ghCalls.length;
  expect(await becomePr(s.deps, key, { repo: "acme/api", number: 7 })).toBe("skipped");
  expect(s.ghCalls).toHaveLength(reads);

  // The folder has its head: it's this work's PR.
  await s.store.setLifecycle(key, { prPending: null });
  behind = 0;
  expect(await becomePr(s.deps, key, { repo: "acme/api", number: 7 })).toBe("converted");

  const failing = setup();
  await run(failing, "main");
  await settled(failing);
  const answers = failing.deps.gh.runGh.getMockImplementation()!;
  failing.deps.gh.runGh.mockImplementation(async (args) => args[1] === "view" ? { code: 1, stderr: "HTTP 502: Bad gateway", stdout: "" } : answers(args));
  expect(await becomePr(failing.deps, key, { repo: "acme/api", number: 7 })).toBe("skipped");
  expect(await failing.store.getReview(key)).toMatchObject({ kind: "ref", prPending: { number: 7, why: "error", error: "HTTP 502: Bad gateway" } });
  failing.deps.gh.runGh.mockImplementation(answers);
  expect(await becomePr(failing.deps, key, { repo: "acme/api", number: 7 })).toBe("converted");
  expect((await failing.store.getReview(key))?.prPending).toBeNull();
});

test("a PR another thread in the folder opened makes the review the PR's once that thread goes idle", async () => {
  const s = setup();
  vi.mocked(runGh).mockImplementation(s.deps.gh.runGh as any);
  s.harness.inspection.sdk.stub("threads.events.list", async () => [
    { id: "e1", seq: 4, threadId: "other", scope: {}, type: "item/completed", data: { item: { type: "commandExecution", id: "i1", command: "gh pr create --draft --fill", cwd: "/Users/me/src/api", status: "completed" } } },
  ]);
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa", state: "draft" } });
  await s.harness.behavior.emitThreadEvent("thread.idle", { thread: full(s.all.other!) as any, lastAssistantText: null } as any);
  await vi.waitFor(async () => expect((await s.store.getReview(key))?.kind).toBe("pr"));
});

test("a branch whose PR merged or closed, or another repo's PR, leaves the review of the folder as it is", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  for (const pr of [{ number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa", state: "merged" }, { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa", state: "closed" }, { number: 9, url: "https://github.com/acme/web/pull/9", headRefName: "feat/qa" }]) {
    Object.assign(s.folder, { prBase: "main", pr });
    await checkFeature(s.deps, key);
    expect((await s.store.getReview(key))?.kind).toBe("ref");
  }
  expect(s.ghCalls).toEqual([]);
});

test("a PR whose own review has nothing of yours is merged into the folder's at once; one with your comments waits for your click", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "tracked", createdAt: 1 });
  await s.store.setLifecycle(prKey, { notifiedSignal: "requested:1", watchingSince: 1 });
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "current" });
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7, notifiedSignal: "requested:1", watchingSince: 1,
    became: { number: 7, merged: { comments: 0, summary: false, sends: 0 } }, mergedFrom: [{ key: prKey, id: "api#7", agentThreadId: null }] });
  expect(await s.store.getReview(prKey)).toMatchObject({ mergedInto: key, archivedAt: expect.any(Number) });
  expect(await prReviewKey(s.store, { repo: "acme/api", number: 7 })).toBe(key);
  expect(s.deps.changed).toHaveBeenCalledWith(prKey);

  // The PR's review has your comment: the folder's offers to merge, and stays local, reading nothing of GitHub.
  const t = setup();
  await run(t, "main");
  await settled(t);
  await t.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 1 });
  await t.store.upsertDraftComment(prKey, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Theirs" });
  Object.assign(t.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(t.deps, key);
  expect(await t.store.getReview(key)).toMatchObject({ kind: "ref", prOffer: { key: prKey, number: 7, url: "https://github.com/acme/api/pull/7", moves: { comments: 1, summary: false, sends: 0 } } });
  expect(t.ghCalls).toEqual([]);
  // Asked again, it offers as it did, and changes nothing.
  t.deps.changed.mockClear();
  expect(await becomePr(t.deps, key, { repo: "acme/api", number: 7 })).toBe("offered");
  expect(t.deps.changed).not.toHaveBeenCalled();
  // Your click merges them: the PR's comment comes along, and the PR's review goes to Archive.
  expect(await becomePr(t.deps, key, { repo: "acme/api", number: 7 }, "merge")).toBe("merged");
  expect(await t.store.getReview(key)).toMatchObject({ kind: "pr", prOffer: null, became: { merged: { comments: 1, summary: false, sends: 0 } } });
  expect((await t.store.getDraft(key)).comments.map((c) => c.body)).toEqual(["Theirs"]);
  expect(await t.store.getReview(prKey)).toMatchObject({ mergedInto: key });
});

// The design's "Merge fails partway": the connection drops in the merge, after the conversion's writes.
test("a merge that fails as the review becomes the PR's leaves it as it was, local and offering, never two live reviews of one PR", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "tracked", createdAt: 1 });
  const before = { review: await s.store.getReview(key), patch: await s.store.patch(key), draft: await s.store.getDraft(key) };
  const sql = testSql(s.bb);
  const dropping: typeof sql = { ...sql, run: (text, params) => /INSERT INTO feedback_threads/.test(text) ? Promise.reject(new Error("Connection terminated unexpectedly")) : sql.run(text, params) };
  const failing = { ...s.deps, store: queueStore(storeOn(dropping)) };
  await expect(becomePr(failing, key, { repo: "acme/api", number: 7 })).rejects.toThrow("Connection terminated unexpectedly");
  expect(await s.store.getReview(key)).toEqual(before.review);
  expect(await s.store.patch(key)).toBe(before.patch);
  expect(await s.store.getDraft(key)).toEqual(before.draft);
  expect((await s.store.getReview(prKey))?.mergedInto).toBeUndefined();
  // Found again, it converts and merges.
  expect(await becomePr(s.deps, key, { repo: "acme/api", number: 7 })).toBe("merged");

  // Your click on the offer: the offer stays, to click again.
  const t = setup();
  await run(t, "main");
  await settled(t);
  await t.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 1 });
  await t.store.upsertDraftComment(prKey, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Theirs" });
  expect(await becomePr(t.deps, key, { repo: "acme/api", number: 7 })).toBe("offered");
  const tSql = testSql(t.bb);
  const tDropping: typeof tSql = { ...tSql, run: (text, params) => /INSERT INTO feedback_threads/.test(text) ? Promise.reject(new Error("Connection terminated unexpectedly")) : tSql.run(text, params) };
  await expect(becomePr({ ...t.deps, store: queueStore(storeOn(tDropping)) }, key, { repo: "acme/api", number: 7 }, "merge")).rejects.toThrow("Connection terminated unexpectedly");
  expect(await t.store.getReview(key)).toMatchObject({ kind: "ref", prOffer: { key: prKey } });
  expect((await t.store.getDraft(prKey)).comments).toHaveLength(1);
});

// It reads GitHub and the folder for seconds between deciding to merge on its own and merging.
test("a comment of yours added to the PR's review while the review becomes the PR's is offered, not merged on its own", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "tracked", createdAt: 1 });
  const answers = s.deps.gh.runGh.getMockImplementation()!;
  s.deps.gh.runGh.mockImplementation(async (args) => {
    if (args[1] === "view") await s.store.upsertDraftComment(prKey, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Mine, meanwhile" });
    return answers(args);
  });
  expect(await becomePr(s.deps, key, { repo: "acme/api", number: 7 })).toBe("offered");
  expect(await s.store.getReview(key)).toMatchObject({ kind: "ref", prOffer: { key: prKey, moves: { comments: 1 } } });
  expect(await s.store.getReview(prKey)).not.toHaveProperty("mergedInto");
  expect(s.deps.changed).toHaveBeenCalledWith(key);
});

test("a 1.8.0 folder's review linked to its PR's review merges with it when read, or offers to", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 1 });
  await s.store.saveReviewerNotes(prKey, "Mine", 0);
  const review = (await s.store.getReview(key))!;
  await s.store.setLifecycle(key, { feature: { ...review.feature!, prReview: prKey } });
  await checkFeature(s.deps, key);
  const offered = (await s.store.getReview(key))!;
  expect(offered).toMatchObject({ kind: "ref", prOffer: { key: prKey, moves: { comments: 0, summary: false, sends: 0 } } });
  expect(offered.feature?.prReview).toBeUndefined();

  // With nothing of yours, at once.
  await s.store.saveReviewerNotes(prKey, "", 1);
  await s.store.setLifecycle(key, { prOffer: null, feature: { ...offered.feature!, prReview: prKey } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
  expect((await s.store.getReview(key))?.feature?.prReview).toBeUndefined();
  expect(await s.store.getReview(prKey)).toMatchObject({ mergedInto: key });
});

test("two folders on one branch: the PR's review that began as the first folder's stays, and the second's goes into it", async () => {
  const s = setup(undefined, { other2: { id: "other2", environmentId: "env2", title: "Second folder" } });
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
  // A second folder's review of the branch, with nothing of yours, finds the PR.
  const second = featureKey("env2", "feat/qa");
  const feature = (environmentId: string, path: string) => ({ environmentId, hostId: "host_max", machine: "MaxBook", path, branch: "feat/qa", baseRef: "main", repo: "acme/api" });
  await s.store.saveReview({ targetKey: second, kind: "ref", gitRef: "feat/qa", status: "ready", createdAt: Date.now() });
  await s.store.setLifecycle(second, { feature: feature("env2", "/Users/me/src/api2"), mainThread: { threadId: "other2", environmentId: "env2", origin: "adopted", since: 1 } });
  // Its main thread's idle, Push's read after it and the poll can each find it at once: it merges once.
  const found = await Promise.all([1, 2, 3].map(() => becomePr(s.deps, second, { repo: "acme/api", number: 7 })));
  expect(found.sort()).toEqual(["merged", "skipped", "skipped"]);
  expect(await s.store.getReview(second)).toMatchObject({ kind: "ref", mergedInto: key, archivedAt: expect.any(Number) });
  const kept = (await s.store.getReview(key))!;
  expect(kept).toMatchObject({ kind: "pr", mainThread: { threadId: "main" }, implementers: [{ threadId: "other2" }], mergedFrom: [{ key: second, id: "api:feat/qa" }] });
  expect(kept.mergedFrom).toHaveLength(1);
  // bb review in the second folder opens the review it went into, not a new one.
  const reviews = (await s.store.listReviews()).length;
  const opened = await run(s, "other2");
  expect(opened.stdout).toContain(`Opened the review of ~/src/api on MaxBook: api#7`);
  expect(opened.stdout).toContain(`(${key})`);
  expect(await s.store.listReviews()).toHaveLength(reviews);

  // With a comment of yours, it offers to go into it.
  const third = featureKey("env3", "feat/qa");
  await s.store.saveReview({ targetKey: third, kind: "ref", gitRef: "feat/qa", status: "ready", createdAt: Date.now() });
  await s.store.setLifecycle(third, { feature: feature("env3", "/Users/me/src/api3") });
  await s.store.upsertDraftComment(third, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Mine" });
  expect(await becomePr(s.deps, third, { repo: "acme/api", number: 7 })).toBe("offered");
  expect(await s.store.getReview(third)).toMatchObject({ kind: "ref", prOffer: { key, intoPr: true } });
});

test("Merge the two works from either review's page; a PR opened before the review takes Make it PR #7's review, or Not this one", async () => {
  const s = setup();
  vi.mocked(runGh).mockImplementation(s.deps.gh.runGh as any);
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 1 });
  await s.store.upsertDraftComment(prKey, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Theirs" });
  expect(await becomePr(s.deps, key, { repo: "acme/api", number: 7 })).toBe("offered");
  // From the PR's own review's page, Merge the two: the folder's stays.
  expect(await s.harness.behavior.callRpc("mergeReviews", { targetKey: prKey })).toEqual({ ok: true, targetKey: key });
  expect(await s.store.getReview(prKey)).toMatchObject({ mergedInto: key });
  expect(await s.harness.behavior.callRpc("mergeReviews", { targetKey: key })).toMatchObject({ ok: false, error: "This review has no other review of its PR to merge with. Reload it." });

  const t = setup();
  vi.mocked(runGh).mockImplementation(t.deps.gh.runGh as any);
  t.folder.answers = { workspaceStatus: () => ({ outcome: "available", workspace: { mergeBase: { aheadCount: 1, behindCount: 2, commits: [] } } }) };
  await plugin(t.bb);
  await run(t, "main");
  await settled(t);
  t.view.createdAt = new Date(Date.now() - 86_400_000).toISOString();
  expect(await becomePr(t.deps, key, { repo: "acme/api", number: 7 })).toBe("skipped");
  expect(await t.harness.behavior.callRpc("dismissPendingPr", { targetKey: key })).toEqual({ ok: true });
  expect((await t.store.getReview(key))?.prPending).toMatchObject({ why: "older", declined: true });
  // Found again, it stays declined.
  expect(await becomePr(t.deps, key, { repo: "acme/api", number: 7 })).toBe("skipped");
  expect((await t.store.getReview(key))?.prPending?.declined).toBe(true);
  expect(await t.harness.behavior.callRpc("takePendingPr", { targetKey: key })).toEqual({ ok: true });
  expect(await t.store.getReview(key)).toMatchObject({ kind: "pr", number: 7, prPending: null });
});

/** The sync, with your PR acme/api#7 of feat/qa found by its own search, converting through becomePr as the server does. */
function ownPrSync(s: ReturnType<typeof setup>) {
  const pr = { repo: "acme/api", number: 7, title: "Snooze flaky checks for a day", url: "https://github.com/acme/api/pull/7", author: "me", updatedAt: 1, isDraft: false, requested: false, reviewed: false, own: true as const, head: "feat/qa" };
  const github: GithubReads = {
    viewer: { login: async () => "me", teams: async () => new Set<string>(), reset() {} },
    gate: { poll: async () => ({ kind: "unchanged" }) },
    facts: vi.fn(async () => new Map()), threads: vi.fn(async () => []), discover: vi.fn(async () => []), ownPrs: vi.fn(async () => [pr]),
  };
  const actions: TurnActions = {
    prepare: vi.fn(async () => false), checkPushes: vi.fn(async () => false), checkFixes: vi.fn(async () => false), autoStart: vi.fn(async () => false), projectId: async () => "proj_api",
    becomePr: (key, found) => becomePr(s.deps, key, found),
  };
  return createReviewSync(s.bb, s.store, vi.fn() as any, { github, actions });
}

test("your PR found on GitHub turns the review of its folder and branch into the PR's, the same review, not a second one", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  await s.store.upsertDraftComment(key, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Keep this", author: "reviewer" } as any);
  await ownPrSync(s).all(true);
  const reviews = await s.store.listReviews();
  expect(reviews.map((r) => [r.targetKey, r.kind, r.number])).toEqual([[key, "pr", 7]]);
  expect(await s.store.patch(key)).toBe(PR_DIFF);
  expect((await s.store.getDraft(key)).comments.map((c) => c.body)).toEqual(["Keep this"]);
  expect(await prReviewKey(s.store, { repo: "acme/api", number: 7 })).toBe(key);
});

test("your PR found on GitHub whose review has nothing of yours is merged into the folder's review", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  await s.store.saveReview({ targetKey: prKey, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "tracked", createdAt: 1 });
  await ownPrSync(s).all(true);
  expect(await s.store.getReview(key)).toMatchObject({ kind: "pr", number: 7 });
  expect(await s.store.getReview(prKey)).toMatchObject({ mergedInto: key, archivedAt: expect.any(Number) });
  // Discovery still knows the PR's own key: it isn't added again.
  await ownPrSync(s).all(true);
  expect((await s.store.listReviews()).map((r) => r.targetKey).sort()).toEqual([key, prKey].sort());
});

test("bb removing the folder: a review that became a PR's goes on; a local one waits for its sent comments, else goes to Archive", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  const removed = (environmentId: string) => s.harness.behavior.emitThreadEvent("experimental_environment.removed", { removal: { environmentId, removedAt: Date.now(), hostId: "host_max", path: "/Users/me/src/api", providerOwnedPath: true } });

  // A local review with a sent comment stays out of Archive, for it.
  await s.store.upsertDraftComment(key, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Sent", author: "reviewer" } as any);
  await s.store.trackComments(key, [{ at: { file: "src/a.ts", line: 3, side: "RIGHT" }, id: "c1", state: "sent", sendN: 1 }]);
  await removed("env1");
  let review = (await s.store.getReview(key))!;
  expect(review.feature?.folderGone).toBe(true);
  expect(review.archivedAt ?? null).toBeNull();
  expect(computeTurn(review)).toMatchObject({ group: "needs", reason: "folder-gone", label: "Folder removed" });
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "gone" });

  // One with only a resolved comment goes to Archive, as the sync's; never your own archive.
  const other = setup({ files: [{ path: "src/a.ts", body: BODY }] });
  await plugin(other.bb);
  await run(other, "main");
  await settled(other);
  await other.store.upsertDraftComment(key, { file: "src/a.ts", line: 3, side: "RIGHT", body: "Done", author: "reviewer" } as any);
  await other.store.trackComments(key, [{ at: { file: "src/a.ts", line: 3, side: "RIGHT" }, id: "c1", state: "resolved" }]);
  await other.harness.behavior.emitThreadEvent("experimental_environment.removed", { removal: { environmentId: "env1", removedAt: Date.now(), hostId: "host_max", path: null, providerOwnedPath: true } });
  review = (await other.store.getReview(key))!;
  expect(review.archivedAt).toEqual(expect.any(Number));
  expect(review.userArchivedAt ?? null).toBeNull();
  expect(computeTurn(review)).toMatchObject({ group: "archive", reason: "folder-gone", label: "Folder removed" });

  // A month on, with no comments, its diff goes; the guide and the review stay.
  await other.store.deleteDraftComment(key, { file: "src/a.ts", line: 3, side: "RIGHT" });
  expect(await pruneOldDiffs(other.store, Date.now() + 31 * 86_400_000)).toEqual([key]);
  expect(await other.store.hasPatch(key)).toBe(false);
  expect(await other.store.getReview(key)).not.toBeNull();
});

test("bb removing the folder of a review that became a PR's only marks it", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  Object.assign(s.folder, { prBase: "main", pr: { number: 7, url: "https://github.com/acme/api/pull/7", headRefName: "feat/qa" } });
  await checkFeature(s.deps, key);
  await s.harness.behavior.emitThreadEvent("experimental_environment.removed", { removal: { environmentId: "env1", removedAt: Date.now(), hostId: "host_max", path: "/Users/me/src/api", providerOwnedPath: true } });
  const review = (await s.store.getReview(key))!;
  expect(review).toMatchObject({ kind: "pr", feature: { folderGone: true } });
  expect(review.archivedAt ?? null).toBeNull();
  expect(review.userArchivedAt ?? null).toBeNull();
  expect(computeTurn(review).group).not.toBe("archive");
});

test("Also active here: the folder's other threads, not the main thread, its subagents, or this plugin's", async () => {
  const s = setup(undefined, {
    child: { id: "child", environmentId: "env1", parentThreadId: "main", title: "A subagent bb spawned" },
    agent: { id: "agent", environmentId: "env1", title: "Review agent", visibility: "hidden", originPluginId: "code-review-workspace" },
    gone: { id: "gone", environmentId: "env1", title: "Old", archivedAt: 1 },
    elsewhere: { id: "elsewhere", environmentId: "env2", title: "Elsewhere" },
  });
  await run(s, "main");
  expect((await checkFeature(s.deps, key)).alsoActive).toEqual([{ threadId: "other", title: "Fix the docs" }]);
});

test("an offline machine keeps the review as last read, and says so", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  const before = await s.store.patch(key);
  s.folder.connected = false;
  expect(await checkFeature(s.deps, key)).toMatchObject({ state: "offline", message: "MaxBook is offline. Wake it to see the folder’s latest changes." });
  expect(await updateFeature(s.deps, key)).toMatchObject({ ok: false });
  expect(await s.store.patch(key)).toBe(before);
});

test("Include brings a secret-looking file into the review and keeps it in; the review agent reads it only then", async () => {
  const s = setup({ files: [{ path: "src/a.ts", body: BODY }, { path: ".env", origin: "untracked", body: "@@ -0,0 +1 @@\n+TOKEN=hunter2\n" }] });
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  expect(await s.store.patch(key)).not.toContain("hunter2");
  expect((await checkFeature(s.deps, key)).hidden).toEqual([{ path: ".env", reason: "secret" }]);
  const reads: unknown[] = [];
  // BB reads through a link inside the folder and answers with the link's own path (checked on BB 0.48).
  s.harness.inspection.sdk.stub("files.read", async (args: any) => { reads.push(args); return { content: "TOKEN=hunter2\n", contentEncoding: "utf8", path: args.path, sha256: "x", sizeBytes: 14 }; });
  // As read_file has it: the review's diff, or another given.
  const read = async (path: string, patch?: string) => readFileAt(vi.fn(), vi.fn(), (await s.store.getReview(key))!, path, "current", 1, undefined,
    { bb: s.bb, patch: patch ?? await s.store.patch(key) });
  expect(await read(".env")).toEqual({ ok: false, error: ".env looks like a secret, so it isn't read for agents. The reviewer can include it from the review." });
  expect(reads).toEqual([]);
  expect(await read("src/a.ts")).toEqual({ ok: true, text: "src/a.ts at the working tree, lines 1–1 of 1:\n    1  TOKEN=hunter2" });
  expect(reads).toEqual([{ hostId: "host_max", rootPath: "/Users/me/src/api", path: "/Users/me/src/api/src/a.ts" }]);
  // A link the diff shows isn't followed: read_file names where it points.
  const link = (target: string) => `diff --git a/notes.txt b/notes.txt\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`;
  expect(await read("notes.txt", link("config/.env.local"))).toEqual({ ok: false, error: "notes.txt links to config/.env.local; read that instead." });
  expect(await read("notes.txt", link("../../etc/passwd"))).toEqual({ ok: false, error: "notes.txt links to ../../etc/passwd, outside the folder, so it isn't read." });
  expect(symlinkTarget("diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-old.txt\n+.env\n")).toBe(".env");
  expect(symlinkTarget(link(".env").replace("120000", "100644"))).toBeNull();

  expect(await s.harness.behavior.callRpc("includeHidden", { targetKey: key, files: [".env"], included: true })).toEqual({ ok: true });
  const review = (await s.store.getReview(key))!;
  expect(review.includeHidden).toEqual([".env"]);
  // The guide wasn't written with it: the review says which files changed, not that you clicked Update.
  expect(review.feature?.guideOlderThanDiff).toBe("include");
  expect(await s.store.patch(key)).toContain("hunter2");
  expect((await checkFeature(s.deps, key)).hidden).toEqual([]);
  expect((await read(".env")).ok).toBe(true);
});

test("read_file never reads through a changed link: it names where the link points, whose own checks then apply", async () => {
  const s = setup({ files: [
    { path: "src/a.ts", body: BODY },
    { path: "README.md", link: ".env", replaced: true },
    { path: "a.md", link: "b.md" }, { path: "b.md", link: ".env" },
    { path: "d", link: "sub" }, { path: "sub/x", link: "../.env" },
  ] });
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  // As BB's Git plugin sends a type change: the old file's deletion, then the link.
  const blocks = splitPatchByFile(await s.store.patch(key)).filter((file) => file.path === "README.md");
  expect(blocks.map((block) => block.text.split("\n")[1])).toEqual(["deleted file mode 100644", "new file mode 120000"]);
  const reads: string[] = [];
  s.harness.inspection.sdk.stub("files.read", async (args: any) => { reads.push(args.path); return { content: "TOKEN=hunter2\n", contentEncoding: "utf8", path: args.path, sha256: "x", sizeBytes: 14 }; });
  await s.store.setAssistantThread(key, "thr_agent");
  const tool = s.harness.inspection.registrations.agentTools.find((registered) => registered.name === "read_file")!;
  const readFile = async (path: string) => {
    const result = await tool.execute({ path }, { threadId: "thr_agent" } as any);
    // A tool answers with its text, or with content and whether it failed.
    return typeof result === "string" ? { ok: true, text: result } : { ok: !result.isError, text: (result.content[0] as { text: string }).text };
  };
  const refused = (text: string) => ({ ok: false, text });
  const secret = refused(".env looks like a secret, so it isn't read for agents. The reviewer can include it from the review.");
  // A file replaced by a link: every block of the review's diff for it.
  expect(await readFile("README.md")).toEqual(refused("README.md links to .env; read that instead."));
  expect(await readFile(".env")).toEqual(secret);
  // In another case, as a Mac's folders read it: the same links, the same secret.
  expect(await readFile("readme.md")).toEqual(refused("README.md links to .env; read that instead."));
  expect(await readFile("D/x")).toEqual(refused("d links to sub; read sub/x instead."));
  expect(await readFile(".ENV")).toEqual(refused(".ENV looks like a secret, so it isn't read for agents. The reviewer can include it from the review."));
  // A backslash isn't a path here.
  expect(await readFile("sub\\x")).toEqual(refused("sub\\x isn't a repo-relative file path."));
  // A link to a link: each names the next, and the secret at the end stays unread.
  expect(await readFile("a.md")).toEqual(refused("a.md links to b.md; read that instead."));
  expect(await readFile("b.md")).toEqual(refused("b.md links to .env; read that instead."));
  // A link in a folder above the file, which git lists apart from the file: d/x is sub/x, which links to ../.env.
  expect(await readFile("d/x")).toEqual(refused("d links to sub; read sub/x instead."));
  expect(await readFile("sub/x")).toEqual(refused("sub/x links to ../.env; read .env instead."));
  expect((await readFile("src/a.ts")).ok).toBe(true);
  // Links made since the review read the folder, one pointed elsewhere since, and a folder made a link: its diff now.
  s.folder.files.push({ path: "notes.txt", link: "config/.env.local" }, { path: "src", link: "../elsewhere" });
  s.folder.files.find((file) => file.path === "a.md")!.link = ".env.production";
  expect(await readFile("notes.txt")).toEqual(refused("notes.txt links to config/.env.local; read that instead."));
  expect(await readFile("NOTES.txt")).toEqual(refused("notes.txt links to config/.env.local; read that instead."));
  expect(await readFile("a.md")).toEqual(refused("a.md links to b.md; read that instead."));
  expect(await readFile("src/a.ts")).toEqual(refused("src links to ../elsewhere, outside the folder, so it isn't read."));
  expect(reads).toEqual(["/Users/me/src/api/src/a.ts"]);
  // Unknown is no: a folder BB can't list now, or lists only part of, isn't read.
  s.folder.files = s.folder.files.filter((file) => file.path !== "src");
  s.folder.listLimit = 1;
  expect(await readFile("src/a.ts")).toEqual(refused("Couldn't check src/a.ts in the folder before reading it: BB lists only part of the folder’s changes, so it can’t tell whether this path goes through a link."));
  // The review's diff still names the link in a list cut short.
  expect(await readFile("README.md")).toEqual(refused("README.md links to .env; read that instead."));
  s.folder.listLimit = undefined;
  // Gone from the folder's diff now, the review's diff still names it, in any case.
  s.folder.files = s.folder.files.filter((file) => file.path !== "README.md");
  expect(await readFile("readme.md")).toEqual(refused("README.md links to .env; read that instead."));
  s.folder.throws = "Host request timed out";
  expect(await readFile("src/a.ts")).toEqual(refused("Couldn't check src/a.ts in the folder before reading it: Host request timed out"));
});

test("Update guide and Rewrite guide read the folder again, and its files with it", async () => {
  const s = setup();
  await run(s, "main");
  await settled(s);
  s.folder.files.push({ path: "src/b.ts" });
  expect(await rerunReview(s.deps, key)).toEqual({ ok: true });
  expect(changedFiles(await s.store.patch(key))).toEqual(["src/a.ts", "src/b.ts"]);
  await vi.waitFor(() => expect(s.spawns).toHaveLength(2));
  await settled(s);
  expect((await checkFeature(s.deps, key)).state).toBe("current");
});

test("Review ‹the other branch› opens that branch's own review, addressed to the same main thread", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  s.folder.env = { ...s.folder.env, branchName: "feat/other" };
  const opened = await s.harness.behavior.callRpc("reviewFolderBranch", { targetKey: key }) as { ok: boolean; targetKey: string };
  expect(opened).toEqual({ ok: true, targetKey: featureKey("env1", "feat/other") });
  expect(await s.store.getReview(opened.targetKey)).toMatchObject({ gitRef: "feat/other", mainThread: { threadId: "main" } });
  expect((await s.store.getReview(key))?.gitRef).toBe("feat/qa");
});

test("`bb review <ref>` in a checkout is unchanged: a ref- review with its cwd", async () => {
  const s = setup();
  s.deps.gh.runGit.mockResolvedValue({ code: 0, stderr: "", stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" });
  expect((await runReviewCommand(s.deps, ["HEAD"], { projectId: "p1", threadId: "main", cwd: process.cwd() })).exitCode).toBe(0);
  const [review] = await s.store.listReviews();
  expect(review).toMatchObject({ kind: "ref", gitRef: "HEAD", cwd: process.cwd() });
  expect(review!.targetKey).toMatch(/^ref-/);
  expect(review!.feature).toBeUndefined();
});

test("the main thread going idle checks its folder and asks open pages to look again; another thread's doesn't", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  s.folder.env = { ...s.folder.env, branchName: "feat/other" };
  const idle = (id: string) => s.harness.behavior.emitThreadEvent("thread.idle", { thread: full(s.all[id]!) as any, lastAssistantText: null } as any);
  await idle("other");
  expect((await s.store.getReview(key))?.feature?.pausedOn ?? null).toBeNull();
  expect(s.harness.inspection.realtimeSignals.some((signal) => signal.channel === `folder:${key}`)).toBe(false);
  await idle("main");
  expect((await s.store.getReview(key))?.feature?.pausedOn).toBe("feat/other");
  expect(s.harness.inspection.realtimeSignals.some((signal) => signal.channel === `folder:${key}`)).toBe(true);
});

test("the page's Update reads a folder's review from its folder, not a checkout, and then says the guide is older than the diff", async () => {
  const s = setup();
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  const call = (method: string) => s.harness.behavior.callRpc(method, { targetKey: key }) as Promise<any>;
  // Nothing new: the guide is still the diff's.
  expect(await call("updateFeature")).toEqual({ ok: true });
  expect((await s.store.getReview(key))?.feature?.guideOlderThanDiff).toBeUndefined();
  s.folder.files.push({ path: "src/b.ts" });
  // A folder's review has no checkout, so the checkout's notice never fires; its folder's notices say what changed.
  expect((await call("checkForUpdates")).localChanged).toBeUndefined();
  expect(await call("updateFeature")).toEqual({ ok: true });
  expect(changedFiles(await s.store.patch(key))).toEqual(["src/a.ts", "src/b.ts"]);
  expect((await s.store.getReview(key))?.feature?.guideOlderThanDiff).toBe("update");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.spawns).toHaveLength(1);
  // A rewrite that doesn't give a guide (this writer fails at once) leaves it said: the guide is still the older one.
  expect(await call("rewriteGuide")).toEqual({ ok: true });
  await vi.waitFor(() => expect(s.spawns).toHaveLength(2));
  await vi.waitFor(async () => expect((await s.store.getReview(key))?.status).not.toBe("generating"));
  expect((await s.store.getReview(key))?.feature?.guideOlderThanDiff).toBe("update");
});

test("read_changes_since_review compares a folder's Send with the folder now, and fails, never saying nothing changed, when it can't tell", async () => {
  const s = setup(undefined, { "agent-1": { id: "agent-1", environmentId: null, title: `Review agent: ${key}`, visibility: "hidden", originPluginId: "code-review-workspace" } });
  await plugin(s.bb);
  await run(s, "main");
  await settled(s);
  // Send 1 went at the diff the review shows, src/b.ts kept out as too large; Send 2's files weren't kept.
  const sent = await s.store.patch(key);
  for (const n of [1, 2]) await s.store.saveSnapshot(key, `send:${n}`, sent);
  await s.store.saveSnapshotFiles(key, "send:1", { revisions: {}, hidden: [{ path: "src/b.ts", reason: "large" }] });
  await s.store.setLifecycle(key, { sends: [1, 2].map((n) => ({ n, at: n, threadId: "main", ids: [`c${n}`] })) });
  await s.store.setAssistantThread(key, "agent-1");
  const read = (send: number) => s.harness.behavior.callAgentTool("read_changes_since_review", { send }, { threadId: "agent-1" });
  // The main thread fixed src/a.ts and added src/b.ts; nobody clicked Update, so the review still shows Send 1's diff.
  s.folder.files[0]!.body = "@@ -1,3 +1,3 @@\n one\n-two\n+Two\n three\n";
  s.folder.files.push({ path: "src/b.ts" });
  const changes = await read(1);
  expect(toolFailed(changes)).toBe(false);
  expect(toolText(changes)).toContain("Kept out of the diff at Send 1, shown now, so read as added: src/b.ts.");
  expect(toolText(changes)).toContain("Since Send 1: 1 changed, 1 added, 0 removed, 0 unchanged files.");
  expect(toolText(changes)).toContain("+Two");
  // Which files Send 2 kept out isn't known: unknown, so it fails.
  const unknown = await read(2);
  expect(toolFailed(unknown)).toBe(true);
  expect(toolText(unknown)).toContain("Which files Send 2 kept out of the diff isn't known anymore");
  // The machine asleep: it says why.
  s.folder.connected = false;
  const offline = await read(1);
  expect(toolFailed(offline)).toBe(true);
  expect(toolText(offline)).toContain("Couldn't read the folder now");
  expect(toolText(offline)).toContain("MaxBook is offline");
  expect(toolText(offline)).not.toMatch(/No changes/);
});
