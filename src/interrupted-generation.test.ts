import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { generateGuide } from "./generate";
import { defaultPreferences } from "./preferences";
import { formerWorkerReview, NO_REVIEW, recordFormerWorker } from "./former-workers";
import { runGh } from "./gh";
import { testSql, testStore } from "./test-store.test-support";

vi.mock("./gh", async (original) => ({
  ...await original<typeof import("./gh")>(),
  runGh: vi.fn(async (args: string[]) => args[1] === "diff" ? { code: 0, stderr: "", stdout: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" }
    : args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify({ title: "T", baseRefName: "main", headRefName: "h", url: "u", headRefOid: "sha2" }) }
    : { code: 1, stderr: "", stdout: "" }),
}));

const guide = { title: "Kept", intent: "I", sections: [], unplacedFiles: [] };

/** A plugin that stopped while a guide worker was writing a rebuild of pr-1's guide. */
async function interrupted(sdk: Record<string, unknown> = {}, lifecycle: Record<string, unknown> = {}) {
  const first = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: async () => ({ id: "old-worker" }), wait: () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
  } } as any });
  const store = testStore(first.bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  await store.setLifecycle("pr-1", { authorAssociation: "MEMBER", ...lifecycle });
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+a2\n");
  await store.saveGuide("pr-1", guide);
  await store.backupGuide("pr-1");
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
  return { ...next, store: testStore(next.bb), archive, stop };
}

test("after a reload, the guide being written is stopped and archived, the old guide kept, and the rebuild starts again", async () => {
  const { bb, harness, store, archive, stop } = await interrupted();
  await plugin(bb);
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" });
  expect(archive).toHaveBeenCalledWith({ threadId: "old-worker" });
  expect(await store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2" });
});

test("after a reload with the guide writer's machine offline, the old guide stays and nothing starts", async () => {
  const { bb, harness, store, stop } = await interrupted({ "hosts.get": async () => ({ id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } }) });
  await store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect((await store.getGuide("pr-1"))?.title).toBe("Kept");
  expect(await store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
});

test("after a reload, an outside author's guide restarts only at the head you started it on", async () => {
  // You started the guide at sha1; the author has pushed sha2 since.
  const { bb, harness, store, stop } = await interrupted({}, { authorAssociation: "CONTRIBUTOR", approvedHead: "sha1" });
  await plugin(bb);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ threadId: "old-worker" }));
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.skippedRun).toMatchObject({ run: "guide", head: "sha2" }));
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect((await store.getGuide("pr-1"))?.title).toBe("Kept");
  expect(await store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
});

test("after a reload with the guide writer's machine offline, the guide restarts on a later pass once it's back", async () => {
  const host = { id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } };
  const { bb, harness, store, stop } = await interrupted({ "hosts.get": async () => host, "projects.list": async () => [{ id: "personal", kind: "personal" }] });
  await store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.restartPending).toEqual({ since: expect.any(Number) }));
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
  expect(await store.getReview("pr-1")).toMatchObject({ status: "error", restartPending: { since: expect.any(Number) } });
  host.status = "connected";
  await pass();
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  expect(await store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2", restartPending: null });
});

test("an interrupted guide whose machine stays offline past 10 minutes isn't tried again", async () => {
  const host = { id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } };
  const { bb, harness, store } = await interrupted({ "hosts.get": async () => host });
  await store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.restartPending).toBeTruthy());
  await store.setLifecycle("pr-1", { restartPending: { since: Date.now() - 11 * 60_000 } });
  host.status = "connected";
  const told = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "review:pr-1").length;
  const before = told();
  const { controller, done } = harness.runService("review-state");
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.restartPending).toBeNull());
  controller.abort();
  await done;
  // The open page hears, so it stops saying the guide restarts on its own (70-review-correctness #3).
  expect(told()).toBeGreaterThan(before);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(await store.getReview("pr-1")).toMatchObject({ status: "error", headSha: "sha1" });
  expect(harness.inspection.logEntries.some((entry: any) => String(entry.message).includes("stays failed"))).toBe(true);
});

