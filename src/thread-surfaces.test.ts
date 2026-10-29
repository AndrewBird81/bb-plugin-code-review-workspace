// BB's thread pages: Review changes starts or opens a folder's review, as bb review with no arguments does, and the
// index and review reads behind it and the Review tab read only the plugin's own records, never the folder's diff.
import { expect, test } from "vitest";
import { folderHost } from "./env-diff.test-support";
import { featureKey } from "./targets";
import { defaultPreferences } from "./preferences";
import { testStore } from "./test-store.test-support";
import { recordFormerWorker } from "./former-workers";
import plugin from "../server";

const BODY = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const full = (thread: { id: string; environmentId: string | null; parentThreadId?: string | null; title?: string | null }) =>
  ({ parentThreadId: null, title: null, titleFallback: null, archivedAt: null, deletedAt: null, visibility: "visible", originPluginId: null, ...thread });

/** A folder (env1, MaxBook, feat/qa) where `main` leads and `sub` is its subagent; the plugin served on it. */
async function setup(env: Record<string, unknown> = {}) {
  const threads: Record<string, Parameters<typeof full>[0] & { visibility?: string; archivedAt?: number | null }> = {
    main: { id: "main", environmentId: "env1", title: "Snooze flaky checks" },
    sub: { id: "sub", environmentId: "env1", parentThreadId: "main", title: "Subagent" },
    // The plugin's own, in the project's checkout: a review agent, a guide writer, and one hidden thread of no record.
    agent: { id: "agent", environmentId: "env1", visibility: "hidden" },
    writer: { id: "writer", environmentId: "env1", visibility: "visible" },
    unrecorded: { id: "unrecorded", environmentId: "env1", visibility: "hidden" },
    other: { id: "other", environmentId: "env1", title: "Carry on" },
  };
  const spawns: unknown[] = [];
  const host = folderHost({ files: [{ path: "src/a.ts", body: BODY }], env }, { threads: {
    get: async ({ threadId }: { threadId: string }) => {
      if (!threads[threadId]) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return full(threads[threadId]);
    },
    list: async () => Object.values(threads).map(full),
    experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }),
    // The guide writer: counted, and failing at once.
    spawn: async (args: unknown) => { spawns.push(args); throw new Error("fixture worker"); },
    archive: async () => ({}), stop: async () => ({}), wait: async () => ({}),
  } });
  await plugin(host.bb);
  const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<any>;
  return { ...host, spawns, call, threads };
}
const key = featureKey("env1", "feat/qa");

test("Review changes starts the folder's review as bb review does, addressed to the top thread there; clicked again, it only opens it", async () => {
  const s = await setup();
  expect(await s.call("reviewThreadChanges", { threadId: "sub" })).toEqual({ ok: true, targetKey: key });
  const listed = await s.call("threadLinks", null);
  expect(listed.reviews).toEqual([{ targetKey: key, createdAt: expect.any(Number), main: "main", threads: ["main"], folder: { environmentId: "env1", branch: "feat/qa", paused: false } }]);
  await expect.poll(() => s.spawns.length).toBe(1);
  const reads = s.calls.length;
  expect(await s.call("reviewThreadChanges", { threadId: "main" })).toEqual({ ok: true, targetKey: key });
  // Nothing rebuilt: no guide writer, and the folder's diff not read again.
  expect(s.spawns).toHaveLength(1);
  expect(s.calls).toHaveLength(reads);
});

test("Review changes says why when the folder can't be reviewed, and starts nothing", async () => {
  const s = await setup({ branchName: null });
  expect(await s.call("reviewThreadChanges", { threadId: "main" })).toEqual({ ok: false, error: expect.stringContaining("isn’t on a branch") });
  expect(await s.call("threadLinks", null)).toEqual({ reviewChangesLine: true, reviews: [], agents: [] });
  expect(s.spawns).toHaveLength(0);
});

