import { expect, test, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";
import { focusSpawningFor, focusThread } from "./focus-identity";
import { toolThreadReview } from "./thread-review";
import { defaultPreferences } from "./preferences";
import { focusEvents, startFocusRun } from "./focus-run";

vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

test("focus identity covers the spawn window and ended threads, never resolving as an assistant or writer", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { get: async () => ({ title: "Focus: Docs · r" }) } } });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1 });
  const identity = { targetKey: "r", runId: "run", focusId: "docs", label: "Docs" };
  const check = async () => {
    expect(await focusThread(bb, store, "focus")).toMatchObject(identity);
    expect(await toolThreadReview(bb, store, "focus")).toBeNull();
    const config = harness.inspection.registrations.agentConfigurationProvider!(makePluginAgentConfigurationContext({ thread: { id: "focus", title: "Focus: Docs · r" }, origin: { pluginId: bb.pluginId } }));
    expect(config.tools).toEqual(["read_review_patch", "list_review_files", "read_file", "read_pr_context", "submit_focus_findings"]);
    for (const argv of [["comment", "add", "r", "a.ts:1", "--body", "bad"], ["storage", "status"], ["list", "--json"], ["--help"], ["other-ref"]]) {
      expect(await harness.behavior.runCli(argv, { threadId: "focus" })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Focus threads cannot run bb review") });
    }
    for (const name of ["read_changes_since_review", "add_draft_comment", "set_review_summary"]) {
      const input = name === "add_draft_comment" ? { file: "a.ts", line: 1, code: "x", body: "bad" } : name === "set_review_summary" ? { body: "bad" } : {};
      expect(await harness.behavior.callAgentTool(name, input, { threadId: "focus" })).toMatchObject({ isError: true });
    }
  };
  await focusSpawningFor(bb, "Focus: Docs · r", identity, async () => {
    await check();
    await store.recordFocusThread({ ...identity, threadId: "focus", createdAt: 1 });
    await check();
  });
  await check();
  expect(await focusThread(bb, store, "forged")).toBeNull();
  await harness.lifecycle.dispose();
});

test("turning focuses on refreshes an idle assistant, while off grants and instructions stay unchanged", async () => {
  const stop = vi.fn(async () => ({ ok: true as const }));
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { get: async () => ({ status: "idle" }), stop } } });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1 });
  await store.setAssistantThread("r", "assistant");
  const configure = harness.inspection.registrations.agentConfigurationProvider!;
  const context = makePluginAgentConfigurationContext({ thread: { id: "assistant" }, origin: { pluginId: bb.pluginId } });
  const before = configure(context);
  await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: { ...defaultPreferences.focuses, enabled: true } }, revision: 0 });
  await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  expect(configure(context).tools).toEqual([...before.tools!, "list_focus_findings", "keep_focus_finding", "dismiss_focus_finding"]);
  expect(configure(context).instructions).toEqual(before.instructions);
  await harness.behavior.callRpc("savePreferences", { preferences: defaultPreferences, revision: 1 });
  expect(configure(context)).toEqual(before);
  await harness.lifecycle.dispose();
});

test("deletion refuses an active focus run before touching any threads", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1 });
  for (const state of ["finding", "merging"] as const) {
    await store.setLifecycle("r", { focusRun: { id: "run", head: "head", startedAt: 1, state, focuses: [] } });
    expect(await harness.behavior.callRpc("deleteReview", { targetKey: "r" })).toMatchObject({ ok: false, error: expect.stringContaining("focus") });
    expect(await store.getReview("r")).not.toBeNull();
  }
  await harness.lifecycle.dispose();
});

test("a run starting while delete reads BB is refused in the deletion's store turn", async () => {
  let release = () => {};
  let reading = false;
  let started = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: {
    get: async () => { if (reading) { started = true; await new Promise<void>((resolve) => { release = resolve; }); } return { status: "idle" }; },
    list: async () => [], stop: async () => ({ ok: true }), delete: async () => ({ ok: true }),
  } } });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1 });
  await store.setAssistantThread("r", "assistant");
  reading = true;
  const deleting = harness.behavior.callRpc("deleteReview", { targetKey: "r" });
  await vi.waitFor(() => expect(started).toBe(true));
  await store.setLifecycle("r", { focusRun: { id: "run", head: "head", startedAt: 1, state: "finding", focuses: [] } });
  release();
  expect(await deleting).toMatchObject({ ok: false, error: expect.stringContaining("focus") });
  expect(await store.getReview("r")).not.toBeNull();
  await harness.lifecycle.dispose();
});

test("repeated configure after enabling cannot give an old busy session fresh grants; idle refresh rebuilds before merge", async () => {
  let status: "active" | "idle" = "active";
  let loaded = true;
  let tools: unknown[] = [];
  let configure: ReturnType<typeof createFakePluginHost>["harness"]["inspection"]["registrations"]["agentConfigurationProvider"];
  const context = makePluginAgentConfigurationContext({ thread: { id: "assistant" }, origin: { pluginId: "code-review-workspace" } });
  const send = vi.fn(async () => {
    if (!loaded) { tools = [...configure!(context).tools!]; loaded = true; }
    return { delivery: "sent" };
  });
  const stop = vi.fn(async ({ threadId }: { threadId: string }) => { if (threadId === "assistant") loaded = false; return { ok: true }; });
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: {
      get: async ({ threadId }: any) => makeThreadResponse({ id: threadId, status: threadId === "assistant" ? status : "active" }),
      spawn: async () => ({ id: "focus" }), send, stop,
      archive: async () => ({ ok: true }), delete: async () => ({ ok: true }),
      interactions: { list: async () => [] }, events: { list: async () => [] },
      wait: async ({ signal }: any) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
    },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex" }) },
    providers: { list: async () => [{ id: "codex", capabilities: { permissionModes: ["auto"] } }] },
  } });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1, projectId: "p", headSha: "head" });
  await store.setLifecycle("r", { ownPr: true });
  await store.savePatch("r", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  await store.setAssistantThread("r", "assistant");
  configure = harness.inspection.registrations.agentConfigurationProvider!;
  tools = [...configure(context).tools!];
  await harness.behavior.callRpc("savePreferences", { preferences: { ...defaultPreferences, focuses: { ...defaultPreferences.focuses, enabled: true } }, revision: 0 });
  for (let n = 0; n < 3; n++) expect(configure(context).tools).toContain("keep_focus_finding");
  expect(tools).not.toContain("keep_focus_finding");
  await startFocusRun(bb, store, "r");
  await vi.waitFor(async () => expect(await store.listFocusThreads()).toHaveLength(1));
  await harness.behavior.callAgentTool("submit_focus_findings", { findings: [{ file: "a.ts", line: 1, code: "new", body: "Wrong docs", evidence: "a.ts:1", severity: "should-fix" }], unchecked: [] }, { threadId: "focus" });
  await vi.waitFor(async () => expect((await store.getReview("r"))?.focusRun?.mergeAwaitingTools).toBe(true));
  expect(send).not.toHaveBeenCalled();
  expect(stop.mock.calls.some(([args]) => args.threadId === "assistant")).toBe(false);
  status = "idle";
  await (focusEvents(bb, store)["thread.idle"]![0] as any)({ thread: makeThreadResponse({ id: "assistant", status: "idle" }), lastAssistantText: null });
  expect(stop).toHaveBeenCalledWith({ threadId: "assistant" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(tools).toContain("keep_focus_finding");
  expect((await store.getReview("r"))?.focusRun?.mergeDispatchedAt).toBeDefined();
  await harness.lifecycle.dispose();
});
