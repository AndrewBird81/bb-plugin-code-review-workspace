import { expect, test, vi } from "vitest";

const { gh } = vi.hoisted(() => ({ gh: vi.fn() }));
vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: gh }));

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

async function prunedReview() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.saveGuide("pr-1", { title: "t", intent: "i", sections: [], unplacedFiles: [] });
  store.setVerdict("pr-1", "APPROVE", "LGTM");
  const opened = () => harness.inspection.realtimeSignals.filter((s) => s.channel === "review:pr-1").length;
  return { harness, opened };
}

test("a pruned review whose diff reads back empty doesn't ask the page to reload", async () => {
  gh.mockImplementation(async () => ({ stdout: "", stderr: "", code: 0 }));
  const { harness, opened } = await prunedReview();
  const before = opened();
  const bundle = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  expect(bundle.patch).toBe("");
  expect(bundle.diffError).toBeUndefined();
  expect(opened()).toBe(before);
});

test("a pruned review opens with its guide and draft when GitHub can't be reached, saying why the diff is missing", async () => {
  gh.mockImplementation(async () => ({ stdout: "", stderr: "error connecting to api.github.com.", code: 1 }));
  const { harness } = await prunedReview();
  const bundle = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  expect(bundle.guide.intent).toBe("i");
  expect(bundle.patch).toBe("");
  expect(bundle.diffError).toMatch(/^Couldn't read this review's diff from GitHub: error connecting to api\.github\.com\. The guide, your draft and notes are here; try again when GitHub can be reached\.$/);
  expect((await harness.behavior.callRpc("getDraft", { targetKey: "pr-1" }) as any).draft.body).toBe("LGTM");
});

test("a pruned review whose diff GitHub refuses says why, without suggesting a retry will reach it", async () => {
  gh.mockImplementation(async () => ({ stdout: "", stderr: "HTTP 404: Not Found", code: 1 }));
  const { harness } = await prunedReview();
  const bundle = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  expect(bundle.diffError).toBe("Couldn't read this review's diff from GitHub: HTTP 404: Not Found. The guide, your draft and notes are here.");
});

test("old diffs are dropped on a daily schedule, not when the plugin starts", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
  store.setLifecycle("pr-1", { prState: "MERGED", archivedAt: Date.now() - 40 * 86_400_000 });
  gh.mockImplementation(async () => ({ stdout: "", stderr: "", code: 1 }));
  await plugin(bb);
  const { controller, done } = harness.runService("review-state");
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await done;
  expect(store.hasPatch("pr-1")).toBe(true);
  expect(harness.inspection.registrations.schedules.map(({ name, cron }) => ({ name, cron }))).toEqual([{ name: "prune-old-diffs", cron: "17 4 * * *" }]);
  await harness.runSchedule("prune-old-diffs");
  expect(store.hasPatch("pr-1")).toBe(false);
});