test("the index lists each review by its main thread, the threads before it, its Sends', and its folder, never the archived, with the plugin's own agents; it reads no git", async () => {
  const s = await setup();
  const store = testStore(s.bb);
  const feature = { environmentId: "env2", hostId: "host_max", machine: "MaxBook", path: "/w", branch: "feat/x", baseRef: "main", repo: "acme/api" };
  await store.saveReview({ targetKey: "br-a", kind: "ref", gitRef: "feat/x", status: "ready", createdAt: 1 });
  await store.setLifecycle("br-a", {
    feature: { ...feature, workBranch: "bb/x-thr_9", pausedOn: "main" },
    mainThread: { threadId: "fresh", environmentId: "env2", origin: "fresh", since: 2 }, implementers: [{ threadId: "first", environmentId: "env2", origin: "adopted", since: 1 }],
    sends: [{ n: 1, at: 1, threadId: "sent-to", ids: ["c1"] }], sourceThreadId: "first",
  });
  await store.saveReview({ targetKey: "pr-b", kind: "pr", repo: "acme/api", number: 4, status: "ready", createdAt: 2 });
  // The thread that ran bb review on a PR isn't linked to it; its fixer is.
  await store.setLifecycle("pr-b", { sourceThreadId: "asker", mainThread: { threadId: "pr-fixer", environmentId: null, origin: "fresh", since: 2 } });
  await store.saveReview({ targetKey: "pr-asked", kind: "pr", repo: "acme/api", number: 7, status: "ready", createdAt: 6 });
  await store.setLifecycle("pr-asked", { sourceThreadId: "asker" });
  await store.setAssistantThread("pr-b", "agent-b");
  await store.saveReview({ targetKey: "br-gone", kind: "ref", gitRef: "feat/y", status: "ready", createdAt: 3 });
  await store.setLifecycle("br-gone", { feature: { ...feature, branch: "feat/y", folderGone: true } });
  await store.saveReview({ targetKey: "pr-archived", kind: "pr", repo: "acme/api", number: 5, status: "ready", createdAt: 4 });
  await store.setLifecycle("pr-archived", { sourceThreadId: "asker", userArchivedAt: 5 });
  await store.saveReview({ targetKey: "pr-unlinked", kind: "pr", repo: "acme/api", number: 6, status: "ready", createdAt: 5 });
  await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, reviewChangesLine: false } }, 0);

  const listed = await s.call("threadLinks", null);
  expect(listed.reviewChangesLine).toBe(false);
  expect([...listed.reviews].sort((a, b) => a.createdAt - b.createdAt)).toEqual([
    { targetKey: "br-a", createdAt: 1, main: "fresh", threads: ["fresh", "first", "sent-to"], folder: { environmentId: "env2", branch: "bb/x-thr_9", paused: true } },
    { targetKey: "pr-b", createdAt: 2, main: "pr-fixer", threads: ["pr-fixer"], folder: null },
  ]);
  expect(listed.agents).toEqual(["agent-b"]);
  await s.call("threadReview", { targetKey: "br-a" });
  expect(s.calls).toEqual([]);
});

test("a review as a thread page reads it: its place for its id, and only its open comments counted", async () => {
  const s = await setup();
  await s.call("reviewThreadChanges", { threadId: "main" });
  const store = testStore(s.bb);
  await expect.poll(async () => (await store.getReview(key))?.status).not.toBe("generating");
  for (const line of [1, 2, 3]) await store.upsertDraftComment(key, { file: "src/a.ts", line, side: "RIGHT", body: `Fix ${line}.` });
  await store.trackComments(key, [{ at: { file: "src/a.ts", line: 2, side: "RIGHT" }, id: "c1", state: "sent", sendN: 1 }, { at: { file: "src/a.ts", line: 3, side: "RIGHT" }, id: "c2", state: "resolved" }]);
  const read = await s.call("threadReview", { targetKey: key });
  expect(read.open).toBe(1);
  expect(read.review).toMatchObject({ targetKey: key, place: { repo: "acme/api", machine: "MaxBook", path: "/Users/me/src/api" }, mainThread: { threadId: "main" } });
  expect(await s.call("threadReview", { targetKey: "br-none" })).toEqual({ review: null, open: 0 });
});

