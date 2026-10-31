// The loop's Send (src/loop.ts): comments to the review's main thread, each with an id, recorded as Send n with its
// snapshot; Send now; the review agent's send_now, with its patch on the comment's Send; the main thread archived or
// gone, a folder removed, and someone else's PR, which warn and then send as you choose; and changing the main thread.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })));
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { register } from "./loop";
import { sendToAgent, type Classify } from "./asking";
import { agentChat } from "./agent-chat.test-support";
import { startPlugin } from "./plugin-store.test-support";
import { testStore } from "./test-store.test-support";
import { folderHost } from "./env-diff.test-support";
import { diffFilesHead } from "./env-diff";
import { featureKey } from "./targets";
import { defaultPreferences } from "./preferences";
import { reviewRevision } from "./review-revision";
import { toolFailed, toolText } from "./fake-host.test-support";
import type { AsyncStore } from "./store-queue";
import type { ServeDeps } from "./server-modules";
import type { CommentLocation } from "./draft";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@",
  " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export { a };",
].join("\n");
const FIX = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-const b = 3;\n+const total = 3;\n";
const A3 = { file: "src/a.ts", line: 3, side: "RIGHT" as const };
const B2 = { file: "src/a.ts", line: 2, side: "LEFT" as const };

interface T { title: string | null; archivedAt?: number | null; deletedAt?: number | null; environmentId?: string | null; busy?: boolean; originPluginId?: string | null; visibility?: string }

/** A BB with `threads`, by id; a busy one queues what's sent to it. Spawns start "fresh", in the environment asked for. */
/** The folder a spawn in a new worktree gets: BB may not say yet (null). */
const spawned = { environmentId: "env_new" as string | null };

function threadsSdk(threads: Record<string, T>) {
  return {
    get: async ({ threadId }: { threadId: string }) => {
      const thread = threads[threadId];
      if (!thread) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
      return { id: threadId, archivedAt: null, deletedAt: null, environmentId: null, status: "idle", titleFallback: null, visibility: "visible", originPluginId: null, ...thread };
    },
    send: async ({ threadId }: { threadId: string }) => threads[threadId]?.busy ? { ok: true, delivery: "queued", queuedMessage: { id: "q1" } } : { ok: true, delivery: "sent" },
    spawn: async (args: any) => ({ id: "fresh", title: args.title, environmentId: args.environment.type === "reuse" ? args.environment.environmentId : spawned.environmentId }),
    unarchive: async ({ threadId }: { threadId: string }) => { threads[threadId]!.archivedAt = null; return { ok: true }; },
  };
}

function host(threads: Record<string, T> = { coder: { title: "Retry uploads" } }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: threadsSdk(threads),
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }) },
  } as any });
  const calls = (method: string) => harness.inspection.sdk.callsTo(method).map((call) => call[0] as any);
  return { bb, harness, threads, sends: () => calls("threads.send"), spawns: () => calls("threads.spawn"), calls };
}

/** Your own PR acme/web#12, sent to `coder`, with two draft comments. */
async function ownPr(store: AsyncStore, over: Record<string, unknown> = {}) {
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 12, title: "Retry uploads", author: "alice", head: "retry-uploads", headSha: "abc1234def5678", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("pr-1", { ownPr: true, sourceThreadId: "coder", sourceThreadAt: 1, ...over });
  await store.savePatch("pr-1", PATCH);
  await store.upsertDraftComment("pr-1", { ...B2, body: "Why change b?" });
  await store.upsertDraftComment("pr-1", { ...A3, body: "Name this better." });
}