// bug bash AGT-13: a writer whose spawn was still in flight at the reload has no recorded id, so it ran on, hidden, and to
// bb review it was an ordinary thread of yours.
test("after a reload, a writer whose spawn it interrupted is found by its title, kept to its review, and stopped", async () => {
  const first = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: () => new Promise(() => {}), wait: () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
  } } as any });
  const before = testStore(first.bb);
  await before.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  await before.setLifecycle("pr-1", { authorAssociation: "MEMBER" });
  await before.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+a2\n");
  void generateGuide(first.bb, before, "pr-1", "p1");
  await vi.waitFor(() => expect(first.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  const next = await first.harness.lifecycle.reload(async () => {});
  const order: string[] = [];
  const thread = (id: string, title: string) => ({ id, title, originPluginId: "code-review-workspace" });
  next.harness.inspection.sdk.stub("threads.list", (async ({ archived }: { archived?: boolean }) => archived ? []
    : [thread("orphan", "Generate guide: pr-1"), thread("other", "Generate guide: pr-2"), thread("assistant", "Review agent: pr-1")]) as any);
  next.harness.inspection.sdk.stub("threads.spawn", async () => { order.push("spawn"); return { id: "new-worker" }; });
  next.harness.inspection.sdk.stub("threads.wait", () => new Promise(() => {}));
  next.harness.inspection.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => { order.push(`archive ${threadId}`); return {}; });
  next.harness.inspection.sdk.stub("threads.stop", async ({ threadId }: { threadId: string }) => { order.push(`stop ${threadId}`); return {}; });
  await plugin(next.bb);
  await vi.waitFor(() => expect(order).toContain("spawn"));
  expect(order.slice(0, 3)).toEqual(["archive orphan", "stop orphan", "spawn"]);
  expect(await formerWorkerReview(next.bb, "orphan")).toBe("pr-1");
  expect(await formerWorkerReview(next.bb, "other")).toBeNull();
});

