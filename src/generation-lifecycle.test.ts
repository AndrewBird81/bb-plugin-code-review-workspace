import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { generateGuide, stopGuideGenerations } from "./generate";
import { spawnPrompt, toolFailed } from "./fake-host.test-support";
import type { AsyncStore } from "./store-queue";
import { testStore } from "./test-store.test-support";

const guide = { title: "T", intent: "I", sections: [], unplacedFiles: [] };

test("failed regeneration does not mark an old guide ready", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { spawn: async () => { throw new Error("offline"); } } } });
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  await store.saveGuide("target", guide);
  await generateGuide(bb, store, "target", "p1");
  expect(await store.getGuide("target")).toBeNull();
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("a superseded generation cannot replace a newer guide", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
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
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", status: "generating", createdAt: 1 });
  await generateGuide(bb, store, "target", "p1");
  expect(archive).toHaveBeenCalledWith({ threadId: "worker" });
  expect(stop).toHaveBeenCalledWith({ threadId: "worker" });
  expect((await store.getReview("target"))?.status).toBe("error");
});

test("restart marks persisted in-progress reviews as interrupted without discarding drafts", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "someone-else" }), error: null });
  expect((await store.getReview("target"))?.status).toBe("generating");
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "worker" }), error: "Provider crashed" });
  await run;
  expect((await store.getReview("target"))?.status).toBe("error");
});

// bug bash E1: the wait rejected with its signal's reason, as BB's does, and that AbortError was what the reviewer read.
test("a guide worker whose thread fails says the writer failed, and BB's why, not that an operation was aborted", async () => {
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  let waiting = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "worker" }), archive: async () => ({}), stop: async () => ({}),
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      waiting = true;
      signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    }),
    queuedMessages: { list: async () => [] },
  } } as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting).toBe(true));
  await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "worker" }), error: "Failed to launch ACP agent \"opencode\": spawn opencode ENOENT" });
  await run;
  expect(await store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "The guide writer failed: Failed to launch ACP agent \"opencode\": spawn opencode ENOENT." } });
  expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: expect.stringContaining("the guide writer failed: Failed to launch ACP agent") });
});

/**
 * A guide writer waiting on its turn, whose asks interaction.pending raises: declined through `resolve`. `pending` is what
 * BB lists as already asked; `onSpawn` runs as BB starts the writer, before its spawn returns.
 */
async function askingWriter(resolve: (args: unknown) => Promise<unknown>, options: { pending?: unknown[]; onSpawn?: (ask: Ask) => Promise<void> } = {}) {
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  let waiting = false;
  let generationId = "";
  const ask: Ask = (threadId, payload, id = `ask-${threadId}`) => harness.behavior.emitThreadEvent("interaction.pending", {
    thread: makeThreadResponse({ id: threadId }),
    interaction: { id, threadId, status: "pending", createdAt: 1, payload } as any,
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async (args: unknown) => {
      generationId = spawnPrompt(args).match(/generationId "([^"]+)"/)![1];
      await options.onSpawn?.(ask);
      return { id: "worker" };
    },
    archive: async () => ({}), stop: async () => ({}),
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      waiting = true;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    queuedMessages: { list: async () => [] },
    interactions: { resolve, list: async () => options.pending ?? [] },
  } } as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", status: "ready", createdAt: 1 });
  const run = generateGuide(bb, store, "target", "p1");
  return { bb, store, run, ask, harness, generationId: () => generationId, waiting: () => vi.waitFor(() => expect(waiting).toBe(true)) };
}
type Ask = (threadId: string, payload: unknown, id?: string) => Promise<unknown>;
const command = { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: "List files in last patch page", subject: { kind: "command", command: "F=/tmp/page.txt; grep -n '^diff --git' $F", cwd: null, itemId: "i1", actions: [], sessionGrant: null } };

test("a guide writer's approval is declined at once, and its guide goes on", async () => {
  const resolve = vi.fn(async () => ({}));
  const { bb, store, run, ask, harness, waiting } = await askingWriter(resolve);
  await waiting();
  await ask("someone-else", command);
  expect(resolve).not.toHaveBeenCalled();
  await ask("worker", command);
  expect(resolve).toHaveBeenCalledWith({ threadId: "worker", interactionId: "ask-worker", resolution: { decision: "deny" } });
  expect((await store.getReview("target"))?.status).toBe("generating");
  expect(harness.inspection.logEntries).toContainEqual({ level: "info", message: expect.stringContaining("Declined the guide writer worker's ask for approval to run `F=/tmp/page.txt; grep -n '^diff --git' $F`") });
  // Still waiting on the writer: only a reload's stop ends it here.
  stopGuideGenerations(bb);
  await run;
});

test("a guide writer's ask no one can answer, or an approval BB couldn't decline, fails its guide at once, saying what it asked", async () => {
  const question = { kind: "user_question", questions: [{ id: "q", prompt: "Which chapter?", allowFreeText: true, multiSelect: false, required: true }] };
  const asked = await askingWriter(async () => ({}));
  await asked.waiting();
  await asked.ask("worker", question);
  await asked.run;
  expect(await asked.store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "The guide writer failed: it asked a question, and a hidden writer's asks reach no one." } });

  const refused = await askingWriter(async () => { throw new Error("interaction is no longer pending"); });
  await refused.waiting();
  await refused.ask("worker", command);
  await refused.run;
  expect(await refused.store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "The guide writer failed: it asked for approval to run `F=/tmp/page.txt; grep -n '^diff --git' $F`, and declining it failed (interaction is no longer pending); a hidden writer's asks reach no one." } });
});

