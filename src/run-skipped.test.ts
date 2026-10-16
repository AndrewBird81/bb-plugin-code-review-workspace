import { expect, test, vi } from "vitest";

vi.mock("./gh", async (orig) => ({
  ...(await orig<any>()),
  runGh: vi.fn(async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ title: "Retry", baseRefName: "main", headRefName: "retry", url: "https://github.com/acme/web/pull/1", headRefOid: "sha2" }), stderr: "", code: 0 };
    if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 1 };
  }),
}));

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import type { ReviewLifecycle } from "./store";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

/** A ready review of a PR from someone outside acme, at sha1, with what didn't run on its own. */
async function setup(lifecycle: ReviewLifecycle) {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: {
    threads: { spawn: async ({ title }: { title: string }) => ({ id: title.startsWith("Review agent") ? "assistant" : "writer" }), get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), wait: async () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}), send: async () => ({ delivery: "sent" }) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }), list: async () => [] },
  } as any });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "mallory", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  store.savePatch("pr-1", PATCH);
  store.saveGuide("pr-1", { title: "Retry", intent: "Retry once", sections: [], unplacedFiles: [] } as any);
  store.setLifecycle("pr-1", { authorAssociation: "FIRST_TIME_CONTRIBUTOR", ownPr: false, latestHeadSha: "sha1", ...lifecycle });
  const titles = () => harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => (args as any).title);
  return { bb, harness, store, titles };
}

test("Run starts the automatic review that didn't run, and approves agents on the guide's head", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 } });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Review agent: pr-1"]);
  expect(store.getReview("pr-1")).toMatchObject({ approvedHead: "sha1", approvedAt: expect.any(Number), skippedRun: null });
});

test("Run starts the feedback check that didn't run, on the PR's head", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, submittedVerdict: "REQUEST_CHANGES", submittedAt: 5, submittedHeadSha: "sha0" });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Review agent: pr-1"]);
  expect(store.getReview("pr-1")).toMatchObject({ approvedHead: "sha1", approvedAt: expect.any(Number), skippedRun: null, verifyingSince: expect.any(Number) });
});

test("Run builds a guide that didn't start, or one behind the PR, and approves its head", async () => {
  for (const lifecycle of [{ skippedRun: { run: "guide", head: "sha2", at: 1 } }, { skippedRun: { run: "check", head: "sha2", at: 1 }, latestHeadSha: "sha2" }] as ReviewLifecycle[]) {
    const { harness, store, titles } = await setup(lifecycle);
    expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
    expect(titles()).toEqual(["Generate guide: pr-1"]);
    await vi.waitFor(() => expect(store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2", approvedHead: "sha2", skippedRun: null }));
  }
});

test("Run rebuilds the guide first for a check on a PR retargeted to a new base", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, latestBase: "main" });
  store.saveReview({ ...store.getReview("pr-1")!, base: "parent" });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Generate guide: pr-1"]);
  await vi.waitFor(() => expect(store.getReview("pr-1")).toMatchObject({ status: "generating", base: "main" }));
});

test("a run that can't start keeps its Run button", async () => {
  const { harness, store } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 } });
  harness.inspection.sdk.stub("projects.defaultExecutionOptions", async () => null);
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: false, error: "bb has no default agent for the review's project." });
  expect(store.getReview("pr-1")?.skippedRun).toEqual({ run: "review", head: "sha1", at: 1 });
});

test("checking your feedback yourself clears a check that didn't run", async () => {
  const { harness, store } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, submittedVerdict: "REQUEST_CHANGES", submittedAt: 5, submittedHeadSha: "sha0" });
  expect(await harness.behavior.callRpc("checkFeedback", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(store.getReview("pr-1")?.skippedRun).toBeNull();
});
