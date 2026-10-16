import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { generateGuide } from "./generate";
import { defaultPreferences } from "./preferences";

vi.mock("./gh", async (original) => ({
  ...await original<typeof import("./gh")>(),
  runGh: vi.fn(async (args: string[]) => args[1] === "diff" ? { code: 0, stderr: "", stdout: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" }
    : args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify({ title: "T", baseRefName: "main", headRefName: "h", url: "u", headRefOid: "sha2" }) }
    : { code: 1, stderr: "", stdout: "" }),
}));

const guide = { title: "Kept", intent: "I", sections: [], unplacedFiles: [] };

/** A plugin that stopped while a guide worker was writing a rebuild of pr-1's guide. */
async function interrupted(sdk: Record<string, unknown> = {}, lifecycle: Record<string, unknown> = {}) {
  const first = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    spawn: async () => ({ id: "old-worker" }), wait: () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
  } } as any });
  const store = createStore(first.bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  store.setLifecycle("pr-1", { authorAssociation: "MEMBER", ...lifecycle });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+a2\n");
  store.saveGuide("pr-1", guide);
  store.backupGuide("pr-1");
  void generateGuide(first.bb, store, "pr-1", "p1");
  await vi.waitFor(() => expect(first.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  const archive = vi.fn(async () => ({}));
  const stop = vi.fn(async () => ({}));
  const next = await first.harness.lifecycle.reload(async () => {});
  next.harness.inspection.sdk.stub("threads.spawn", async () => ({ id: "new-worker" }));
  next.harness.inspection.sdk.stub("threads.wait", () => new Promise(() => {}));
  next.harness.inspection.sdk.stub("threads.archive", archive);
  next.harness.inspection.sdk.stub("threads.stop", stop);
  for (const [name, fn] of Object.entries(sdk)) next.harness.inspection.sdk.stub(name as any, fn as any);
  return { ...next, store: createStore(next.bb), archive, stop };
}

test("after a reload, the guide being written is stopped and archived, the old guide kept, and the rebuild starts again", async () => {
  const { bb, harness, store, archive, stop } = await interrupted();
  await plugin(bb);
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" });
  expect(archive).toHaveBeenCalledWith({ threadId: "old-worker" });
  expect(store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2" });
});

test("after a reload with the guide writer's machine offline, the old guide stays and nothing starts", async () => {
  const { bb, harness, store, stop } = await interrupted({ "hosts.get": async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) });
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(store.getGuide("pr-1")?.title).toBe("Kept");
  expect(store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
});

test("after a reload, an outside author's guide restarts only at the head you started it on", async () => {
  // You started the guide at sha1; the author has pushed sha2 since.
  const { bb, harness, store, stop } = await interrupted({}, { authorAssociation: "CONTRIBUTOR", approvedHead: "sha1" });
  await plugin(bb);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" }));
  await vi.waitFor(() => expect(store.getReview("pr-1")?.skippedRun).toMatchObject({ run: "guide", head: "sha2" }));
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(store.getGuide("pr-1")?.title).toBe("Kept");
  expect(store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
});

test("after a reload with the guide writer's machine offline, the guide restarts on a later pass once it's back", async () => {
  const host = { id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } };
  const { bb, harness, store, stop } = await interrupted({ "hosts.get": async () => host, "projects.list": async () => [{ id: "personal", kind: "personal" }] });
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(() => expect(store.getReview("pr-1")?.restartPending).toEqual({ since: expect.any(Number) }));
  expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" });
  const pass = async () => {
    const { controller, done } = harness.runService("review-state");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await done;
  };
  // Still offline: the review waits, Failed.
  await pass();
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(store.getReview("pr-1")).toMatchObject({ status: "error", restartPending: { since: expect.any(Number) } });
  host.status = "connected";
  await pass();
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  expect(store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2", restartPending: null });
});

test("an interrupted guide whose machine stays offline past 10 minutes isn't tried again", async () => {
  const host = { id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } };
  const { bb, harness, store } = await interrupted({ "hosts.get": async () => host });
  store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(() => expect(store.getReview("pr-1")?.restartPending).toBeTruthy());
  store.setLifecycle("pr-1", { restartPending: { since: Date.now() - 11 * 60_000 } });
  host.status = "connected";
  const { controller, done } = harness.runService("review-state");
  await vi.waitFor(() => expect(store.getReview("pr-1")?.restartPending).toBeNull());
  controller.abort();
  await done;
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
  expect(harness.inspection.logEntries.some((entry: any) => String(entry.message).includes("stays failed"))).toBe(true);
});
