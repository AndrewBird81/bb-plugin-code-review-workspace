import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { generateGuide, stopGuideGenerations } from "./generate";
import { toolFailed } from "./fake-host.test-support";
import { queueStore, type AsyncStore } from "./store-queue";

const guide = { title: "T", intent: "I", sections: [], unplacedFiles: [] };

test("failed regeneration does not mark an old guide ready", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { spawn: async () => { throw new Error("offline"); } } } });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  await store.saveGuide("target", guide);
  await generateGuide(bb, store, "target", "p1");
  expect(await store.getGuide("target")).toBeNull();
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("a superseded generation cannot replace a newer guide", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const old = await store.beginGeneration("target");
  const current = await store.beginGeneration("target");
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId: current, guide }))).toBeFalsy();
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId: old, guide: { ...guide, title: "Old result" } }))).toBe(true);
  expect((await store.getGuide("target"))?.title).toBe("T");
});

test("hidden workers are archived and stopped when waiting fails", async () => {
  const archive = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => { throw new Error("timeout"); }, archive, stop,
  } } });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  await generateGuide(bb, store, "target", "p1");
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("restart marks persisted in-progress reviews as interrupted without discarding drafts", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const old = await store.beginGeneration("target");
  await store.setVerdict("target", "COMMENT", "Keep this draft");
  await plugin(bb);
  expect((await store.getReview("target"))?.status).toBe("error");
  expect(await store.isCurrentGeneration("target", old)).toBe(false);
  expect((await store.getDraft("target")).body).toBe("Keep this draft");
});

test("disposal aborts a pending worker wait and releases the worker", async () => {
  const stop = vi.fn(async () => {});
  let waiting = false;
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }),
    wait: ({ signal }: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      waiting = true;
      if (!signal) return reject(new Error("the worker's wait has no abort signal"));
      signal.addEventListener("abort", () => resolve({ matched: false }), { once: true });
    }),
    archive: async () => {}, stop,
  } } });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  stopGuideGenerations(bb);
  await run;
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("a guide worker that fails ends its generation at once", async () => {
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  let waiting = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      waiting = true;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    queuedMessages: { list: async () => [] },
  } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "someone-else" }), error: null });
  expect((await store.getReview("target"))?.status).toBe("generating");
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "worker" }), error: "Provider crashed" });
  await run;
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("a guide worker still working when the wait times out is waited for longer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const waits: number[] = [];
  let store!: AsyncStore;
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    get: async () => ({ id: "worker", status: "active", archivedAt: null, deletedAt: null }),
    wait: async ({ timeoutMs }: { timeoutMs: number }) => {
      waits.push(timeoutMs);
      if (waits.length === 1) {
        vi.setSystemTime(Date.now() + timeoutMs);
        throw new Error("Timed out waiting for thread worker");
      }
      await store.saveGuide("target", guide);
      return { matched: true };
    },
  } } as any });
  store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  // A 50 KB diff gets five more minutes.
  await store.savePatch("target", "x".repeat(50_000));
  try {
    await generateGuide(bb, store, "target", "p1");
  } finally {
    vi.useRealTimers();
  }
  expect(waits).toEqual([600_000, 300_000]);
  expect((await store.getReview("target"))?.status).toBe("ready");
});

test("a wait that fails before its time ends the generation, even while the worker looks active", async () => {
  const wait = vi.fn(async () => { throw new Error("bb unreachable"); });
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}), wait,
    get: async () => ({ id: "worker", status: "active", archivedAt: null, deletedAt: null }),
  } } as any });
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  await generateGuide(bb, store, "target", "p1");
  expect(wait).toHaveBeenCalledTimes(1);
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("an accepted guide is ready at once, though its worker's turn goes on", async () => {
  const archive = vi.fn(async () => ({}));
  const stop = vi.fn(async () => ({}));
  let prompt = "";
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async (args: { prompt: string }) => { prompt = args.prompt; return { id: "worker" }; },
    // The worker never goes idle: it goes on to write a recap.
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    archive, stop,
  } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1", { notify: false });
  await vi.waitFor(() => expect(prompt).toContain("generationId"));
  const generationId = prompt.match(/generationId "([^"]+)"/)![1];
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId, guide }))).toBeFalsy();
  await run;
  expect((await store.getReview("target"))?.status).toBe("ready");
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
}, 5_000);