test("Review changes never makes one of the plugin's agents a main thread: not from its page, nor its shell", async () => {
  const s = await setup();
  const store = testStore(s.bb);
  await store.setAssistantThread("pr-x", "agent");
  await store.saveReview({ targetKey: "pr-y", kind: "pr", repo: "acme/api", number: 9, status: "generating", createdAt: 1 });
  await store.setGenerationWorker("pr-y", await store.beginGeneration("pr-y"), "writer");
  for (const threadId of ["agent", "writer", "unrecorded"]) {
    expect(await s.call("reviewThreadChanges", { threadId }), threadId).toEqual({ ok: false, error: expect.stringContaining("one of Code Review Workspace’s agents") });
  }
  expect(await store.getReview(key)).toBeNull();
  expect(s.calls).toEqual([]);
});

test("on a folder with a review, Review changes opens it as bb review does: a live thread there takes over from an archived main thread, with no diff read", async () => {
  const s = await setup();
  await s.call("reviewThreadChanges", { threadId: "main" });
  await expect.poll(() => s.spawns.length).toBe(1);
  s.threads.main!.archivedAt = Date.now();
  const reads = s.calls.length;
  expect(await s.call("reviewThreadChanges", { threadId: "other" })).toEqual({ ok: true, targetKey: key });
  const review = await testStore(s.bb).getReview(key);
  expect(review?.mainThread?.threadId).toBe("other");
  expect(review?.implementers?.map((thread) => thread.threadId)).toEqual(["main"]);
  expect(s.calls).toHaveLength(reads);
  expect(s.spawns).toHaveLength(1);
});

test("a thread a review agent started, in its folder, leads to that agent: neither Review changes nor bb review makes the agent a main thread", async () => {
  const s = await setup();
  await testStore(s.bb).setAssistantThread("pr-x", "agent");
  // Visible itself, under the hidden review agent, in the same folder.
  s.threads.child = { id: "child", environmentId: "env1", parentThreadId: "agent", title: "Agent's helper" };
  expect(await s.call("reviewThreadChanges", { threadId: "child" })).toEqual({ ok: false, error: expect.stringContaining("one of Code Review Workspace’s agents, or works under one") });
  expect(await s.harness.behavior.runCli([], { threadId: "child", projectId: "proj_api", cwd: "/Users/me/src/api" })).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("works under one") });
  expect(await testStore(s.bb).getReview(key)).toBeNull();
  // A thread that was a review agent, visible or not, is one too; its page offers no Review changes.
  await recordFormerWorker(s.bb, "other", "pr-x", "assistant");
  expect(await s.call("reviewThreadChanges", { threadId: "other" })).toMatchObject({ ok: false });
  expect((await s.call("threadLinks", null)).agents).toEqual(expect.arrayContaining(["agent", "other"]));
  // The thread leading the folder still can.
  expect(await s.harness.behavior.runCli([], { threadId: "sub", projectId: "proj_api", cwd: "/Users/me/src/api" })).toMatchObject({ exitCode: 0 });
});

test("a review re-homed to its fixer's worktree opens as it is from the fixer's Review changes and bb review: no second review, no diff read, no guide writer", async () => {
  const s = await setup({ branchName: "bb/env_fix1" });
  const store = testStore(s.bb);
  // 4.2's own-rehomed: your PR's review, moved to fixer1's worktree on its own branch, its key the old folder's.
  const rehomed = { environmentId: "env_fix1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/.bb/worktrees/env_fix1", branch: "retry-uploads", baseRef: "main", repo: "acme/api", workBranch: "bb/env_fix1" };
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/api", number: 1, status: "ready", createdAt: 1 });
  await store.setLifecycle("pr-1", { ownPr: true, feature: rehomed, mainThread: { threadId: "fixer1", environmentId: "env_fix1", origin: "fresh", since: 2 }, sends: [{ n: 1, at: 2, threadId: "fixer1", ids: [] }] });
  s.threads.fixer1 = { id: "fixer1", environmentId: "env_fix1", title: "Fixes 1" };
  // The page's index and the server find the same review for the folder at its branch.
  expect((await s.call("threadLinks", null)).reviews).toEqual([expect.objectContaining({ targetKey: "pr-1", folder: { environmentId: "env_fix1", branch: "bb/env_fix1", paused: false } })]);
  expect(await s.call("reviewThreadChanges", { threadId: "fixer1" })).toEqual({ ok: true, targetKey: "pr-1" });
  expect((await store.listReviews()).map((review) => review.targetKey)).toEqual(["pr-1"]);
  expect(s.calls).toEqual([]);
  expect(s.spawns).toEqual([]);
  // bb review with no arguments, there, opens the same review.
  const cli = await s.harness.behavior.runCli([], { threadId: "fixer1", projectId: "proj_api", cwd: "/Users/me/.bb/worktrees/env_fix1" });
  expect(cli).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("(pr-1), as it was; nothing was rebuilt") });
  expect((await store.listReviews()).map((review) => review.targetKey)).toEqual(["pr-1"]);
  expect((await store.getReview("pr-1"))?.mainThread?.threadId).toBe("fixer1");
  expect(s.calls).toEqual([]);
  expect(s.spawns).toEqual([]);
});

