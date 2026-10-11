import { expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { getConversation } from "./agent";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) }));

const at = { file: "a.ts", line: 3, side: "RIGHT" } as const;

/** A review waiting for its assistant: a discussion and a feedback check. */
function waiting(thread: Parameters<typeof makeThreadResponse>[0] | Error) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    get: async () => { if (thread instanceof Error) throw thread; return makeThreadResponse({ id: "assistant", ...thread }); },
    archive: async () => ({}),
    queuedMessages: { list: async () => [] },
  }, projects: { defaultExecutionOptions: async () => null } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1", projectId: "p1" });
  store.setAssistantThread("pr-1", "assistant");
  store.addDiscussionMessage("pr-1", at, "reviewer", "Why?");
  store.setLifecycle("pr-1", { verifyingSince: 1, verifyingHead: "sha1" });
  const stillWaiting = () => store.listDiscussions("pr-1")[0].waiting || !!store.getReview("pr-1")?.verifyingSince;
  return { bb, harness, store, stillWaiting };
}

test("at startup, a review waiting on an assistant that finished while the plugin was down stops waiting", async () => {
  for (const thread of [{ status: "idle" as const }, { status: "error" as const }, { status: "active" as const, archivedAt: 5 }, Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 })]) {
    const { bb, store, stillWaiting } = waiting(thread);
    await plugin(bb);
    await vi.waitFor(() => expect(stillWaiting()).toBe(false));
    expect(store.getReview("pr-1")).toMatchObject({ verifyingSince: null, verifyingHead: null, preparedAt: expect.any(Number) });
  }
});

test("at startup, a review whose assistant is still working, or has a message queued, keeps waiting", async () => {
  for (const thread of [{ status: "active" as const }, { status: "idle" as const, queuedMessageCount: 1 }]) {
    const { bb, store, stillWaiting } = waiting(thread);
    await plugin(bb);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stillWaiting()).toBe(true);
    expect(store.listDiscussions("pr-1")[0].waiting).toBe(true);
  }
});

test("a conversation found archived stops the waits for it", async () => {
  const { bb, store, stillWaiting } = waiting({ status: "idle", archivedAt: 5 });
  expect((await getConversation(bb, store, "pr-1")).threadId).toBeNull();
  expect(stillWaiting()).toBe(false);
  expect(store.getReview("pr-1")?.preparedAt).toEqual(expect.any(Number));
});

test("a new conversation ends a feedback check waiting on the old one", async () => {
  const { bb, harness, store, stillWaiting } = waiting({ status: "active" });
  await plugin(bb);
  await harness.behavior.callRpc("newConversation", { targetKey: "pr-1" });
  expect(stillWaiting()).toBe(false);
  expect(store.getReview("pr-1")).toMatchObject({ verifyingSince: null, verifyingHead: null });
});

test("a conversation found archived when the review opens moves the review's turn on, as its turn's end would", async () => {
  const thread: { status: "active" | "idle"; archivedAt?: number } = { status: "active" };
  const { bb, harness, store, stillWaiting } = waiting(thread);
  await plugin(bb);
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.setLifecycle("pr-1", { turnGroup: null });
  Object.assign(thread, { status: "idle", archivedAt: 5 });
  await harness.behavior.callRpc("getConversation", { targetKey: "pr-1" });
  expect(stillWaiting()).toBe(false);
  await vi.waitFor(() => expect(store.getReview("pr-1")?.turnGroup).toEqual(expect.any(String)));
});
