import { expect, test, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";
import { focusSpawningFor, focusThread } from "./focus-identity";
import { toolThreadReview } from "./thread-review";
import { defaultPreferences } from "./preferences";

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
