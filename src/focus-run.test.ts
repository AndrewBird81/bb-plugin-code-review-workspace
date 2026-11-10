import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { testStore } from "./test-store.test-support";
import { defaultPreferences } from "./preferences";
import { startFocusRun, stopFocusRun, recoverFocusRuns, focusEvents, recordFocusTools, focusReported, focusRuntimeSpawned } from "./focus-run";
import type { FocusRun } from "./focus-model";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.useRealTimers(); });
const run = (overrides: Partial<FocusRun> = {}): FocusRun => ({ id: "run", head: "head", startedAt: 1, state: "merging", focuses: [{ focusId: "docs", label: "Docs", state: "done", queuedAt: 1 }], ...overrides });
async function setup(on = true) {
  let number = 0;
  const statuses = new Map<string, string>([["assistant", "active"]]);
  const queued: any[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      spawn: async () => { const id = `focus-${++number}`; statuses.set(id, "active"); return { id }; },
      get: async ({ threadId }: any) => makeThreadResponse({ id: threadId, status: (statuses.get(threadId) ?? "idle") as any }),
      wait: async ({ timeoutMs, signal }: any) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }),
      stop: async ({ threadId }: any) => { statuses.set(threadId, "idle"); return { ok: true }; },
      archive: async () => ({ ok: true }), delete: async () => ({ ok: true }),
      list: async () => [],
      interactions: { list: async () => [] },
      queuedMessages: { list: async () => queued, delete: async () => ({ ok: true }) },
      events: { list: async () => [] },
      send: async () => ({ delivery: "queued", queuedMessage: makeQueueEntry({ id: "merge", threadId: "assistant" }) }),
    },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex" }) },
    providers: { list: async () => [{ id: "codex", capabilities: { permissionModes: ["auto"] } }] },
  } });
  const store = testStore(bb);
  await store.savePreferences({ ...defaultPreferences, focuses: { ...defaultPreferences.focuses, enabled: on } }, 0);
  await store.saveReview({ targetKey: "r", kind: "pr", headSha: "head", ownPr: true, status: "ready", createdAt: 1, projectId: "p" });
  await store.setLifecycle("r", { ownPr: true });
  await store.setAssistantThread("r", "assistant");
  disposers.push(() => harness.lifecycle.dispose());
  return { bb, harness, store, statuses, queued };
}
async function stage(s: Awaited<ReturnType<typeof setup>>, count = 1, runId = "run") {
  for (let n = 0; n < count; n++) await s.store.saveFocusFinding({ targetKey: "r", runId, id: String(n).padStart(2, "0"), focusId: "docs", label: "Docs", file: "a.ts", line: n + 1, side: "RIGHT", severity: n < 5 ? "nit" : "blocking", body: "wrong", evidence: "a.ts:1", status: "found" });
}

test("off starts nothing; new listeners make no SDK calls or store writes", async () => {
  const s = await setup(false);
  const set = vi.spyOn(s.store, "setLifecycle");
  const before = s.harness.inspection.sdk.calls.length;
  await startFocusRun(s.bb, s.store, "r");
  const events = focusEvents(s.bb, s.store);
  for (const event of ["thread.idle", "thread.active", "thread.failed", "message.dispatched", "message.cancelled"] as const) {
    for (const handle of events[event] ?? []) await (handle as any)({ thread: makeThreadResponse({ id: "assistant" }), entry: makeQueueEntry({ threadId: "assistant" }) });
  }
  expect(set).not.toHaveBeenCalled();
  expect(s.harness.inspection.sdk.calls.length).toBe(before);
});

test("one hidden Docs spawn, provider's mode, fenced prompt; Stop aborts the wait and preserves identities", async () => {
  const s = await setup();
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  const spawn = s.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as any;
  expect(spawn).toMatchObject({ visibility: "hidden", title: "Focus: Docs · r", permissionMode: "auto", pluginMetadata: { focusId: "docs" } });
  expect(spawn.prompt).toContain("untrusted");
  await stopFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.delete")).toHaveLength(1));
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("stopped");
  expect(await s.store.listFocusThreads()).toHaveLength(1);
});