const call = (harness: ReturnType<typeof host>["harness"], method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
const comment = async (store: AsyncStore, at: CommentLocation) => (await store.getDraft("pr-1")).comments.find((c) => c.file === at.file && c.line === at.line && c.side === at.side)!;

test("Send gives each comment an id and sends them to the main thread with the review's header, their code and words, no push, and how to report", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  const sent = await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3, B2] });
  expect(sent).toEqual({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder", sendN: 1 });
  const [{ threadId, mode, input }] = h.sends();
  expect([threadId, mode]).toEqual(["coder", "queue-if-active"]);
  const text: string = input[0].text;
  expect(text).toMatch(/^Review web#12 "Retry uploads", from Code Review Workspace:\nFix these comments from my review of acme\/web PR #12/);
  const [b, a] = [await comment(store, B2), await comment(store, A3)];
  expect([b.id, a.id]).toEqual(["c1", "c2"]);
  expect(text).toContain("c1 · `src/a.ts:2` (old line)\n```diff\n-const b = 2;\n```\nWhy change b?");
  expect(text).toContain("c2 · `src/a.ts:3`\n```diff\n+const c = 4;\n```\nName this better.");
  expect(text.endsWith("Don't push until I say.\n\nReport each with `bb review report <id> done|declined --note \"…\"`; run `bb review ready` when finished.")).toBe(true);
  // Each is sent in Send 1, whose diff is kept; the draft is otherwise as it was.
  expect([a, b].map(({ state, sendN }) => ({ state, sendN }))).toEqual([{ state: "sent", sendN: 1 }, { state: "sent", sendN: 1 }]);
  const review = (await store.getReview("pr-1"))!;
  expect(review.sends).toEqual([{ n: 1, at: expect.any(Number), threadId: "coder", ids: ["c1", "c2"] }]);
  expect(await store.getSnapshot("pr-1", "send:1")).toBe(PATCH);
  // 1.7.0's record, which a rollback reads, too.
  expect(review.sent).toMatchObject({ threadId: "coder", title: "Retry uploads", comments: [{ ...B2, body: "Why change b?" }, { ...A3, body: "Name this better." }] });
  expect(h.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual(expect.arrayContaining(["review:pr-1", "draft:pr-1"]));
});

test("Send takes a comment on a line only in the folder, with its code from Not pushed yet, and keeps that diff as send:<n>:local", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  const shown = "diff --git a/src/b.ts b/src/b.ts\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export const d = 5;\n";
  await store.saveSnapshot("pr-1", "not-pushed", shown);
  const LOCAL = { file: "src/b.ts", line: 1, side: "LOCAL" as const };
  await store.upsertDraftComment("pr-1", { ...LOCAL, body: "Export it from the index." });
  expect(await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3, LOCAL] })).toMatchObject({ ok: true, sendN: 1 });
  expect(h.sends()[0].input[0].text).toContain("c2 · `src/b.ts:1` (in the folder, not on GitHub yet)\n```diff\n+export const d = 5;\n```\nExport it from the index.");
  expect(await comment(store, LOCAL)).toMatchObject({ id: "c2", state: "sent", sendN: 1 });
  expect(await store.getSnapshot("pr-1", "send:1:local")).toBe(shown);
  expect(await store.getSnapshot("pr-1", "send:1")).toBe(PATCH);
});

test("two Sends while the main thread is busy are two queued messages, Send 1 and Send 2, and a comment keeps its id", async () => {
  const h = host({ coder: { title: "Retry uploads", busy: true } });
  const store = await startPlugin(h.bb);
  await ownPr(store);
  expect(await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3] })).toMatchObject({ ok: true, delivery: "queued", sendN: 1 });
  // Edited after it went, it's open again, with its id, for the next Send.
  await store.upsertDraftComment("pr-1", { ...A3, body: "Name this `total`." });
  expect(await comment(store, A3)).toMatchObject({ id: "c1", state: "open", sendN: 1 });
  expect(await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3, B2] })).toMatchObject({ ok: true, delivery: "queued", sendN: 2 });
  expect(h.sends()).toHaveLength(2);
  expect(h.sends()[1].input[0].text).toContain("c1 · `src/a.ts:3`");
  expect(await comment(store, A3)).toMatchObject({ id: "c1", state: "sent", sendN: 2 });
  expect((await store.getReview("pr-1"))!.sends!.map(({ n, ids }) => ({ n, ids }))).toEqual([{ n: 1, ids: ["c1"] }, { n: 2, ids: ["c2", "c1"] }]);
});

test("a Send queued behind a busy thread's turn is queued until the thread takes it; deleted from the queue, its comments are open again", async () => {
  const h = host({ coder: { title: "Retry uploads", busy: true } });
  const store = await startPlugin(h.bb);
  await ownPr(store);
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 });
  expect((await store.getReview("pr-1"))!.sends![0]).toMatchObject({ n: 1, queued: "q1" });
  await h.harness.behavior.emitThreadEvent("message.dispatched", { entry: { id: "q1", threadId: "coder" } } as any);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))!.sends![0]).not.toHaveProperty("queued"));
  expect(await comment(store, A3)).toMatchObject({ state: "sent", sendN: 1 });
  // Another, which you delete from the thread's queue before it runs: never sent.
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: B2 });
  await h.harness.behavior.emitThreadEvent("message.cancelled", { entry: { id: "q1", threadId: "coder" } } as any);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))!.sends!.map((send) => send.n)).toEqual([1]));
  expect(await comment(store, B2)).toMatchObject({ id: "c2", state: "open" });
  expect(await comment(store, B2)).not.toHaveProperty("sendN");
  expect(await comment(store, A3)).toMatchObject({ state: "sent", sendN: 1 });
});