// bug bash verification 71-F1: a thread's title is its own agent's to write, and the reload took the title alone: a former
// agent of pr-2, or the Suggest instructions worker, retitled "Generate guide: pr-1" became pr-1's, free to change its
// draft through bb review, and another review's assistant so titled was archived and stopped.
test("after a reload, a thread titled as the interrupted review's writer stays kept to its own review", async () => {
  const first = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    spawn: () => new Promise(() => {}), wait: () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
  } } as any });
  const before = testStore(first.bb);
  for (const key of ["pr-1", "pr-2"]) await before.saveReview({ targetKey: key, kind: "pr", number: Number(key.slice(3)), repo: "acme/web", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  await before.setLifecycle("pr-1", { authorAssociation: "MEMBER" });
  await before.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+a2\n");
  await before.setAssistantThread("pr-2", "pr2-assistant");
  await recordFormerWorker(first.bb, "old-pr2-writer", "pr-2", "writer");
  await recordFormerWorker(first.bb, "suggester", null, "suggester");
  void generateGuide(first.bb, before, "pr-1", "p1");
  await vi.waitFor(() => expect(first.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  const next = await first.harness.lifecycle.reload(async () => {});
  const stopped: string[] = [];
  const thread = (id: string) => ({ id, title: "Generate guide: pr-1", originPluginId: "code-review-workspace" });
  next.harness.inspection.sdk.stub("threads.list", (async ({ archived }: { archived?: boolean }) => archived ? []
    : [thread("orphan"), thread("old-pr2-writer"), thread("suggester"), thread("pr2-assistant")]) as any);
  next.harness.inspection.sdk.stub("threads.spawn", async () => ({ id: "new-worker" }));
  next.harness.inspection.sdk.stub("threads.wait", () => new Promise(() => {}));
  next.harness.inspection.sdk.stub("threads.stop", async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return {}; });
  await plugin(next.bb);
  await vi.waitFor(() => expect(next.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  expect(await formerWorkerReview(next.bb, "orphan")).toBe("pr-1");
  expect(await formerWorkerReview(next.bb, "old-pr2-writer")).toBe("pr-2");
  expect(await formerWorkerReview(next.bb, "suggester")).toBe(NO_REVIEW);
  expect(await formerWorkerReview(next.bb, "pr2-assistant")).toBeNull();
  expect(stopped).toEqual(["orphan"]);
});

// bug bash SRV-5: the BB server restarts before its network is up. The interrupted guide's restart couldn't read the PR,
// and the review stayed Failed with no What went wrong; nothing retries it, as Try again is a click away.
test("a guide a reload interrupted while GitHub couldn't be read stays failed, saying why", async () => {
  const reads = vi.mocked(runGh).getMockImplementation();
  vi.mocked(runGh).mockImplementation(async () => ({ code: 1, stderr: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com", stdout: "" }));
  try {
    const { bb, harness, store } = await interrupted();
    await plugin(bb);
    await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.guideError?.text).toContain("error connecting to api.github.com"));
    expect((await store.getReview("pr-1"))?.status).toBe("error");
    expect((await store.getReview("pr-1"))?.restartPending ?? null).toBeNull();
    expect((await store.getGuide("pr-1"))?.title).toBe("Kept");
    expect(harness.inspection.realtimeSignals.some((signal) => signal.channel === "review:pr-1")).toBe(true);
    // GitHub answers again; the review-state loop leaves it to Try again.
    vi.mocked(runGh).mockImplementation(reads!);
    const { controller, done } = harness.runService("review-state");
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await done;
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  } finally {
    vi.mocked(runGh).mockImplementation(reads!);
  }
});

test("an interrupted guide whose machine stays offline past 10 minutes says why it failed", async () => {
  const host = { id: "host_flomac", name: "FloMac", status: "disconnected", lifecycle: { phase: "active" } };
  const { bb, harness, store } = await interrupted({ "hosts.get": async () => host });
  await store.savePreferences({ ...defaultPreferences, guideAgent: { hostId: "host_flomac", providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" } }, 0);
  await plugin(bb);
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.restartPending).toBeTruthy());
  expect((await store.getReview("pr-1"))?.guideError ?? null).toBeNull();
  await store.setLifecycle("pr-1", { restartPending: { since: Date.now() - 11 * 60_000 } });
  const { controller, done } = harness.runService("review-state");
  await vi.waitFor(async () => expect((await store.getReview("pr-1"))?.restartPending).toBeNull());
  controller.abort();
  await done;
  expect((await store.getReview("pr-1"))?.guideError?.text).toContain("FloMac is offline");
});

// bug bash D2: the restarts ran in one loop with one catch, so a restart that threw, as rerunReview does when the store
// fails mid-rebuild, ended it: the guides after it never restarted, and it was left with no reason.
test("after a reload, every interrupted guide restarts past one whose restart throws, which stays failed, saying why", async () => {
  const reads = vi.mocked(runGh).getMockImplementation();
  const diff = (line: string) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+${line}\n`;
  vi.mocked(runGh).mockImplementation(async (args: string[]) => args[1] === "diff" ? { code: 0, stderr: "", stdout: diff("new") }
    : args[1] === "view" ? { code: 0, stderr: "", stdout: JSON.stringify({ title: "T", baseRefName: "main", headRefName: "h", url: "u", headRefOid: `sha-${args[2]}` }) }
    : { code: 1, stderr: "", stdout: "" });
  try {
    const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
      spawn: async () => ({ id: "new-worker" }), wait: () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}),
    } } as any });
    const store = testStore(bb);
    // Two guides were building when the plugin stopped; interruptGenerations orders them by key, pr-1 first.
    for (const number of [1, 2]) {
      const key = `pr-${number}`;
      await store.saveReview({ targetKey: key, kind: "pr", number, repo: "acme/web", status: "generating", createdAt: 1, projectId: "p1", headSha: "sha0" });
      await store.setLifecycle(key, { authorAssociation: "MEMBER" });
      await store.savePatch(key, diff("old"));
    }
    // pr-1's new diff fails to save.
    const sql = testSql(bb);
    if (sql.dialect === "sqlite") {
      await sql.run(`CREATE TRIGGER refuse_pr1 BEFORE UPDATE ON patches WHEN NEW.target_key = 'pr-1' BEGIN SELECT RAISE(ABORT, 'Connection terminated unexpectedly'); END`);
    } else {
      await sql.run(`CREATE FUNCTION refuse_pr1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Connection terminated unexpectedly'; END $$`);
      await sql.run(`CREATE TRIGGER refuse_pr1 BEFORE UPDATE ON patches FOR EACH ROW WHEN (NEW.target_key = 'pr-1') EXECUTE FUNCTION refuse_pr1()`);
    }
    await plugin(bb);
    await vi.waitFor(async () => expect(await store.getReview("pr-2")).toMatchObject({ status: "generating", headSha: "sha-2" }));
    await vi.waitFor(async () => expect(await store.getReview("pr-1")).toMatchObject({ status: "error", guideError: { text: expect.stringContaining("Connection terminated unexpectedly") } }));
    expect(harness.inspection.logEntries).toContainEqual({ level: "warn", message: expect.stringContaining("The interrupted guide for pr-1 didn't restart") });
  } finally {
    vi.mocked(runGh).mockImplementation(reads!);
  }
});
