import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { generateGuide, stopGuideGenerations } from "./generate";
import { completionNotifications } from "./completion-notifications";
import plugin from "../server";
import { defaultPreferences } from "./preferences";

const guide = { title: "Improve sign-in", intent: "I", sections: [], unplacedFiles: [] };
function fixture() {
  const delivered: any[] = [];
  let offline = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { plugins: {
    callRpc: async ({ method, input }: any) => {
      if (offline) throw new Error("Needs You is disabled");
      if (method === "activityCapabilities") return { version: 1 };
      delivered.push(input);
      return { accepted: true, id: "activity:guided-review:target", duplicate: false };
    },
  }, threads: { spawn: async () => ({ id: "worker" }), archive: async () => {}, stop: async () => {} } } });
  const store = createStore(bb);
  store.saveReview({ targetKey: "target", kind: "ref", title: "Improve sign-in", status: "generating", createdAt: 1, projectId: "p1" });
  harness.inspection.sdk.stub("threads.wait", async () => { store.saveGuide("target", guide); return { matched: true }; });
  return { bb, harness, store, delivered, offline: (value: boolean) => { offline = value; } };
}

test("a completed guide notifies through Needs You with its review destination and no worker link", async () => {
  const f = fixture();
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.store.getReview("target")?.status).toBe("ready");
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toMatchObject({ sourceId: "guided-review", entityId: "target", status: "ready", projectId: "p1", target: { panel: "review", segments: ["target"] } });
  expect(JSON.stringify(f.delivered)).not.toContain("worker");
  await completionNotifications(f.bb, f.store).flush();
  expect(f.delivered).toHaveLength(1);
  await f.harness.lifecycle.dispose();
});

test("with A guide is ready or failed off, a finished guide queues and sends nothing", async () => {
  const f = fixture();
  f.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, alertGuides: false } }, 0);
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.store.getReview("target")?.status).toBe("ready");
  await completionNotifications(f.bb, f.store).flush();
  expect(await f.bb.storage.kv.get("needs-you:pending:target")).toBeFalsy();
  expect(f.delivered).toEqual([]);
  await f.harness.lifecycle.dispose();
});

test("with A review becomes your turn off, a turn queues and sends nothing", async () => {
  const f = fixture();
  f.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, alertTurns: false } }, 0);
  const notifications = completionNotifications(f.bb, f.store);
  notifications.useTurns(() => "re-requested:1");
  await notifications.queueTurn({ targetKey: "target", signal: "re-requested:1", projectId: "p1", body: "@alice re-requested your review" });
  await notifications.flush();
  expect(await f.bb.storage.kv.get("needs-you:pending:target")).toBeFalsy();
  expect(f.delivered).toEqual([]);
  await f.harness.lifecycle.dispose();
});

test("a failed guide notifies failure and optional Needs You downtime cannot fail a ready guide", async () => {
  const f = fixture();
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.store.getReview("target")?.status).toBe("ready");
  expect(f.delivered).toHaveLength(0);
  f.offline(false);
  await completionNotifications(f.bb, f.store).flush();
  expect(f.delivered[0].status).toBe("ready");
  f.harness.inspection.sdk.stub("threads.wait", async () => { throw new Error("failed"); });
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.delivered.at(-1).status).toBe("error");
  await f.harness.lifecycle.dispose();
});

test("superseded and cancelled workers cannot send completion notifications", async () => {
  const f = fixture();
  f.harness.inspection.sdk.stub("threads.wait", async () => { f.store.beginGeneration("target"); return { matched: true }; });
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.delivered).toHaveLength(0);
  f.harness.inspection.sdk.stub("threads.wait", async () => { stopGuideGenerations(f.bb); return { matched: false }; });
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(f.delivered).toHaveLength(0);
  await f.harness.lifecycle.dispose();
});

test("a queued completion is discarded if the review has started another generation", async () => {
  const f = fixture();
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  f.store.beginGeneration("target");
  f.offline(false);
  await completionNotifications(f.bb, f.store).flush();
  expect(f.delivered).toHaveLength(0);
  await f.harness.lifecycle.dispose();
});

