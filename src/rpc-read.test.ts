import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { testStore } from "./test-store.test-support";

test("seed then read", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n");
  const list = await harness.behavior.callRpc("listReviews", null);
  expect((list as any).reviews.map((r: any) => r.targetKey)).toContain("pr-1");
  const p = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" });
  expect((p as any).patch).toContain("diff --git");
});

test("the page receives only the current run's finding records and comparison head; list rows stay light", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  try {
    await store.saveReview({ targetKey: "r", kind: "pr", headSha: "new", status: "ready", createdAt: 1 });
    await store.savePatch("r", "diff --git a/a.ts b/a.ts\n");
    await store.setLifecycle("r", { focusRun: { id: "latest", head: "old", state: "done", startedAt: 1, focuses: [] } });
    const finding = { targetKey: "r", focusId: "docs", label: "Docs", file: "a.ts", line: 1, side: "RIGHT" as const, severity: "nit" as const, body: "<script>text</script>", evidence: "line 1", status: "dropped" as const };
    await store.saveFocusFinding({ ...finding, runId: "old", id: "old" });
    await store.saveFocusFinding({ ...finding, runId: "latest", id: "latest" });
    const bundle = await harness.behavior.callRpc("getReviewBundle", { targetKey: "r" }) as any;
    expect(bundle.review.focusHead).toBe("new");
    expect(bundle.review.focusFindings).toEqual([expect.objectContaining({ id: "latest", body: finding.body })]);
    const list = await harness.behavior.callRpc("listReviews", null) as any;
    expect(list.reviews[0].focusFindings).toBeUndefined();
  } finally { await harness.lifecycle.dispose(); }
});
