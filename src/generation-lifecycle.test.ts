import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { generateGuide, stopGuideGenerations } from "./generate";
import { toolFailed } from "./fake-host.test-support";

const guide = { title: "T", intent: "I", sections: [], unplacedFiles: [] };

test("failed regeneration does not mark an old guide ready", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { spawn: async () => { throw new Error("offline"); } } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  store.saveGuide("target", guide);
  await generateGuide(bb, store, "target", "p1");
  expect(store.getGuide("target")).toBeNull();
  expect(store.getReview("target")?.status).toBe("error");
});

test("a superseded generation cannot replace a newer guide", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const old = store.beginGeneration("target");
  const current = store.beginGeneration("target");
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId: current, guide }))).toBeFalsy();
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId: old, guide: { ...guide, title: "Old result" } }))).toBe(true);
  expect(store.getGuide("target")?.title).toBe("T");
});

test("hidden workers are archived and stopped when waiting fails", async () => {
  const archive = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), wait: async () => { throw new Error("timeout"); }, archive, stop,
  } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  await generateGuide(bb, store, "target", "p1");
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect(store.getReview("target")?.status).toBe("error");
});

test("restart marks persisted in-progress reviews as interrupted without discarding drafts", async () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const old = store.beginGeneration("target");
  store.setVerdict("target", "COMMENT", "Keep this draft");
  await plugin(bb);
  expect(store.getReview("target")?.status).toBe("error");
  expect(store.isCurrentGeneration("target", old)).toBe(false);
  expect(store.getDraft("target").body).toBe("Keep this draft");
});

test("disposal aborts a pending worker wait and releases the worker", async () => {
  const stop = vi.fn(async () => {});
  let waiting = false;
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }),
    wait: ({ signal }: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      waiting = true;
      if (!signal) return reject(new Error("the worker's wait has no abort signal"));
      signal.addEventListener("abort", () => resolve({ matched: false }), { once: true });
    }),
    archive: async () => {}, stop,
  } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  stopGuideGenerations(bb);
  await run;
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect(store.getReview("target")?.status).toBe("error");
});

test("a guide worker that fails ends its generation at once", async () => {
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  let waiting = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      waiting = true;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    queuedMessages: { list: async () => [] },
  } } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "someone-else" }), error: null });
  expect(store.getReview("target")?.status).toBe("generating");
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "worker" }), error: "Provider crashed" });
  await run;
  expect(store.getReview("target")?.status).toBe("error");
});

test("a guide worker still working when the wait times out is waited for longer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const waits: number[] = [];
  let store!: ReturnType<typeof createStore>;
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    get: async () => ({ id: "worker", status: "active", archivedAt: null, deletedAt: null }),
    wait: async ({ timeoutMs }: { timeoutMs: number }) => {
      waits.push(timeoutMs);
      if (waits.length === 1) {
        vi.setSystemTime(Date.now() + timeoutMs);
        throw new Error("Timed out waiting for thread worker");
      }
      store.saveGuide("target", guide);
      return { matched: true };
    },
  } } as any });
  store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  // A 50 KB diff gets five more minutes.
  store.savePatch("target", "x".repeat(50_000));
  try {
    await generateGuide(bb, store, "target", "p1");
  } finally {
    vi.useRealTimers();
  }
  expect(waits).toEqual([600_000, 300_000]);
  expect(store.getReview("target")?.status).toBe("ready");
});

test("a wait that fails before its time ends the generation, even while the worker looks active", async () => {
  const wait = vi.fn(async () => { throw new Error("bb unreachable"); });
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}), wait,
    get: async () => ({ id: "worker", status: "active", archivedAt: null, deletedAt: null }),
  } } as any });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  await generateGuide(bb, store, "target", "p1");
  expect(wait).toHaveBeenCalledTimes(1);
  expect(store.getReview("target")?.status).toBe("error");
});

test("an accepted guide is ready at once, though its worker's turn goes on", async () => {
  const archive = vi.fn(async () => ({}));
  const stop = vi.fn(async () => ({}));
  let prompt = "";
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async (args: { prompt: string }) => { prompt = args.prompt; return { id: "worker" }; },
    // The worker never goes idle: it goes on to write a recap.
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    archive, stop,
  } } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1", { notify: false });
  await vi.waitFor(() => expect(prompt).toContain("generationId"));
  const generationId = prompt.match(/generationId "([^"]+)"/)![1];
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId, guide }))).toBeFalsy();
  await run;
  expect(store.getReview("target")?.status).toBe("ready");
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
}, 5_000);