test("FIFO caps running focuses at two plugin-wide; plugin queue has no start deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const s = await setup();
  for (const key of ["r", "s", "t"]) {
    if (key !== "r") await s.store.saveReview({ targetKey: key, kind: "pr", headSha: "head", ownPr: true, status: "ready", createdAt: 1, projectId: "p" });
    await s.store.savePatch(key, "x".repeat(200_000));
    await s.store.setLifecycle(key, { ownPr: true });
    await startFocusRun(s.bb, s.store, key);
  }
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect((await s.store.getReview("t"))?.focusRun?.focuses[0]).toMatchObject({ state: "queued" });
  await stopFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3));
  await stopFocusRun(s.bb, s.store, "s");
  await stopFocusRun(s.bb, s.store, "t");
});

test("pending at 15 minutes fails didn't start, frees slot and stops/archives; active at 14 minutes gets a fresh run cap", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const s = await setup();
  s.harness.sdk.stub("threads.spawn", async () => { s.statuses.set("pending", "pending"); return { id: "pending" }; });
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect((await s.store.getReview("r"))?.focusRun?.focuses[0].state).toBe("running");
  s.statuses.set("pending", "active");
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.focuses[0].activeAt).toBeDefined());
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect((await s.store.getReview("r"))?.focusRun?.focuses[0].state).toBe("running");
  await stopFocusRun(s.bb, s.store, "r");
  s.harness.sdk.stub("threads.spawn", async () => { s.statuses.set("pending-2", "pending"); return { id: "pending-2" }; });
  const waits = s.harness.inspection.sdk.callsTo("threads.wait").length;
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.wait").length).toBeGreaterThan(waits));
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.focuses[0]).toMatchObject({ state: "failed", error: "didn't start" }));
  expect(s.harness.inspection.sdk.callsTo("threads.archive").length).toBeGreaterThan(0);
});

test.each(["permission", "idle", "timeout"])("%s fails without blocking merge; idle gets one nudge", async (why) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const s = await setup();
  if (why === "permission") s.harness.sdk.stub("threads.interactions.list", async () => [{ id: "permission" }]);
  if (why === "idle") s.harness.sdk.stub("threads.wait", async () => ({}));
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.interactions.list").length).toBeGreaterThan(0));
  if (why === "timeout") await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1));
  if (why === "timeout") await vi.advanceTimersByTimeAsync(10 * 60_000);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.focuses[0]).toMatchObject({ state: "failed", error: why === "permission" ? "asked for permission" : why === "idle" ? "stopped without reporting" : "timed out" }));
});

test("restart stops finding runs and sweeps hidden plugin orphans; interrupted findings fail closed", async () => {
  const s = await setup();
  await s.store.setLifecycle("r", { focusRun: run({ state: "finding" }) });
  await stage(s);
  s.harness.sdk.stub("threads.list", async ({ archived }: any) => archived ? [] : [makeThreadResponse({ id: "orphan", title: "Focus: Docs · r", visibility: "hidden", originPluginId: s.bb.pluginId })]);
  await recoverFocusRuns(s.bb, s.store);
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("stopped");
  expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "not-checked", reason: "interrupted" });
  expect(s.harness.inspection.sdk.callsTo("threads.stop").some((call) => (call[0] as any).threadId === "orphan")).toBe(true);
});

test.each(["absent", "cancelled", "queued", "dispatched"])("restart merging with %s evidence never sends a new merge", async (evidence) => {
  const s = await setup();
  s.statuses.set("assistant", "idle");
  await s.store.setLifecycle("r", { focusRun: run({ mergeMessageId: "merge", ...(evidence === "cancelled" ? { mergeCancelledAt: 1 } : evidence === "dispatched" ? { mergeDispatchedAt: 1 } : {}) }) });
  await stage(s);
  if (evidence === "queued") s.queued.push(makeQueueEntry({ id: "merge", threadId: "assistant" }));
  await recoverFocusRuns(s.bb, s.store);
  const current = (await s.store.getReview("r"))!.focusRun!;
  if (evidence === "queued") expect(current.state).toBe("merging");
  else if (evidence === "dispatched") expect(current.nudged).toBe(true);
  else expect((await s.store.focusFindings("r", "run"))[0]).toMatchObject({ status: "not-checked", reason: evidence === "cancelled" ? "merge message removed" : "interrupted" });
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(evidence === "dispatched" ? 1 : 0);
});