test("Change main thread's Start a fresh thread here starts one in the folder, told what it's for, and makes it the main thread", async () => {
  const f = await folderReview();
  expect(await f.harness.behavior.callRpc("setMainThread", { targetKey: f.key, fresh: true })).toEqual({ ok: true });
  const [spawn] = f.calls("threads.spawn");
  expect(spawn).toMatchObject({ projectId: "proj_api", environment: { type: "reuse", environmentId: "env1" }, title: "Fixes for api:feat/qa · Snooze flaky checks" });
  expect(spawn.prompt).toMatch(/^Review api:feat\/qa "Snooze flaky checks" on MaxBook in `\/Users\/me\/src\/api`, from Code Review Workspace:\nYou're this review's main thread now: I'll send my comments here, each with an id and how to report on it\.\n\nStay on `feat\/qa`\.\n\nDon't push, open or update a PR, or change anything on GitHub unless I ask in this thread\.$/);
  expect((await f.store.getReview(f.key))!.mainThread).toMatchObject({ threadId: "fresh", origin: "fresh" });
  expect(f.calls("threads.send")).toHaveLength(0);
});

test("Send now sends one comment with an id, as its own Send", async () => {
  const h = host({ coder: { title: "Retry uploads", busy: true } });
  const store = await startPlugin(h.bb);
  await ownPr(store);
  const sent = await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 });
  expect(sent).toEqual({ ok: true, sent: { id: "c1", sendN: 1, threadId: "coder", title: "Retry uploads", delivery: "queued" } });
  const text: string = h.sends()[0].input[0].text;
  expect(text).toContain("c1 · `src/a.ts:3`");
  expect(text).not.toContain("Why change b?");
  expect(await comment(store, B2)).not.toHaveProperty("id");
  // A thread on GitHub the review hasn't read sends nothing.
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: { threadId: "t1" } })).toMatchObject({ ok: false, error: expect.stringContaining("on GitHub as the review last read it") });
  expect(h.sends()).toHaveLength(1);
});

test("Let it push when done leaves out Don't push, for the review or for one Send", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3, letPush: true });
  expect(await call(h.harness, "setLetPush", { targetKey: "pr-1", letPush: true })).toEqual({ ok: true });
  expect((await store.getReview("pr-1"))!.letPush).toBe(true);
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: B2 });
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: B2, letPush: false });
  expect(h.sends().map((send) => send.input[0].text.includes("Don't push until I say."))).toEqual([false, false, true]);
  expect(await call(h.harness, "setLetPush", { targetKey: "gone", letPush: true })).toMatchObject({ ok: false });
});

test("your message leads and the summary follows the comments, when you add them", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  await store.setVerdict("pr-1", "COMMENT", "  Mostly fine.  ");
  await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3], message: "  Do these first.  ", includeSummary: true });
  const text: string = h.sends()[0].input[0].text;
  expect(text.startsWith("Do these first.\n\nReview web#12")).toBe(true);
  expect(text).toContain("Name this better.\n\nMostly fine.\n\nDon't push until I say.");
});

test("someone else's PR warns, and sent anyway, their code is fenced as theirs and Submit's draft keeps the comment", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store, { ownPr: false });
  expect(await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3] })).toEqual({ ok: false, warning: "This is @alice’s PR, not yours. Your review on GitHub stays as it is.", offers: ["anyway"] });
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 })).toMatchObject({ ok: false, warning: expect.stringContaining("@alice’s PR"), offers: ["anyway"] });
  expect(h.sends()).toHaveLength(0);
  expect(await comment(store, A3)).not.toHaveProperty("id");
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3, force: true })).toMatchObject({ ok: true });
  expect(h.sends()[0].input[0].text).toContain("c1 · `src/a.ts:3`\n<untrusted source=\"@alice's code\">\n```diff\n+const c = 4;\n```\n</untrusted>\nName this better.");
  expect((await store.getDraft("pr-1")).comments).toHaveLength(2);
});

test("an archived main thread offers to unarchive it or start a fresh thread, and each does", async () => {
  const h = host({ coder: { title: "Retry uploads", archivedAt: 5 } });
  const store = await startPlugin(h.bb);
  await ownPr(store);
  expect(await call(h.harness, "getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: { threadId: "coder", title: "Retry uploads", state: "archived", machine: null } });
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 })).toEqual({ ok: false, warning: "Retry uploads is archived. Unarchive it and send, or start a fresh thread in the review’s project.", offers: ["unarchive", "fresh"], freshWhere: "in the review’s project" });
  expect(h.sends()).toHaveLength(0);
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3, force: true, thread: "unarchive" })).toMatchObject({ ok: true, sent: { threadId: "coder" } });
  expect(h.calls("threads.unarchive")).toEqual([{ threadId: "coder" }]);
  // Archived again, a fresh thread takes the Send and becomes the main thread.
  h.threads.coder!.archivedAt = 9;
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: B2, force: true, thread: "fresh" })).toMatchObject({ ok: true, sent: { threadId: "fresh", delivery: "sent" } });
  const [spawn] = h.spawns();
  expect(spawn).toMatchObject({ projectId: "p1", environment: { type: "project-default" }, title: "Fixes for web#12 · Retry uploads" });
  expect(spawn.prompt).toMatch(/^Review web#12 "Retry uploads", from Code Review Workspace:/);
  expect(spawn.prompt).toContain("c2 · `src/a.ts:2` (old line)");
  const review = (await store.getReview("pr-1"))!;
  expect(review.mainThread).toMatchObject({ threadId: "fresh", origin: "fresh" });
  expect(review.sourceThreadId).toBe("fresh");
});

