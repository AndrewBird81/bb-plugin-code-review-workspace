import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { formerWorkerReview } from "./former-workers";

interface ListedThread { id: string; title: string; originPluginId: string; archivedAt: number | null }
type ListArgs = { archived?: boolean; originPluginId?: string; limit?: number; offset?: number };

async function setup() {
  const answering = new Set<string>();
  // BB's thread list: unarchived threads unless archived is asked for, one page at a time.
  const listed: ListedThread[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    stop: async () => ({}), delete: async () => ({ ok: true }),
    list: async ({ archived = false, originPluginId, limit = 50, offset = 0 }: ListArgs = {}) => listed
      .filter((thread) => (thread.archivedAt !== null) === archived && (!originPluginId || thread.originPluginId === originPluginId))
      .slice(offset, offset + limit),
    get: async ({ threadId }: { threadId: string }) => ({ archivedAt: null, deletedAt: null, status: answering.has(threadId) ? "active" : "idle" }),
  } } });
  await plugin(bb);
  const store = createStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    store.saveReview({ targetKey: key, kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
    store.setAssistantThread(key, `assistant-${key}`);
    // A legacy conversation, from before conversations moved into bb threads.
    bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user','question',NULL,1)`).run(key);
    bb.storage.database().prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`).run(key, `worker-${key}`);
  }
  return { bb, harness, store, answering, listed };
}

test("archiving moves a review out of the queue until it is unarchived, keeping GitHub state", async () => {
  const { bb, harness, store } = await setup();
  store.setLifecycle("pr-1", { prState: "OPEN", archivedAt: null });
  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "pr-1", archived: true })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toMatchObject({ userArchivedAt: expect.any(Number), archivedAt: null, prState: "OPEN" });
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));
  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "pr-1", archived: false })).toEqual({ ok: true });
  expect(store.getReview("pr-1")?.userArchivedAt).toBeNull();

  expect(await harness.behavior.callRpc("archiveReview", { targetKey: "missing", archived: true })).toMatchObject({ ok: false });
  expect(bb.storage.database().prepare(`SELECT COUNT(*) AS n FROM review_lifecycle WHERE target_key='missing'`).get()).toEqual({ n: 0 });
});

test("pinning records when, unpinning clears it, and both tell open pages", async () => {
  const { harness, store } = await setup();
  expect(await harness.behavior.callRpc("pinReview", { targetKey: "pr-1", pinned: true })).toEqual({ ok: true });
  expect(store.getReview("pr-1")?.pinnedAt).toEqual(expect.any(Number));
  expect(store.getReview("pr-2")?.pinnedAt).toBeUndefined();
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));
  expect(await harness.behavior.callRpc("pinReview", { targetKey: "pr-1", pinned: false })).toEqual({ ok: true });
  expect(store.getReview("pr-1")?.pinnedAt).toBeNull();
  expect(await harness.behavior.callRpc("pinReview", { targetKey: "missing", pinned: true })).toMatchObject({ ok: false });
});

test("deleting a review removes its data, queued notification, and hidden worker, and nothing else", async () => {
  const { bb, harness, store } = await setup();
  await bb.storage.kv.set("needs-you:pending:pr-1", { targetKey: "pr-1" });
  await bb.storage.kv.set("needs-you:clock:pr-1", 5);
  await bb.storage.kv.set("needs-you:clock:pr-2", 5);

  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toBeNull();
  expect(store.listAgentMessages("pr-1")).toEqual([]);
  expect(store.getReview("pr-2")).not.toBeNull();
  expect(store.getAssistantThread("pr-2")).toBe("assistant-pr-2");
  expect(store.getAgentThread("pr-2")).toBe("worker-pr-2");
  expect(await bb.storage.kv.list("needs-you:")).toEqual(["needs-you:clock:pr-2"]);
  expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "assistant-pr-1" }], [{ threadId: "worker-pr-1" }]]);
  expect(harness.inspection.sdk.callsTo("threads.delete")).toEqual([[{ threadId: "assistant-pr-1", childThreadsConfirmed: false }], [{ threadId: "worker-pr-1", childThreadsConfirmed: false }]]);
  expect(harness.inspection.realtimeSignals.map((s) => s.channel)).toEqual(expect.arrayContaining(["reviews", "review:pr-1"]));

  // Repeating the delete (another window, double click) is harmless.
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(2);
});

// bug bash LIV-4: a page saving after another window deleted the review wrote rows Delete could no longer remove, and
// they came back when the PR was reviewed again.
test("a summary, verdict, viewed mark or reply draft saved after the review was deleted writes nothing", async () => {
  const { bb, harness, store } = await setup();
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  const rows = (table: string) => (bb.storage.database().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE target_key='pr-1'`).get() as { n: number }).n;
  await expect(harness.behavior.callRpc("saveSummary", { targetKey: "pr-1", body: "Old summary from the deleted review." })).rejects.toThrow("This review no longer exists.");
  await expect(harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", verdict: "REQUEST_CHANGES" })).rejects.toThrow("This review no longer exists.");
  expect(await harness.behavior.callRpc("setFilesViewed", { targetKey: "pr-1", files: ["a.ts"], viewed: false, previous: [{ file: "a.ts", hash: "h", viewedAt: 1 }] })).toEqual({ ok: false });
  expect(await harness.behavior.callRpc("setFileViewed", { targetKey: "pr-1", file: "a.ts", viewed: false })).toEqual({ ok: false });
  expect(await harness.behavior.callRpc("saveReplyDraft", { targetKey: "pr-1", threadId: "t1", body: "Thanks." })).toEqual({ ok: false });
  for (const table of ["drafts", "review_lifecycle", "file_views", "reply_drafts"]) expect(rows(table), table).toBe(0);
  // Started again, the review doesn't show the deleted one's summary and verdict.
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 2 });
  expect(store.getDraft("pr-1")).toMatchObject({ body: "", verdict: "COMMENT" });
  // The other review still saves.
  expect(await harness.behavior.callRpc("saveReplyDraft", { targetKey: "pr-2", threadId: "t1", body: "Thanks." })).toEqual({ ok: true });
});