test("Stop deletes a queued merge, but refuses a dispatched merge", async () => {
  const s = await setup();
  await stage(s);
  await s.store.setLifecycle("r", { focusRun: run({ mergeMessageId: "merge" }) });
  await stopFocusRun(s.bb, s.store, "r");
  expect(s.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);
  expect((await s.store.focusFindings("r", "run"))[0].reason).toBe("stopped");
  await s.store.setLifecycle("r", { focusRun: run({ mergeDispatchedAt: 1 }) });
  expect(await stopFocusRun(s.bb, s.store, "r")).toBe(false);
});

test("off listeners stay asleep even after configure, while a persisted merge still accounts after switching off", async () => {
  const s = await setup(false);
  recordFocusTools(s.bb, "assistant", false);
  const before = s.harness.inspection.sdk.calls.length;
  const events = focusEvents(s.bb, s.store);
  await (events["thread.idle"]![0] as any)({ thread: makeThreadResponse({ id: "assistant" }), lastAssistantText: null });
  expect(s.harness.inspection.sdk.calls.length).toBe(before);
});

async function complete(s: Awaited<ReturnType<typeof setup>>, count = 1) {
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(async () => expect(await s.store.listFocusThreads()).toHaveLength(1));
  const current = (await s.store.getReview("r"))!.focusRun!;
  await stage(s, count, current.id);
  current.focuses[0].state = "done";
  current.focuses[0].findings = count;
  await s.store.setLifecycle("r", { focusRun: current });
  focusReported(s.bb, current.id, "docs");
  await vi.waitFor(async () => expect((await s.store.getReview("r"))!.focusRun!.state).not.toBe("finding"));
  return current.id;
}
const idle = async (s: Awaited<ReturnType<typeof setup>>) => {
  s.statuses.set("assistant", "idle");
  for (const handle of focusEvents(s.bb, s.store)["thread.idle"] ?? []) await (handle as any)({ thread: makeThreadResponse({ id: "assistant" }), lastAssistantText: null });
};

test("25 findings are capped at 20, severity first; fresh busy runtime queues the merge", async () => {
  const s = await setup();
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  const id = await complete(s, 25);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeMessageId).toBe("merge"));
  const rows = await s.store.focusFindings("r", id);
  expect(rows.filter((row) => row.status === "found")).toHaveLength(20);
  expect(rows.filter((row) => row.reason === "over the limit")).toHaveLength(5);
  expect(rows.filter((row) => row.status === "found").every((row) => row.severity === "blocking")).toBe(true);
  const [send] = s.harness.inspection.sdk.callsTo("threads.send");
  expect(send[0]).toMatchObject({ threadId: "assistant", mode: "queue-if-active" });
});

test("busy stale grants wait for idle, refresh, then send; no watchdog sees the unsent merge as removed", async () => {
  const s = await setup();
  await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeAwaitingTools).toBe(true));
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  await idle(s);
  expect(s.harness.inspection.sdk.callsTo("threads.stop").some(([arg]) => (arg as any).threadId === "assistant")).toBe(true);
  expect((await s.store.getReview("r"))?.focusRun).toMatchObject({ state: "merging", mergeMessageId: "merge" });
  expect((await s.store.getReview("r"))?.focusRun?.mergeAwaitingTools).toBeUndefined();
});

test("swallowed refresh stop failure sends no merge and marks findings not checked", async () => {
  const s = await setup();
  await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeAwaitingTools).toBe(true));
  s.harness.sdk.stub("threads.stop", async () => { throw new Error("offline"); });
  await idle(s);
  const current = (await s.store.getReview("r"))!.focusRun!;
  expect(current.state).toBe("done");
  expect(current.mergeAwaitingTools).toBeUndefined();
  expect((await s.store.focusFindings("r", current.id))[0].reason).toBe("merge tools unavailable");
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

