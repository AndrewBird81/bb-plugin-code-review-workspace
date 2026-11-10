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