test("a re-homed review you archived comes back when its fixer's Review changes opens it, as bb review brings one back", async () => {
  const s = await setup({ branchName: "bb/env_fix1" });
  const store = testStore(s.bb);
  const rehomed = { environmentId: "env_fix1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/.bb/worktrees/env_fix1", branch: "retry-uploads", baseRef: "main", repo: "acme/api", workBranch: "bb/env_fix1" };
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/api", number: 1, status: "ready", createdAt: 1 });
  await store.setLifecycle("pr-1", { ownPr: true, feature: rehomed, mainThread: { threadId: "fixer1", environmentId: "env_fix1", origin: "fresh", since: 2 }, userArchivedAt: 5 });
  s.threads.fixer1 = { id: "fixer1", environmentId: "env_fix1", title: "Fixes 1" };
  expect(await s.call("reviewThreadChanges", { threadId: "fixer1" })).toEqual({ ok: true, targetKey: "pr-1" });
  expect((await store.getReview("pr-1"))?.userArchivedAt ?? null).toBeNull();
  expect((await store.listReviews()).map((review) => review.targetKey)).toEqual(["pr-1"]);
  expect(s.calls).toEqual([]);
});

test("a hidden subagent of a visible main thread may run bb review with no arguments: the review goes to that main thread", async () => {
  const s = await setup();
  s.threads.hiddenSub = { id: "hiddenSub", environmentId: "env1", parentThreadId: "main", visibility: "hidden", title: "Worker" };
  expect(await s.harness.behavior.runCli([], { threadId: "hiddenSub", projectId: "proj_api", cwd: "/Users/me/src/api" })).toMatchObject({ exitCode: 0 });
  expect((await testStore(s.bb).getReview(key))?.mainThread?.threadId).toBe("main");
});

test("a re-homed review whose PR merged, archived by the sync, isn't the fixer's folder's review any more: bb review there starts a new one", async () => {
  const s = await setup({ branchName: "bb/env_fix1" });
  const store = testStore(s.bb);
  const rehomed = { environmentId: "env_fix1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/.bb/worktrees/env_fix1", branch: "retry-uploads", baseRef: "main", repo: "acme/api", workBranch: "bb/env_fix1" };
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/api", number: 1, status: "ready", createdAt: 1 });
  await store.setLifecycle("pr-1", { ownPr: true, prState: "MERGED", feature: rehomed, mainThread: { threadId: "fixer1", environmentId: "env_fix1", origin: "fresh", since: 2 }, archivedAt: 5 });
  s.threads.fixer1 = { id: "fixer1", environmentId: "env_fix1", title: "Fixes 1" };
  expect(await s.harness.behavior.runCli([], { threadId: "fixer1", projectId: "proj_api", cwd: "/Users/me/.bb/worktrees/env_fix1" })).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Started a review") });
  const fresh = featureKey("env_fix1", "bb/env_fix1");
  expect((await store.listReviews()).map((review) => review.targetKey).sort()).toEqual([fresh, "pr-1"].sort());
  expect((await store.getReview("pr-1"))?.archivedAt).toBe(5);
});