test.each(["message.dispatched", "message.cancelled"] as const)("%s arriving before send result persists before idle, independently of ledger cleanup", async (event) => {
  const s = await setup();
  const events = focusEvents(s.bb, s.store);
  let delivered: Promise<unknown> | undefined;
  s.harness.sdk.stub("threads.send", async () => {
    delivered = Promise.all((events[event] ?? []).map((handle) => (handle as any)({ entry: makeQueueEntry({ id: "merge", threadId: "assistant" }) })));
    return { delivery: "queued", queuedMessage: makeQueueEntry({ id: "merge", threadId: "assistant" }) };
  });
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  const id = await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeMessageId).toBe("merge"));
  await delivered;
  const current = (await s.store.getReview("r"))!.focusRun!;
  expect(current[event === "message.dispatched" ? "mergeDispatchedAt" : "mergeCancelledAt"]).toBeDefined();
  await s.bb.storage.kv.set("asking-ledger", {});
  await idle(s);
  if (event === "message.dispatched") {
    expect((await s.store.getReview("r"))?.focusRun?.nudged).toBe(true);
    await idle(s);
    expect((await s.store.focusFindings("r", id))[0]).toMatchObject({ status: "not-checked", reason: "unsettled" });
  } else expect((await s.store.focusFindings("r", id))[0]).toMatchObject({ status: "not-checked", reason: "merge message removed" });
});

test("immediate merge persists dispatch; idle accounts once and captures token deltas", async () => {
  const s = await setup();
  let input = 10;
  s.harness.sdk.stub("threads.events.list", async () => [{ type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { inputTokens: input, outputTokens: input * 2 } } } }]);
  s.harness.sdk.stub("threads.send", async () => ({ delivery: "sent" }));
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeDispatchedAt).toBeDefined());
  await idle(s);
  input = 30;
  await idle(s);
  expect((await s.store.getReview("r"))?.focusRun).toMatchObject({ state: "done", mergeTokens: { input: 20, output: 40 }, focuses: [{ tokens: { input: 10, output: 20 } }] });
});

test("push before settle prevents merging, no findings and no failure ends without a merge", async () => {
  const s = await setup();
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(async () => expect(await s.store.listFocusThreads()).toHaveLength(1));
  const current = (await s.store.getReview("r"))!.focusRun!;
  await stage(s, 1, current.id);
  await s.store.setLifecycle("r", { ...{ headSha: "new" }, focusRun: { ...current, focuses: [{ ...current.focuses[0], state: "done" }] } } as any);
  focusReported(s.bb, current.id, "docs");
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.state).toBe("done"));
  expect((await s.store.focusFindings("r", current.id))[0].reason).toBe("diff changed");
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

test("beginGuide stops a finding run inside the store block, without waiting on the outer queue", async () => {
  const s = await setup();
  const { beginGuide } = await import("./generate");
  await s.store.setLifecycle("r", { focusRun: run({ state: "finding" }) });
  await stage(s);
  await s.store.exclusive((tx) => beginGuide(s.bb, tx, s.store, "r", "p"));
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("stopped");
  expect((await s.store.focusFindings("r", "run"))[0].reason).toBe("stopped");
});

test("merging reviews first stops the archived review's run; source findings and locations go, target locations stay", async () => {
  const s = await setup();
  const { mergeReviews } = await import("./merge");
  await s.store.saveReview({ targetKey: "into", kind: "pr", status: "ready", createdAt: 1 });
  await s.store.setLifecycle("r", { focusRun: run({ state: "finding" }) });
  await stage(s);
  await s.store.saveFocusFinding({ ...(await s.store.focusFindings("r", "run"))[0], targetKey: "into", status: "kept", draftFile: "a.ts", draftLine: 9, draftSide: "LEFT" });
  await mergeReviews({ bb: s.bb, store: s.store, changed: () => {} }, "r", "into");
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("stopped");
  expect(await s.store.focusFindings("r", "run")).toEqual([]);
  expect((await s.store.focusFindings("into", "run"))[0]).toMatchObject({ draftFile: "a.ts", draftLine: 9, draftSide: "LEFT" });
});