test("a missing worker thread doesn't block deleting the review", async () => {
  const { harness, store } = await setup();
  harness.inspection.sdk.stub("threads.delete", async () => { throw new Error("HTTP 404: Thread not found"); });
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")).toBeNull();
  expect(harness.inspection.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
});

// A thread whose delete failed for another reason survived unrecorded, so it ran as an ordinary thread on any review
// (80-fixes, 70-review-correctness #2's second half).
test("a review thread that a delete leaves behind is kept to the deleted review; a missing or deleted one isn't recorded", async () => {
  const { bb, harness } = await setup();
  harness.inspection.sdk.stub("threads.delete", async ({ threadId }: { threadId: string }) => {
    if (threadId === "assistant-pr-1") throw new Error("HTTP 500: Internal error");
    if (threadId === "worker-pr-1") throw new Error("HTTP 404: Thread not found");
    return { ok: true };
  });
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect([await formerWorkerReview(bb, "assistant-pr-1"), await formerWorkerReview(bb, "worker-pr-1")]).toEqual(["pr-1", null]);
  expect(await harness.behavior.runCli(["summary", "pr-2", "--body", "injected"], { threadId: "assistant-pr-1", projectId: "p1" })).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("only its own review") });
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toEqual({ ok: true });
  expect([await formerWorkerReview(bb, "assistant-pr-2"), await formerWorkerReview(bb, "worker-pr-2")]).toEqual([null, null]);
});

test("a review can't be deleted while its guide is generating or an answer is in progress", async () => {
  const { harness, store, answering } = await setup();
  store.beginGeneration("pr-1");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toMatchObject({ ok: false, error: expect.stringContaining("generating") });
  expect(store.getReview("pr-1")).not.toBeNull();

  answering.add("assistant-pr-2");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toMatchObject({ ok: false, error: expect.stringContaining("assistant") });
  expect(store.getReview("pr-2")).not.toBeNull();
  answering.delete("assistant-pr-2");
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-2" })).toEqual({ ok: true });
  expect(harness.inspection.sdk.callsTo("threads.delete").map(([args]) => (args as any).threadId)).toEqual(["assistant-pr-2", "worker-pr-2"]);
});

test("deleting a review deletes its guide writers, the current one and older archived ones, and no one else's", async () => {
  const { harness, store, listed } = await setup();
  store.setGenerationWorker("pr-1", store.beginGeneration("pr-1"), "writer-now");
  store.saveReview({ ...store.getReview("pr-1")!, status: "ready" });
  const writer = (id: string, title: string, archivedAt: number | null = null, originPluginId = "code-review-workspace") => ({ id, title, originPluginId, archivedAt });
  // More of this plugin's threads than fit on one page.
  for (let i = 0; i < 450; i++) listed.push(writer(`other-${i}`, `Generate guide: pr-other-${i}`, i % 2 ? 1 : null));
  listed.push(writer("writer-now", "Generate guide: pr-1"), writer("writer-old", "Generate guide: pr-1", 5),
    writer("writer-pr-2", "Generate guide: pr-2"), writer("writer-pr-10", "Generate guide: pr-10", 5), writer("lookalike", "Generate guide: pr-1", null, "other-plugin"));
  expect(await harness.behavior.callRpc("deleteReview", { targetKey: "pr-1" })).toEqual({ ok: true });
  const deleted = harness.inspection.sdk.callsTo("threads.delete").map(([args]) => (args as { threadId: string }).threadId);
  expect(deleted.sort()).toEqual(["assistant-pr-1", "worker-pr-1", "writer-now", "writer-old"]);
  expect(harness.inspection.sdk.callsTo("threads.stop").map(([args]) => (args as { threadId: string }).threadId).sort()).toEqual(deleted);
  expect(harness.inspection.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
});
