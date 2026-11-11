import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createConfigureView } from "./configure-view";
import { createStore } from "./store";
import { queueStore } from "./store-queue";
import { focusSpawningFor, focusThread } from "./focus-identity";

test("focus rows round-trip on either backend and configure sees them after a queued turn", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const view = await createConfigureView(bb, createStore(bb));
  const store = queueStore(view.backend, { afterTurn: view.afterTurn });
  const thread = { threadId: "focus", targetKey: "r", runId: "run", focusId: "docs", label: "Docs", createdAt: 1 };
  await store.recordFocusThread(thread);
  expect(await store.listFocusThreads()).toEqual([thread]);
  expect(view.threadRole({ id: "focus", title: "renamed" })).toBe("focus");
  expect(view.threadReview({ id: "focus", title: "renamed" })).toBeNull();
  const finding = { targetKey: "r", runId: "run", focusId: "docs", label: "Docs", id: "f", file: "a.ts", line: 2, side: "RIGHT" as const, severity: "nit" as const, body: "Wrong docs", evidence: "a.ts:2", introduced: false, status: "found" as const };
  await store.saveFocusFinding(finding);
  expect(await store.focusFindings("r", "run")).toEqual([finding]);
  await store.saveFocusFinding({ ...finding, status: "folded", draftFile: "b.ts", draftLine: 3, draftSide: "LEFT", reason: "duplicate", decidedAt: 4 });
  expect((await store.focusFindings("r", "run"))[0]).toMatchObject({ status: "folded", draftFile: "b.ts", draftLine: 3, draftSide: "LEFT", decidedAt: 4 });
  await store.clearFocusFindings("r");
  expect(await store.focusFindings("r", "run")).toEqual([]);
  expect(await focusThread(bb, store, "focus")).toEqual(thread);
  await harness.lifecycle.dispose();
});

test("focusSpawning covers only an exact title until the row commits, and clears after failure", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { get: async () => ({ title: "Focus: Docs · r" }) } } });
  const view = await createConfigureView(bb, createStore(bb));
  const store = queueStore(view.backend, { afterTurn: view.afterTurn });
  await expect(focusSpawningFor(bb, "Focus: Docs · r", { targetKey: "r", runId: "run", focusId: "docs", label: "Docs" }, async () => {
    expect(view.threadRole({ id: "unknown", title: "Focus: Docs · r" })).toBe("focus");
    expect(view.threadRole({ id: "unknown", title: "Focus: Docs · r extra" })).toBeNull();
    expect(view.threadReview({ id: "unknown", title: "Focus: Docs · r" })).toBeNull();
    expect(await focusThread(bb, store, "unknown")).toMatchObject({ targetKey: "r" });
    throw new Error("spawn failed");
  })).rejects.toThrow("spawn failed");
  expect(view.threadRole({ id: "unknown", title: "Focus: Docs · r" })).toBeNull();
  expect(await focusThread(bb, store, "unknown")).toBeNull();
  await harness.lifecycle.dispose();
});

test.each(["configure", "id lookup"])("%s: a recorded assistant or writer cannot become another review's focus by retitling during spawn", async (via) => {
  const title = "Focus: Docs · other";
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { get: async () => ({ title }) } } });
  const view = await createConfigureView(bb, createStore(bb));
  const store = queueStore(view.backend, { afterTurn: view.afterTurn });
  await store.saveReview({ targetKey: "r", kind: "pr", status: "ready", createdAt: 1 });
  await store.setAssistantThread("r", "assistant");
  const generation = await store.beginGeneration("r");
  await store.setGenerationWorker("r", generation, "writer");
  await focusSpawningFor(bb, title, { targetKey: "other", runId: "run", focusId: "docs", label: "Docs" }, async () => {
    for (const role of ["assistant", "writer"] as const) {
      if (via === "configure") expect(view.threadRole({ id: role, title })).toBe(role);
      else expect(await focusThread(bb, store, role)).toBeNull();
      expect(view.threadReview({ id: role, title })).toBe("r");
    }
    expect(view.threadRole({ id: "new-focus", title })).toBe("focus");
    expect(await focusThread(bb, store, "new-focus")).toMatchObject({ targetKey: "other" });
  });
  await harness.lifecycle.dispose();
});