/** A folder's review of env1 on MaxBook, at feat/qa, its main thread `main` there. */
async function folderReview(over: { threads?: Record<string, T>; removed?: boolean } = {}) {
  const BODY = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  const threads: Record<string, T> = { main: { title: "Snooze flaky checks", environmentId: "env1" }, other: { title: "Fix the docs", environmentId: "env1" }, away: { title: "Elsewhere", environmentId: "env9" }, ...over.threads };
  spawned.environmentId = "env_new";
  // The folder, and a new worktree a fresh thread works in, on its own branch made from feat/qa.
  const environments = { get: async ({ environmentId }: { environmentId: string }) => environmentId === "env_new"
    ? { id: "env_new", hostId: "host_max", path: "/Users/me/.bb/worktrees/api-fresh", status: "ready", isGitRepo: true, branchName: "bb/qa-fixes-thr_fresh", mergeBaseBranch: "feat/qa", baseBranch: null, defaultBranch: "main", projectId: "proj_api" }
    : { id: environmentId, hostId: "host_max", path: "/Users/me/src/api", status: "ready", isGitRepo: true, branchName: "feat/qa", mergeBaseBranch: null, baseBranch: null, defaultBranch: "main", projectId: "proj_api" } };
  const h = folderHost({ files: [{ path: "src/a.ts", body: BODY }, { path: ".env", origin: "untracked" }] }, { environments, threads: threadsSdk(threads), projects: {
    get: async () => ({ id: "proj_api", gitRemoteUrl: "git@github.com:acme/api.git" }), list: async () => [{ id: "proj_api", kind: "standard", gitRemoteUrl: "git@github.com:acme/api.git" }],
    defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low" }),
  } });
  const store = await startPlugin(h.bb);
  const key = featureKey("env1", "feat/qa");
  const patch = `diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${BODY}`;
  await store.saveReview({ targetKey: key, kind: "ref", gitRef: "feat/qa", title: "Snooze flaky checks", status: "ready", createdAt: 1, projectId: "proj_api" });
  await store.setLifecycle(key, {
    feature: { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/qa", baseRef: "main", repo: "acme/api", ...over.removed ? { folderGone: true } : {} },
    mainThread: { threadId: "main", environmentId: "env1", origin: "adopted", since: 1 }, sourceThreadId: "main",
  });
  await store.savePatch(key, patch);
  await store.saveSnapshotFiles(key, diffFilesHead(await store.patchHash(key)), { revisions: { "src/a.ts": "100644:8:100644:46" }, hidden: [{ path: ".env", reason: "secret" }] });
  await store.upsertDraftComment(key, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Say why TWO." });
  const calls = (method: string) => h.harness.inspection.sdk.callsTo(method).map((c) => c[0] as any);
  return { ...h, store, key, threads, calls, gitCalls: h.calls };
}
const AT = { file: "src/a.ts", line: 2, side: "RIGHT" as const };

test("a folder's Send names its machine, folder and branch, and keeps its revisions and hidden files as send:<n>:files, which Since your last Send reads", async () => {
  const f = await folderReview();
  expect(await f.harness.behavior.callRpc("getSourceThread", { targetKey: f.key })).toEqual({ thread: { threadId: "main", title: "Snooze flaky checks", state: "open", machine: "MaxBook" } });
  expect(await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT })).toMatchObject({ ok: true, sent: { id: "c1", sendN: 1, threadId: "main" } });
  const text: string = f.calls("threads.send")[0].input[0].text;
  expect(text).toMatch(/^Review api:feat\/qa "Snooze flaky checks" on MaxBook in `\/Users\/me\/src\/api`, from Code Review Workspace:\nFix these comments from my review of the changes on `feat\/qa` against `main`, uncommitted and new files included\.\nStay on `feat\/qa`\./);
  expect(await f.store.getSnapshotFiles(f.key, "send:1")).toEqual({ revisions: { "src/a.ts": "100644:8:100644:46" }, hidden: [{ path: ".env", reason: "secret" }] });
  // The review agent compares Send 1 with the folder now, which it can only with the Send's files.
  await f.store.setAssistantThread(f.key, "agent-1");
  const since = await f.harness.behavior.callAgentTool("read_changes_since_review", { send: 1 }, { threadId: "agent-1" });
  expect(toolFailed(since)).toBe(false);
  expect(toolText(since)).toContain("No changes since Send 1.");
});