test("a queued completion survives a plugin reload and same-millisecond generations remain ordered", async () => {
  const f = fixture();
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  const next = await f.harness.lifecycle.reload(plugin);
  const store = createStore(next.bb);
  f.offline(false);
  await completionNotifications(next.bb, store).flush();
  expect(f.delivered).toHaveLength(1);
  const first = f.delivered[0];
  vi.spyOn(Date, "now").mockReturnValue(first.occurredAt);
  try {
    const generationId = store.beginGeneration("target");
    store.saveGuide("target", guide);
    store.setStatus("target", "ready");
    await completionNotifications(next.bb, store).queue({ targetKey: "target", generationId, projectId: "p1", status: "ready" });
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1].occurredAt).toBeGreaterThan(first.occurredAt);
  } finally { vi.restoreAllMocks(); await next.harness.lifecycle.dispose(); }
});

test("regeneration in the storage-read microtask cannot publish an old ready result", async () => {
  const f = fixture();
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  f.offline(false);
  const read = f.bb.storage.kv.get.bind(f.bb.storage.kv);
  let reads = 0;
  vi.spyOn(f.bb.storage.kv, "get").mockImplementation(async (key) => {
    const value = await read(key);
    if (key.startsWith("needs-you:pending:") && ++reads === 2) {
      queueMicrotask(() => queueMicrotask(() => f.store.beginGeneration("target")));
    }
    return value as any;
  });
  await completionNotifications(f.bb, f.store).flush();
  expect(f.store.getReview("target")?.status).toBe("generating");
  expect(f.delivered).toHaveLength(0);
  vi.restoreAllMocks();
  await f.harness.lifecycle.dispose();
});

test("queued events expire after a day even if Needs You is never installed", async () => {
  const f = fixture();
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  try {
    await completionNotifications(f.bb, f.store).flush();
    expect(await f.bb.storage.kv.list("needs-you:pending:")).toEqual([]);
    expect(f.delivered).toHaveLength(0);
  } finally { vi.restoreAllMocks(); await f.harness.lifecycle.dispose(); }
});

// An alert queued while Needs You couldn't take it waits in the outbox; turned off meanwhile, it isn't sent (bug bash SET-5).
test("an alert waiting in the outbox isn't sent once its switch is turned off", async () => {
  const f = fixture();
  f.offline(true);
  const notifications = completionNotifications(f.bb, f.store);
  notifications.useTurns(() => "re-requested:1");
  await notifications.queueTurn({ targetKey: "target", signal: "re-requested:1", projectId: "p1", body: "@alice re-requested your review" });
  expect(await f.bb.storage.kv.get("needs-you:pending:target")).toBeTruthy();
  f.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, alertTurns: false } }, 0);
  f.offline(false);
  await notifications.flush();
  expect(f.delivered).toEqual([]);
  expect(await f.bb.storage.kv.get("needs-you:pending:target")).toBeFalsy();
  // A guide's outcome waits on A guide is ready or failed.
  f.offline(true);
  await generateGuide(f.bb, f.store, "target", "p1");
  expect(await f.bb.storage.kv.get("needs-you:pending:target")).toBeTruthy();
  f.store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, alertGuides: false } }, 1);
  f.offline(false);
  await notifications.flush();
  expect(f.delivered).toEqual([]);
  await f.harness.lifecycle.dispose();
});

// A timed snooze's wake alerts its turn again under its own event id (bug bash SET-7).
test("a turn alert queued with its own event id keeps it when it's sent after waiting in the outbox", async () => {
  const f = fixture();
  f.offline(true);
  const notifications = completionNotifications(f.bb, f.store);
  notifications.useTurns(() => "re-requested:1");
  await notifications.queueTurn({ targetKey: "target", signal: "re-requested:1", eventId: "turn:re-requested:1:woke:5", projectId: "p1", body: "@alice re-requested your review" });
  await notifications.flush();
  expect(f.delivered).toEqual([]);
  f.offline(false);
  await notifications.flush();
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0].eventId).toBe("turn:re-requested:1:woke:5");
  await f.harness.lifecycle.dispose();
});