const question = { kind: "user_question", questions: [{ id: "q", prompt: "Which chapter?", allowFreeText: true, multiSelect: false, required: true }] };
const pendingAsk = (id: string, payload: unknown) => ({ id, threadId: "worker", status: "pending", createdAt: 1, payload });

test("an approval the writer asked as BB started it, before its spawn returned, is declined once, though BB both lists it and tells of it", async () => {
  const resolve = vi.fn(async () => ({}));
  // BB told of it before the writer's id was known, and lists it once it is; it may tell of it again after.
  const { bb, run, ask, waiting } = await askingWriter(resolve, { pending: [pendingAsk("early", command)], onSpawn: async (ask) => { await ask("worker", command, "early"); } });
  await waiting();
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ threadId: "worker", interactionId: "early", resolution: { decision: "deny" } }));
  await ask("worker", command, "early");
  expect(resolve).toHaveBeenCalledTimes(1);
  stopGuideGenerations(bb);
  await run;
});

test("a question the writer asked as BB started it, or while its id was recorded, fails its guide at once", async () => {
  const listed = await askingWriter(async () => ({}), { pending: [pendingAsk("early", question)] });
  await listed.run;
  expect(await listed.store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "The guide writer failed: it asked a question, and a hidden writer's asks reach no one." } });

  // Asked while the store records the writer as its generation's.
  let recording = false;
  const during = await askingWriter(async () => ({}), { onSpawn: async () => { recording = true; } });
  const exclusive = during.store.exclusive.bind(during.store);
  vi.spyOn(during.store, "exclusive").mockImplementation(async (fn: any) => {
    if (recording) { recording = false; await during.ask("worker", question); }
    return exclusive(fn);
  });
  await during.run;
  expect(await during.store.getReview("target")).toMatchObject({ status: "error", guideError: { text: "The guide writer failed: it asked a question, and a hidden writer's asks reach no one." } });
});

test("a writer whose guide was rejected and then asks a question, or for an approval BB can't decline, says what it asked first, then the rejection", async () => {
  const { guideRejected } = await import("./generate");
  for (const [payload, said] of [
    [question, "it asked a question, and a hidden writer's asks reach no one"],
    [{ ...command, availableDecisions: ["allow_once"] }, "it asked for approval to run `F=/tmp/page.txt; grep -n '^diff --git' $F`, and a hidden writer's asks reach no one"],
  ] as const) {
    const writer = await askingWriter(async () => ({}));
    await writer.waiting();
    guideRejected(writer.bb, writer.generationId(), "Coverage errors: missing a.ts");
    await writer.ask("worker", payload);
    await writer.run;
    expect((await writer.store.getReview("target"))?.guideError?.text).toBe(`The guide writer failed: ${said}.\nIts last guide wasn't accepted:\nCoverage errors: missing a.ts`);
  }
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
  store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
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
  const store = testStore(bb);
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

// A folder's review after an Update, as src/feature-review.ts keeps it.
const folder = { environmentId: "env1", hostId: "h1", machine: "MaxBook", path: "/w", branch: "feat", baseRef: "main", repo: null, guideOlderThanDiff: "update" as const };

test("a folder's guide older than its diff stays said so until a new guide is accepted, through a stopped rewrite", async () => {
  const { bb, harness, waiting } = stoppableHost();
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", gitRef: "feat", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("target", { feature: folder });
  await store.saveGuide("target", { ...guide, title: "Before" });
  await store.savePatch("target", "updated patch");
  await store.backupGuide("target");
  const run = generateGuide(bb, store, "target", "p1");
  await vi.waitFor(() => expect(waiting()).toBe(true));
  // Stopped: the guide you had is back over the newer diff, and still says it's older.
  expect(await harness.behavior.callRpc("stopGuide", { targetKey: "target" })).toEqual({ ok: true, restored: true });
  await run;
  expect((await store.getGuide("target"))?.title).toBe("Before");
  expect((await store.getReview("target"))?.feature?.guideOlderThanDiff).toBe("update");
});

test("a folder's guide accepted for its diff is no longer older than it", async () => {
  let prompt = "";
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async (args: { prompt: string }) => { prompt = args.prompt; return { id: "worker" }; },
    wait: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    archive: async () => ({}), stop: async () => ({}),
  } } as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "target", kind: "ref", gitRef: "feat", status: "ready", createdAt: 1 });
  await store.setLifecycle("target", { feature: folder });
  const run = generateGuide(bb, store, "target", "p1", { notify: false });
  await vi.waitFor(() => expect(prompt).toContain("generationId"));
  const generationId = prompt.match(/generationId "([^"]+)"/)![1];
  // While it's written, the flag stands: the notice hides on its own, and a stop would need it.
  expect((await store.getReview("target"))?.feature?.guideOlderThanDiff).toBe("update");
  expect(toolFailed(await harness.behavior.callAgentTool("generate_review_guide", { targetKey: "target", generationId, guide }))).toBeFalsy();
  await run;
  expect((await store.getReview("target"))?.feature?.guideOlderThanDiff).toBeNull();
}, 5_000);
