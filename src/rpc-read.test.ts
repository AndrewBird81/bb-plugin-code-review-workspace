import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

test("seed then read", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n");
  const list = await harness.behavior.callRpc("listReviews", null);
  expect((list as any).reviews.map((r: any) => r.targetKey)).toContain("pr-1");
  const p = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" });
  expect((p as any).patch).toContain("diff --git");
});
