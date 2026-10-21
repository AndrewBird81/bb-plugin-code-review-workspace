import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { getConversation } from "./agent";
import { queueStore } from "./store-queue";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) }));

const at = { file: "a.ts", line: 3, side: "RIGHT" } as const;

/** A review waiting for its assistant: a discussion and a feedback check. */
async function waiting(thread: Parameters<typeof makeThreadResponse>[0] | Error) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => { if (thread instanceof Error) throw thread; return makeThreadResponse({ id: "assistant", ...thread }); },
    archive: async () => ({}),
    queuedMessages: { list: async () => [] },
  }, projects: { defaultExecutionOptions: async () => null } } as any });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  await store.setAssistantThread("pr-1", "assistant");
  await store.addDiscussionMessage("pr-1", at, "reviewer", "Why?");
  await store.setLifecycle("pr-1", { verifyingSince: 1, verifyingHead: "sha1" });
  const stillWaiting = async () => (await store.listDiscussions("pr-1"))[0].waiting || !!(await store.getReview("pr-1"))?.verifyingSince;
  return { bb, harness, store, stillWaiting };
}

test("at startup, a review waiting on an assistant that finished while the plugin was down stops waiting", async () => {
  for (const thread of [{ status: "idle" as const }, { status: "error" as const }, { status: "active" as const, archivedAt: 5 }, Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 })]) {
    const { bb, store, stillWaiting } = await waiting(thread);
    await plugin(bb);
    await vi.waitFor(async () => expect(await stillWaiting()).toBe(false));
    expect(await store.getReview("pr-1")).toMatchObject({ verifyingSince: null, verifyingHead: null, preparedAt: expect.any(Number) });
  }
});

test("at startup, a review whose assistant is still working, or has a message queued, keeps waiting", async () => {
  for (const thread of [{ status: "active" as const }, { status: "idle" as const, queuedMessageCount: 1 }]) {
    const { bb, store, stillWaiting } = await waiting(thread);
    await plugin(bb);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await stillWaiting()).toBe(true);
    expect((await store.listDiscussions("pr-1"))[0].waiting).toBe(true);
  }
});

test("at startup, a check whose message left the queue while the plugin was down ends with the turn under way", async () => {
  const { bb, harness, store } = await waiting({ status: "active" });
  await store.setLifecycle("pr-1", { verifyingMessageId: "q-check" });
  await plugin(bb);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.verifyingMessageId).toBeNull());
  expect((await store.getReview("pr-1"))?.verifyingSince).toBe(1);
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "assistant" }), lastAssistantText: null });
  expect(await store.getReview("pr-1")).toMatchObject({ verifyingSince: null, verifyingHead: null });
});

test("at startup, a check still in the queue keeps waiting for its turn", async () => {
  const { bb, harness, store } = await waiting({ status: "active" });
  await store.setLifecycle("pr-1", { verifyingMessageId: "q-check" });
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => [{ id: "q-check" }]);
  await plugin(bb);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await store.getReview("pr-1"))?.verifyingMessageId).toBe("q-check");
});

test("a conversation found archived stops the waits for it", async () => {
  const { bb, store, stillWaiting } = await waiting({ status: "idle", archivedAt: 5 });
  expect((await getConversation(bb, store, "pr-1")).threadId).toBeNull();
  expect(await stillWaiting()).toBe(false);
  expect((await store.getReview("pr-1"))?.preparedAt).toEqual(expect.any(Number));
});

test("a new conversation ends a feedback check waiting on the old one", async () => {
  const { bb, harness, store, stillWaiting } = await waiting({ status: "active" });
  await plugin(bb);
  await harness.behavior.callRpc("newConversation", { targetKey: "pr-1" });
  expect(await stillWaiting()).toBe(false);
  expect(await store.getReview("pr-1")).toMatchObject({ verifyingSince: null, verifyingHead: null });
});

test("a conversation found archived when the review opens moves the review's turn on, as its turn's end would", async () => {
  const thread: { status: "active" | "idle"; archivedAt?: number } = { status: "active" };
  const { bb, harness, store, stillWaiting } = await waiting(thread);
  await plugin(bb);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.setLifecycle("pr-1", { turnGroup: null });
  Object.assign(thread, { status: "idle", archivedAt: 5 });
  await harness.behavior.callRpc("getConversation", { targetKey: "pr-1" });
  expect(await stillWaiting()).toBe(false);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.turnGroup).toEqual(expect.any(String)));
});