test("a deleted main thread warns, and Send starts a fresh thread in the folder, which becomes the main thread", async () => {
  const f = await folderReview();
  delete f.threads.main;
  expect(await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT })).toEqual({ ok: false, warning: "The main thread was deleted. Send starts a fresh thread in ~/src/api.", offers: ["fresh"], freshWhere: "in ~/src/api" });
  expect(await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT, force: true, thread: "fresh" })).toMatchObject({ ok: true, sent: { threadId: "fresh" } });
  expect(f.calls("threads.spawn")[0]).toMatchObject({ projectId: "proj_api", environment: { type: "reuse", environmentId: "env1" }, title: "Fixes for api:feat/qa · Snooze flaky checks" });
  const review = (await f.store.getReview(f.key))!;
  expect(review.mainThread).toMatchObject({ threadId: "fresh", environmentId: "env1", origin: "fresh" });
  expect(review.implementers).toEqual([expect.objectContaining({ threadId: "main", origin: "adopted" })]);
});

test("a folder bb removed warns that its uncommitted work went with it; Send starts a fresh thread in a new worktree, told so, and the review reads that worktree from then on", async () => {
  const f = await folderReview({ removed: true });
  const warned = await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT });
  expect(warned).toEqual({ ok: false, warning: "BB removed the folder ~/src/api on MaxBook, and any uncommitted work in it. Send starts a fresh thread in a new worktree from feat/qa.", offers: ["fresh"], freshWhere: "in a new worktree from feat/qa" });
  expect(f.calls("threads.send")).toHaveLength(0);
  await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT, force: true, thread: "fresh" });
  const [spawn] = f.calls("threads.spawn");
  expect(spawn).toMatchObject({ environment: { type: "host", hostId: "host_max", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feat/qa" } } } });
  // Not the folder that's gone, nor to switch to feat/qa; and GitHub's limits, as Fix in a new thread has them.
  expect(spawn.prompt).toMatch(/^Review api:feat\/qa "Snooze flaky checks" on MaxBook, from Code Review Workspace:\nFix these comments from my review of the changes on `feat\/qa` against `main`, uncommitted and new files included\.\nYou're in a new worktree on a branch made from `feat\/qa`; commit there\.\n\n/);
  expect(spawn.prompt).not.toContain("~/src/api");
  expect(spawn.prompt).toContain("Don't push, open or update a PR, or change anything on GitHub unless I ask in this thread.\n\nReport each with");
  // The review now reads the new worktree, on its own branch; it still pushes to feat/qa, under the same key.
  const review = (await f.store.getReview(f.key))!;
  expect(review.feature).toMatchObject({ environmentId: "env_new", hostId: "host_max", path: "/Users/me/.bb/worktrees/api-fresh", branch: "feat/qa", workBranch: "bb/qa-fixes-thr_fresh", folderGone: false, baseRef: "main" });
  expect(review.mainThread).toMatchObject({ threadId: "fresh", environmentId: "env_new", origin: "fresh" });
  // So Update reads it, against the review's own base, not the branch the worktree was made from.
  expect(await f.harness.behavior.callRpc("updateFeature", { targetKey: f.key })).toEqual({ ok: true });
  expect(f.gitCalls.filter((call) => call.method === "files").at(-1)!.input).toMatchObject({ environmentId: "env_new", target: { type: "all", mergeBaseBranch: "main" } });
  // And the next Send goes to the fresh thread, as to any main thread.
  f.threads.fresh = { title: "Fixes for api:feat/qa", environmentId: "env_new" };
  expect(await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT })).toMatchObject({ ok: true, sent: { threadId: "fresh", sendN: 2 } });
});

test("a fresh thread whose worktree BB hasn't named yet is noted once it's read, and the review then reads it; deleted before, the next is from the branch too", async () => {
  const f = await folderReview({ removed: true });
  spawned.environmentId = null;
  await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT, force: true, thread: "fresh" });
  let review = (await f.store.getReview(f.key))!;
  expect(review.mainThread).toMatchObject({ threadId: "fresh", environmentId: null, origin: "fresh" });
  expect(review.feature).toMatchObject({ environmentId: "env1", folderGone: true });
  // Deleted before BB said: a gone folder's next fresh thread is from the branch again, in a new worktree.
  expect(await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT })).toMatchObject({ ok: false, offers: ["fresh"], freshWhere: "in a new worktree from feat/qa" });
  // BB names it: the page's read of the main thread notes it, and the review moves there.
  f.threads.fresh = { title: "Fixes for api:feat/qa", environmentId: "env_new" };
  expect(await f.harness.behavior.callRpc("getSourceThread", { targetKey: f.key })).toMatchObject({ thread: { threadId: "fresh", state: "open" } });
  review = (await f.store.getReview(f.key))!;
  expect(review.mainThread?.environmentId).toBe("env_new");
  expect(review.feature).toMatchObject({ environmentId: "env_new", workBranch: "bb/qa-fixes-thr_fresh", folderGone: false });
});