test("restart never sends a merge that was awaiting tools, even if assistant is busy", async () => {
  const s = await setup();
  await s.store.setLifecycle("r", { focusRun: run({ mergeAwaitingTools: true }) });
  await stage(s);
  await recoverFocusRuns(s.bb, s.store);
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("done");
  await idle(s);
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

test("restart absent dispatch and queued row interrupts even when assistant is busy", async () => {
  const s = await setup();
  await s.store.setLifecycle("r", { focusRun: run({ mergeMessageId: "lost" }) });
  await stage(s);
  await recoverFocusRuns(s.bb, s.store);
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("done");
  expect((await s.store.focusFindings("r", "run"))[0].reason).toBe("interrupted");
});

test("a failed wait settles the focus instead of spinning on a live thread", async () => {
  const s = await setup();
  s.harness.sdk.stub("threads.wait", async () => { throw new Error("connection lost"); });
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.focuses[0].state).toBe("failed"));
});

test("a cancelled queued merge settles immediately without waiting for another assistant idle", async () => {
  const s = await setup();
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  const id = await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeMessageId).toBe("merge"));
  const events = focusEvents(s.bb, s.store);
  for (const handler of events["message.cancelled"] ?? []) await (handler as any)({ entry: makeQueueEntry({ id: "merge", threadId: "assistant" }) });
  expect((await s.store.getReview("r"))?.focusRun?.state).toBe("done");
  expect((await s.store.focusFindings("r", id))[0].reason).toBe("merge message removed");
});

test("an empty successful report ends without a merge", async () => {
  const s = await setup();
  await startFocusRun(s.bb, s.store, "r");
  await vi.waitFor(async () => expect(await s.store.listFocusThreads()).toHaveLength(1));
  const current = (await s.store.getReview("r"))!.focusRun!;
  current.focuses[0].state = "done";
  current.focuses[0].findings = 0;
  await s.store.setLifecycle("r", { focusRun: current });
  focusReported(s.bb, current.id, "docs");
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.state).toBe("done"));
  expect(s.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

test("queued merge tokens exclude the General review's remaining work before dispatch", async () => {
  const s = await setup();
  let input = 10;
  s.harness.sdk.stub("threads.events.list", async () => [{ type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { inputTokens: input, outputTokens: input } } } }]);
  recordFocusTools(s.bb, "assistant", true);
  focusRuntimeSpawned(s.bb, "assistant");
  const id = await complete(s);
  await vi.waitFor(async () => expect((await s.store.getReview("r"))?.focusRun?.mergeMessageId).toBe("merge"));
  input = 70;
  for (const handler of focusEvents(s.bb, s.store)["message.dispatched"] ?? []) await (handler as any)({ entry: makeQueueEntry({ id: "merge", threadId: "assistant" }) });
  const [finding] = await s.store.focusFindings("r", id);
  await s.store.saveFocusFinding({ ...finding, status: "dropped", reason: "not confirmed" });
  input = 100;
  await idle(s);
  expect((await s.store.getReview("r"))?.focusRun?.mergeTokens).toEqual({ input: 30, output: 30 });
});

test("the orphan sweep collects every page before archiving changes list offsets", async () => {
  const s = await setup(false);
  const archived = new Set<string>();
  const stopped = new Set<string>();
  const orphans = Array.from({ length: 451 }, (_, n) => makeThreadResponse({ id: `orphan-${n}`, title: "Focus: Docs · r", visibility: "hidden", originPluginId: s.bb.pluginId }));
  s.harness.sdk.stub("threads.list", async ({ archived: wanted, limit, offset }: any) => orphans.filter((thread) => archived.has(thread.id) === wanted).slice(offset, offset + limit));
  s.harness.sdk.stub("threads.archive", async ({ threadId }: any) => { archived.add(threadId); return { ok: true }; });
  s.harness.sdk.stub("threads.stop", async ({ threadId }: any) => { stopped.add(threadId); return { ok: true }; });
  await recoverFocusRuns(s.bb, s.store);
  expect(stopped.size).toBe(451);
  expect(s.harness.inspection.sdk.callsTo("threads.delete")).toEqual([]);
});
