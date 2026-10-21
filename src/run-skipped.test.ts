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
import { defaultPreferences } from "./preferences";
import { defaultKnobs } from "../lib/knobs";
import { queueStore } from "./store-queue";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

/** A ready review of a PR from someone outside acme, at sha1, with what didn't run on its own. */
async function setup(lifecycle: ReviewLifecycle) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: { spawn: async ({ title }: { title: string }) => ({ id: title.startsWith("Review agent") ? "assistant" : "writer" }), get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), wait: async () => new Promise(() => {}), archive: async () => ({}), stop: async () => ({}), send: async () => ({ delivery: "sent" }) },
    projects: { defaultExecutionOptions: async () => ({ providerId: "codex", model: "gpt-6", reasoningLevel: "low", permissionMode: "auto" }), list: async () => [] },
  } as any });
  await plugin(bb);
  const store = queueStore(createStore(bb));
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "mallory", status: "ready", createdAt: 1, projectId: "p1", headSha: "sha1" });
  await store.savePatch("pr-1", PATCH);
  await store.saveGuide("pr-1", { title: "Retry", intent: "Retry once", sections: [], unplacedFiles: [] } as any);
  await store.setLifecycle("pr-1", { authorAssociation: "FIRST_TIME_CONTRIBUTOR", ownPr: false, latestHeadSha: "sha1", ...lifecycle });
  const titles = () => harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => (args as any).title);
  return { bb, harness, store, titles };
}

test("Run starts the automatic review that didn't run, and approves agents on the guide's head", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 } });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Review agent: pr-1"]);
  expect(await store.getReview("pr-1")).toMatchObject({ approvedHead: "sha1", approvedAt: expect.any(Number), skippedRun: null });
});

test("Run starts the feedback check that didn't run, on the PR's head", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, submittedVerdict: "REQUEST_CHANGES", submittedAt: 5, submittedHeadSha: "sha0" });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Review agent: pr-1"]);
  expect(await store.getReview("pr-1")).toMatchObject({ approvedHead: "sha1", approvedAt: expect.any(Number), skippedRun: null, verifyingSince: expect.any(Number) });
});

test("Run builds a guide that didn't start, or one behind the PR, and approves its head", async () => {
  for (const lifecycle of [{ skippedRun: { run: "guide", head: "sha2", at: 1 } }, { skippedRun: { run: "check", head: "sha2", at: 1 }, latestHeadSha: "sha2" }] as ReviewLifecycle[]) {
    const { harness, store, titles } = await setup(lifecycle);
    expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
    expect(titles()).toEqual(["Generate guide: pr-1"]);
    await vi.waitFor(async () => expect(await store.getReview("pr-1")).toMatchObject({ status: "generating", headSha: "sha2", approvedHead: "sha2", skippedRun: null }));
  }
});

test("Run rebuilds the guide first for a check on a PR retargeted to a new base", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, latestBase: "main" });
  await store.saveReview({ ...(await store.getReview("pr-1"))!, base: "parent" });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual(["Generate guide: pr-1"]);
  await vi.waitFor(async () => expect(await store.getReview("pr-1")).toMatchObject({ status: "generating", base: "main" }));
});

test("a run that can't start keeps its Run button, and approves nothing", async () => {
  const { harness, store } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 } });
  harness.inspection.sdk.stub("projects.defaultExecutionOptions", async () => null);
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: false, error: "bb has no default agent for the review's project." });
  expect(await store.getReview("pr-1")).toMatchObject({ skippedRun: { run: "review", head: "sha1", at: 1 }, approvedHead: null, approvedAt: null });
});

// bug bash AGT-3: you asked Ask agent something while the automatic review waited for your click, which started the
// review's conversation; Run review sent nothing to it, and said "Review started".
test("Run review on a review that has a conversation sends the review to it", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 } });
  await store.setAssistantThread("pr-1", "assistant");
  await store.setReviewContext("pr-1", "Implements LIN-42.");
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect(titles()).toEqual([]);
  const [[sent]] = harness.inspection.sdk.callsTo("threads.send") as any;
  expect(sent).toMatchObject({ threadId: "assistant", mode: "queue-if-active", input: [
    { type: "text", text: defaultPreferences.automaticReview },
    { type: "text", visibility: "agent-only", text: expect.stringContaining('<untrusted source="review context">\nImplements LIN-42.\n</untrusted>') },
  ] });
  expect(await store.getReview("pr-1")).toMatchObject({ approvedHead: "sha1", skippedRun: null });
});

// bug bash SET-3: with the run's own switch turned off since, Run review said "Review started" with nothing run, and Run
// check sent the reviewer to Ask agent's picker.
test("Run review or Run check, after its switch was turned off, says it's off and approves nothing", async () => {
  for (const [lifecycle, knobs, error] of [
    [{ skippedRun: { run: "review", head: "sha1", at: 1 } }, { runAutomaticReview: false }, "The automatic review is off. Turn it on in Review settings."],
    [{ skippedRun: { run: "check", head: "sha1", at: 1 }, submittedVerdict: "REQUEST_CHANGES", submittedAt: 5, submittedHeadSha: "sha0" }, { runReReviewCheck: false }, "The re-review check is off. Turn it on in Review settings."],
  ] as const) {
    const { harness, store, titles } = await setup(lifecycle as ReviewLifecycle);
    await store.savePreferences({ ...defaultPreferences, knobs: { ...defaultKnobs, ...knobs } }, 0);
    expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: false, error });
    expect(titles()).toEqual([]);
    expect((await store.getReview("pr-1"))?.skippedRun).toEqual(lifecycle.skippedRun);
    expect((await store.getReview("pr-1"))?.approvedHead).toBeUndefined();
  }
});

test("Run review on a PR merged since refuses, saying so", async () => {
  const { harness, store, titles } = await setup({ skippedRun: { run: "review", head: "sha1", at: 1 }, prState: "MERGED" });
  expect(await harness.behavior.callRpc("runSkipped", { targetKey: "pr-1" })).toEqual({ ok: false, error: "This PR is merged, so its review doesn't run." });
  expect(titles()).toEqual([]);
  expect((await store.getReview("pr-1"))?.skippedRun).toEqual({ run: "review", head: "sha1", at: 1 });
  expect((await store.getReview("pr-1"))?.approvedHead).toBeUndefined();
});

test("checking your feedback yourself clears a check that didn't run", async () => {
  const { harness, store } = await setup({ skippedRun: { run: "check", head: "sha1", at: 1 }, submittedVerdict: "REQUEST_CHANGES", submittedAt: 5, submittedHeadSha: "sha0" });
  expect(await harness.behavior.callRpc("checkFeedback", { targetKey: "pr-1" })).toEqual({ ok: true });
  expect((await store.getReview("pr-1"))?.skippedRun).toBeNull();
});