test("an approval starts no thread: with the main thread deleted or its folder removed, Send anyway only records it", async () => {
  const f = await folderReview();
  delete f.threads.main;
  const revision = await reviewRevision(f.store, f.key);
  const deleted = await f.harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: f.key, revision, force: undefined }) as any;
  // The open comment warns too; Send anyway answers both.
  expect(deleted).toMatchObject({ ok: false, offers: ["anyway"], warning: expect.stringContaining("The main thread was deleted, so no thread gets your approval. Send anyway records it.") });
  expect(await f.harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: f.key, revision, force: true })).toEqual({ ok: true, delivery: "sent", title: null, threadId: "main", recorded: true });
  expect([f.calls("threads.spawn"), f.calls("threads.send")]).toEqual([[], []]);
  expect((await f.store.getReview(f.key))!.approvalSent).toMatchObject({ threadId: "main", revision });
  const gone = await folderReview({ removed: true });
  expect(await gone.harness.behavior.callRpc("sendApprovalToSourceThread", { targetKey: gone.key, revision: await reviewRevision(gone.store, gone.key), force: true })).toMatchObject({ ok: true, recorded: true });
  expect(gone.calls("threads.spawn")).toEqual([]);
});

test("the Approved message names the review; unsent comments, or an approval already sent for this diff, warn first", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  const revision = await reviewRevision(store, "pr-1");
  expect(await call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision })).toEqual({ ok: false, warning: "Your draft has 2 comments you haven’t sent. Send them instead, or send Approved anyway?", offers: ["anyway"] });
  await call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3, B2] });
  // Sent, they no longer hold an approval back.
  expect(await call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision, message: "Ship it." })).toEqual({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder" });
  expect(h.sends()[1].input[0].text).toBe('Review web#12 "Retry uploads", from Code Review Workspace:\nApproved\n\nShip it.');
  expect(await call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision })).toEqual({ ok: false, warning: "You already told Retry uploads you approve this diff.", offers: ["anyway"] });
  expect(await call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision, force: true })).toMatchObject({ ok: true });
  expect(h.sends()).toHaveLength(3);
  // Comments sent after it supersede it.
  await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 });
  expect((await store.getReview("pr-1"))!.approvalSent).toBeNull();
});

test("an approval is for the diff the page shows: not one that changed since, nor while the guide rebuilds", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  for (const at of [A3, B2]) await store.deleteDraftComment("pr-1", at);
  const shown = await reviewRevision(store, "pr-1");
  // The main thread pushes again, so the review has a diff the page hasn't shown.
  await store.saveReview({ ...(await store.getReview("pr-1"))!, headSha: "fedcba9876543" });
  await expect(call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision: shown })).rejects.toThrow("This review changed in another window.");
  await store.saveReview({ ...(await store.getReview("pr-1"))!, status: "generating" });
  await expect(call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision: await reviewRevision(store, "pr-1") })).rejects.toThrow("The guide is rebuilding for new commits");
  expect(h.sends()).toHaveLength(0);
  await store.saveReview({ ...(await store.getReview("pr-1"))!, status: "ready" });
  const current = await reviewRevision(store, "pr-1");
  await call(h.harness, "sendApprovalToSourceThread", { targetKey: "pr-1", revision: current, includeSummary: true });
  expect((await store.getReview("pr-1"))!.approvalSent).toMatchObject({ threadId: "coder", title: "Retry uploads", revision: current });
});

test("a local review's approval names the review, its summary only when you add it", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1, projectId: "p1", cwd: "/repo" });
  await store.setLifecycle("ref-1", { sourceThreadId: "coder" });
  await store.savePatch("ref-1", PATCH);
  await store.setVerdict("ref-1", "APPROVE", "  No blocking issues.  ");
  const revision = await reviewRevision(store, "ref-1");
  await call(h.harness, "sendApprovalToSourceThread", { targetKey: "ref-1", revision });
  await call(h.harness, "sendApprovalToSourceThread", { targetKey: "ref-1", revision, includeSummary: true, force: true });
  expect(h.sends().map((send) => send.input[0].text)).toEqual(["Review repo:feature, from Code Review Workspace:\nApproved", "Review repo:feature, from Code Review Workspace:\nApproved\n\nNo blocking issues."]);
});