/** A worker that waits until its generation is aborted, with Needs You's deliveries recorded. */
function stoppableHost() {
  const archive = vi.fn(async () => ({}));
  const stop = vi.fn(async () => ({}));
  const delivered: unknown[] = [];
  let waiting = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive, stop,
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      waiting = true;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    queuedMessages: { list: async () => [] },
  }, plugins: { callRpc: async ({ method, input }: any) => {
    if (method === "activityCapabilities") return { version: 1 };
    delivered.push(input);
    return { accepted: true, id: "activity", duplicate: false, ok: true };
  } } } as any });
  return { bb, harness, archive, stop, delivered, waiting: () => waiting };
}

test("Stop mid-rebuild puts the previous guide back, ready, stops and archives the worker, and alerts no one", async () => {
  const { bb, harness, archive, stop, delivered, waiting } = stoppableHost();
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", gitRef: "main", status: "ready", createdAt: 1, projectId: "p1" });
  await store.savePatch("target", "old patch");
  await store.saveGuide("target", { ...guide, title: "Before" });
  await store.backupGuide("target");
  await store.savePatch("target", "new patch");
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting()).toBe(true));
  expect((await store.getReview("target"))?.status).toBe("generating");
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "target" })).toEqual({ ok: true, restored: true });
  await run;
  expect((await store.getReview("target"))?.status).toBe("ready");
  expect((await store.getGuide("target"))?.title).toBe("Before");
  expect(await store.patch("target")).toBe("old patch");
  expect((await store.getReview("target"))?.guideError).toBeNull();
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect(delivered).toEqual([]);
});

test("Stop on a first guide ends it with the error Stopped, and alerts no one", async () => {
  const { bb, harness, stop, delivered, waiting } = stoppableHost();
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", gitRef: "main", status: "generating", createdAt: 1, projectId: "p1" });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting()).toBe(true));
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "target" })).toEqual({ ok: true });
  await run;
  expect((await store.getReview("target"))?.status).toBe("error");
  expect((await store.getReview("target"))?.guideError).toMatchObject({ text: "Stopped" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect(delivered).toEqual([]);
});

test("Stop on a review with no guide building, or an unknown one, does nothing", async () => {
  const { bb, harness } = stoppableHost();
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "target" })).toEqual({ ok: true });
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "nope" })).toEqual({ ok: true });
  expect((await store.getReview("target"))?.status).toBe("ready");
});

// bug bash AGT-6: you press Stop on a first guide, and the writer, not stopped yet, submits its guide while the plugin
// archives it. The guide stood, ready, and Stop said the previous guide was put back.
test("a guide submitted after Stop is refused, and Stop doesn't say a guide was put back", async () => {
  let prompt = "";
  let waiting = false;
  let submit: () => Promise<unknown> = async () => {};
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async (args: { prompt: string }) => { prompt = args.prompt; return { id: "worker" }; },
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => { waiting = true; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
    // BB takes a moment to archive the hidden writer, which is still running.
    archive: async () => { await submit(); return {}; },
    stop: async () => ({}),
    queuedMessages: { list: async () => [] },
  } } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "target", kind: "ref", gitRef: "main", status: "generating", createdAt: 1, projectId: "p1" });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  const generationId = prompt.match(/generationId "([^"]+)"/)![1];
  let answer: any;
  submit = async () => { answer = await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId, guide }); };
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "target" })).toEqual({ ok: true });
  await run;
  expect(toolFailed(answer)).toBeTruthy();
  expect(await store.getGuide("target")).toBeNull();
  expect(await store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "Stopped" } });
});
