// The review agents' status in BB, read from their hidden threads, for the reviews' rows; and opening a review reads it.
import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
/** A thread as BB lists it, idle and read unless `extra` says otherwise. */
const listed = (id: string, extra: Record<string, unknown> = {}) => ({
  id, parentThreadId: null, status: "idle", runtime: { displayStatus: "idle" }, lastReadAt: 2, latestAttentionAt: 1, hasPendingInteraction: false, queuedWork: "none",
  activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 }, ...extra,
});

async function host(rows: Array<ReturnType<typeof listed>>, list = vi.fn(async ({ threadIds }: { threadIds: string[] }) => rows.filter((row) => threadIds.includes(row.id)))) {
  const markRead = vi.fn(async () => ({}));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { list, markRead } } as any });
  const store = await startPlugin(bb);
  for (const [targetKey, number] of [["pr-1", 1], ["pr-2", 2], ["pr-3", 3]] as const) {
    await store.saveReview({ targetKey, kind: "pr", number, repo: "acme/web", status: "ready", createdAt: number, headSha: `sha${number}` });
    await store.savePatch(targetKey, patch);
  }
  await store.setAssistantThread("pr-1", "thr-done");
  await store.setAssistantThread("pr-2", "thr-read");
  return { harness, store, list, markRead };
}

test("All reviews and a review's page carry its agent's status in BB, read from its hidden thread; none without an agent or a status", async () => {
  const { harness, list } = await host([listed("thr-done", { lastReadAt: 1, latestAttentionAt: 2 }), listed("thr-read")]);
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: Array<{ targetKey: string; agentStatus: unknown }> };
  expect(Object.fromEntries(reviews.map((review) => [review.targetKey, review.agentStatus]))).toEqual({ "pr-1": { indicator: "unread-success", unread: true }, "pr-2": null, "pr-3": null });
  // Hidden threads, which BB lists only when asked, in one read.
  expect(list).toHaveBeenCalledWith({ threadIds: ["thr-done", "thr-read"], includeHidden: true });
  const bundled = async (targetKey: string) => (await harness.behavior.callRpc("getReviewBundle", { targetKey }) as any).review.agentStatus;
  expect(await bundled("pr-1")).toEqual({ indicator: "unread-success", unread: true });
  expect(await bundled("pr-3")).toBeNull();
});

test("while BB can't list the agents, the reviews list without their status", async () => {
  const { harness } = await host([], vi.fn(async () => { throw new Error("BB is restarting"); }));
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: Array<{ agentStatus: unknown }> };
  expect(reviews.map((review) => review.agentStatus)).toEqual([null, null, null]);
});

test("a review agent's start, end, failure or question tells its review's rows and page; another thread's doesn't", async () => {
  const { harness } = await host([]);
  const told = () => harness.inspection.realtimeSignals.map((signal) => signal.channel).filter((channel) => channel === "reviews" || channel.startsWith("review:"));
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-someone" }), lastAssistantText: null });
  expect(told()).toEqual([]);
  await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr-done" }) });
  expect(told()).toEqual(["review:pr-1", "reviews"]);
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-done" }), lastAssistantText: null });
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr-read" }), error: null });
  expect(told()).toEqual(["review:pr-1", "reviews", "review:pr-1", "reviews", "review:pr-2", "reviews"]);
});

test("opening a review reads its agent's thread and tells its rows; a review without an agent has nothing to read", async () => {
  const { harness, markRead } = await host([]);
  expect(await harness.behavior.callRpc("readAgent", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(markRead).toHaveBeenCalledWith({ threadId: "thr-done" });
  expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual(expect.arrayContaining(["review:pr-1", "reviews"]));
  expect(await harness.behavior.callRpc("readAgent", { targetKey: "pr-3" })).toEqual({ ok: true });
  expect(markRead).toHaveBeenCalledTimes(1);
});