test("Change main thread takes a live thread in the folder and keeps the one before; it refuses archived threads, other folders and the plugin's own", async () => {
  const f = await folderReview({ threads: { old: { title: "Old", environmentId: "env1", archivedAt: 3 }, mine: { title: "Review agent", environmentId: "env1", originPluginId: "code-review-workspace", visibility: "hidden" }, fixer: { title: "Fixes for api:feat/qa", environmentId: "env1", originPluginId: "code-review-workspace" } } });
  const set = (threadId: string) => f.harness.behavior.callRpc("setMainThread", { targetKey: f.key, threadId }) as Promise<any>;
  expect(await set("old")).toEqual({ ok: false, error: "Old is archived. Unarchive it in BB first, or choose another." });
  expect(await set("away")).toEqual({ ok: false, error: "That thread works in another folder. Choose one working in ~/src/api." });
  expect(await set("mine")).toMatchObject({ ok: false, error: expect.stringContaining("Code Review Workspace’s agents") });
  await f.store.setAssistantThread(f.key, "other");
  expect(await set("other")).toMatchObject({ ok: false, error: expect.stringContaining("Code Review Workspace’s agents") });
  await f.store.clearAssistantThread(f.key);
  // A fix thread the plugin started is one you can send to.
  expect(await set("fixer")).toEqual({ ok: true });
  expect(await set("nope")).toEqual({ ok: false, error: "That thread was deleted. Choose another." });
  expect(await set("other")).toEqual({ ok: true });
  const review = (await f.store.getReview(f.key))!;
  expect(review.mainThread).toMatchObject({ threadId: "other", environmentId: "env1", origin: "adopted" });
  expect(review.sourceThreadId).toBe("other");
  expect(review.implementers?.map((thread) => thread.threadId)).toEqual(["main", "fixer"]);
  await f.harness.behavior.callRpc("sendNow", { targetKey: f.key, comment: AT });
  expect(f.calls("threads.send")[0].threadId).toBe("other");
});

test("with Send to thread off, nothing is offered or sent", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store);
  await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, sendToThread: false } }, (await store.getPreferences()).revision);
  expect(await call(h.harness, "getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: null });
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 })).toEqual({ ok: false, error: "Send to thread is off in Review settings." });
  expect(await call(h.harness, "setLetPush", { targetKey: "pr-1", letPush: true })).toEqual({ ok: false, error: "Send to thread is off in Review settings." });
  expect(await call(h.harness, "setMainThread", { targetKey: "pr-1", threadId: "coder" })).toEqual({ ok: false, error: "Send to thread is off in Review settings." });
  expect(await call(h.harness, "setMainThread", { targetKey: "pr-1", fresh: true })).toEqual({ ok: false, error: "Send to thread is off in Review settings." });
  expect(h.spawns()).toHaveLength(0);
  await expect(call(h.harness, "sendToSourceThread", { targetKey: "pr-1", comments: [A3] })).rejects.toThrow("Send to thread is off in Review settings.");
  expect(h.sends()).toHaveLength(0);
});

test("a review whose thread is the plugin's own agent, or with none, has no main thread to send to", async () => {
  const h = host();
  const store = await startPlugin(h.bb);
  await ownPr(store, { sourceThreadId: null });
  expect(await call(h.harness, "getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: null });
  expect(await call(h.harness, "sendNow", { targetKey: "pr-1", comment: A3 })).toMatchObject({ ok: false, error: expect.stringContaining("no main thread") });
  await store.setAssistantThread("pr-1", "coder");
  await store.setLifecycle("pr-1", { sourceThreadId: "coder" });
  expect(await call(h.harness, "getSourceThread", { targetKey: "pr-1" })).toEqual({ thread: null });
  expect(h.sends()).toHaveLength(0);
});

/** The loop registered on its own, its review agent's turns classified as `asking`. */
async function agentLoop(asking: Awaited<ReturnType<Classify>>["asking"], threads?: Record<string, T>) {
  const h = host(threads);
  const store = testStore(h.bb);
  const changed = vi.fn();
  const classify = vi.fn<Classify>(async () => ({ asking, message: { id: "creq_1", text: "fix it", at: 1, senderThreadId: asking === "relayed" ? "thr_orch" : null } }));
  register({ bb: h.bb, store, changed, classify } as unknown as ServeDeps);
  await ownPr(store);
  await store.setAssistantThread("pr-1", "agent-1");
  const tool = (input: Record<string, unknown>) => h.harness.behavior.callAgentTool("send_now", input, { threadId: "agent-1" });
  return { ...h, store, tool, classify, changed };
}

test("send_now from a turn the reviewer didn't start sends nothing", async () => {
  const a = await agentLoop("unattended");
  const out = await a.tool({ ...A3 });
  expect(toolFailed(out)).toBe(true);
  expect(toolText(out)).toContain("no one asked for it in this turn");
  expect(a.classify).toHaveBeenCalledWith("agent-1");
  expect(a.sends()).toHaveLength(0);
  expect(await comment(a.store, A3)).not.toHaveProperty("id");
});

test("send_now with the plugin's own reading of who's asking: an automatic turn sends nothing; your typed message sends", async () => {
  const chat = agentChat("agent");
  const threads = threadsSdk({ coder: { title: "Retry uploads" } });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    ...threads, events: chat.sdk.events, experimental_listAncestors: chat.sdk.experimental_listAncestors,
    get: async ({ threadId }: { threadId: string }) => threadId === "agent" ? { id: "agent", archivedAt: null, deletedAt: null, status: "idle", title: "Review agent: pr-1", environmentId: null } : threads.get({ threadId }),
    // The review agent's chat takes what's sent to it; the main thread, what a Send sends.
    send: async (args: any) => args.threadId === "agent" ? chat.sdk.send(args) : threads.send(args),
  } } as any });
  const store = await startPlugin(bb);
  await ownPr(store);
  await store.setAssistantThread("pr-1", "agent");
  const toMain = () => harness.inspection.sdk.callsTo("threads.send").map((c) => c[0] as any).filter((args) => args.threadId === "coder");
  // A turn the plugin started on its own, as for new commits.
  await sendToAgent(bb, { threadId: "agent", mode: "queue-if-active", input: [{ type: "text", text: "The author pushed new commits.", mentions: [] }] }, { kind: "automatic" });
  const automatic = await harness.behavior.callAgentTool("send_now", { ...A3 }, { threadId: "agent" });
  expect(toolFailed(automatic)).toBe(true);
  expect(toolText(automatic)).toContain("no one asked for it in this turn");
  expect(toMain()).toHaveLength(0);
  // You ask in the review's chat.
  chat.say("Have the main thread fix the name on line 3.");
  expect(toolText(await harness.behavior.callAgentTool("send_now", { ...A3 }, { threadId: "agent" }))).toContain("Sent as c1");
  expect(toMain()).toHaveLength(1);
  expect((await store.getReview("pr-1"))!.activity).toEqual([expect.objectContaining({ asking: "direct" })]);
});

test("send_now sends what the reviewer asked for, and with their patch, it rides that comment's Send, never a new draft comment", async () => {
  const a = await agentLoop("direct");
  const before = (await a.store.getDraft("pr-1")).comments.length;
  const out = await a.tool({ ...A3, patch: FIX });
  expect(toolFailed(out)).toBe(false);
  expect(toolText(out)).toBe("Sent as c1 in Send 1 to Retry uploads. It applies your patch as written. Tell the reviewer.");
  const text: string = a.sends()[0].input[0].text;
  expect(text).toContain("c1 · `src/a.ts:3`");
  expect(text).toContain("Apply its patch as written, with `git apply`, and change nothing else for it; if it doesn't apply cleanly, report c1 declined with why.");
  expect(text).toContain(`\`\`\`diff\n${FIX}\n\`\`\``);
  const review = (await a.store.getReview("pr-1"))!;
  expect(review.sends).toEqual([{ n: 1, at: expect.any(Number), threadId: "coder", ids: ["c1"], patch: FIX }]);
  expect((await a.store.getDraft("pr-1")).comments).toHaveLength(before);
  expect(review.activity).toEqual([{ at: expect.any(Number), text: "Sent c1 on src/a.ts:3 to Retry uploads, with a patch", asking: "direct" }]);
  // A patch that isn't a diff goes nowhere.
  const bad = await a.tool({ ...B2, patch: "just rename it" });
  expect(toolFailed(bad)).toBe(true);
  expect(a.sends()).toHaveLength(1);
});

test("send_now relayed from another of your threads sends, and logs which; with Settings' switch off it sends nothing", async () => {
  const a = await agentLoop("relayed");
  expect(toolText(await a.tool({ ...A3 }))).toContain("Sent as c1");
  expect((await a.store.getReview("pr-1"))!.activity).toEqual([expect.objectContaining({ asking: "relayed", from: "thr_orch" })]);
  await a.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, reviewAgentActs: false } }, (await a.store.getPreferences()).revision);
  const off = await a.tool({ ...B2 });
  expect(toolFailed(off)).toBe(true);
  expect(toolText(off)).toContain("only draft");
  expect(a.sends()).toHaveLength(1);
});

test("send_now passes a warning back for the reviewer to answer, and sends as they choose", async () => {
  const a = await agentLoop("direct", { coder: { title: "Retry uploads", archivedAt: 5 } });
  const warned = await a.tool({ ...A3 });
  expect(toolFailed(warned)).toBe(false);
  expect(toolText(warned)).toBe("Not sent yet. Retry uploads is archived. Unarchive it and send, or start a fresh thread in the review’s project. Tell the reviewer, and call send_now again only as they choose: force: true, thread: \"unarchive\", or force: true, thread: \"fresh\".");
  expect(a.sends()).toHaveLength(0);
  expect(toolText(await a.tool({ ...A3, force: true, thread: "unarchive" }))).toContain("Sent as c1");
});
