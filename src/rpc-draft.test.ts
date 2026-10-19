import { test, expect, vi } from "vitest";

// `submit` must exist before the `vi.mock` factory below runs (module
// evaluation for "../server" — and transitively "./gh" — happens before any
// of this file's own top-level statements). `vi.hoisted` guarantees that.
const { submit } = vi.hoisted(() => ({
  submit: vi.fn(async (_args: string[]) => ({ stdout: "{}", stderr: "", code: 0 })),
}));

vi.mock("./gh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh")>();
  return {
    ...actual,
    runGh: (args: string[]) =>
      // `ghSubmitReviewArgs` produces the path as a single element like
      // "repos/acme/web/pulls/1/reviews" — `args.includes("reviews")` (exact
      // element match) never matches that; check for a substring instead.
      args[0] === "auth" ? Promise.resolve({ stdout: "test-token", stderr: "", code: 0 }) : args[1] === "user" ? Promise.resolve({ stdout: "casey", stderr: "", code: 0 }) : args.some((a) => a.includes("reviews")) ? submit(args) : Promise.resolve({ stdout: JSON.stringify({ headRefOid: "sha123" }), stderr: "", code: 0 }),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";

/** What the reviewer's page shows of the draft, which submitReview takes to check it still matches. */
const shown = (store: ReturnType<typeof createStore>, targetKey: string) => {
  const { comments, body, verdict } = store.getDraft(targetKey);
  return { comments, body, verdict };
};

test("draft comment then submit builds a batched review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveDraftComment", {
    revision,
    targetKey: "pr-1",
    comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" },
  });
  await harness.behavior.callRpc("saveSummary", { targetKey: "pr-1", revision, body: "ok" });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT" });
  store.addDiscussionMessage("pr-1", { file: "a.ts", line: 1, side: "RIGHT" }, "reviewer", "Too picky?");
  const res = await harness.behavior.callRpc("submitReview", { targetKey: "pr-1", revision, account: "casey", ...shown(store, "pr-1") });
  expect((res as any).ok).toBe(true);
  expect(submit).toHaveBeenCalled();
  // Discussions were about the draft.
  expect(store.listDiscussions("pr-1")).toEqual([]);
});

test("submitting a review clears what didn't run on its own", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  store.setLifecycle("pr-1", { skippedRun: { run: "review", head: "sha123", at: 1 } });
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" }) as any;
  await harness.behavior.callRpc("saveSummary", { targetKey: "pr-1", revision, body: "ok" });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", revision, verdict: "COMMENT" });
  expect(await harness.behavior.callRpc("submitReview", { targetKey: "pr-1", revision, account: "casey", ...shown(store, "pr-1") })).toMatchObject({ ok: true });
  expect(store.getReview("pr-1")?.skippedRun).toBeNull();
});

test("draft reads and writes report comments drafted against an older diff", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-2", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const revisionOf = async () => ((await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-2" })) as any).revision;
  const comment = { file: "a.ts", line: 1, side: "RIGHT", body: "nit" };
  const saved = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-2", revision: await revisionOf(), comment }) as any;
  expect(saved.stale).toEqual([]);

  store.savePatch("pr-2", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n");
  expect((await harness.behavior.callRpc("getDraft", { targetKey: "pr-2" }) as any).stale).toEqual([{ file: "a.ts", line: 1, side: "RIGHT" }]);

  // Saving it again binds it to the current diff.
  const resaved = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-2", revision: await revisionOf(), comment: { ...comment, body: "Still a nit" } }) as any;
  expect(resaved.stale).toEqual([]);
  const removed = await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-2", file: "a.ts", line: 1, side: "RIGHT" }) as any;
  expect(removed).toMatchObject({ draft: { comments: [] }, stale: [] });
});

test("saveDraftComment refuses a line outside the current diff, naming it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-3", kind: "pr", number: 3, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-3", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-3" }) as any;
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-3", revision, comment: { file: "a.ts", line: 99, side: "RIGHT", body: "nit" } }))
    .rejects.toThrow("a.ts:99 isn’t in the current diff. Choose a line the diff shows.");
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-3", revision, comment: { file: "b.ts", line: 1, side: "RIGHT", body: "nit" } }))
    .rejects.toThrow("b.ts:1 isn’t in the current diff.");
  expect(store.getDraft("pr-3").comments).toEqual([]);
});

test("while the guide rebuilds, the summary and verdict save, and a comment's save says why it waits", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-4", kind: "pr", number: 4, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-4", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-4" }) as any;
  store.setStatus("pr-4", "generating");
  expect(await harness.behavior.callRpc("saveSummary", { targetKey: "pr-4", revision, body: "Mine." })).toMatchObject({ draft: { body: "Mine." } });
  expect(await harness.behavior.callRpc("setVerdict", { targetKey: "pr-4", revision, verdict: "APPROVE" })).toMatchObject({ draft: { verdict: "APPROVE" } });
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-4", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } }))
    .rejects.toThrow("The guide is rebuilding for new commits; your text is kept. Try again when it’s ready.");
  // Submitting says the same, without telling you to save.
  expect(await harness.behavior.callRpc("submitReview", { targetKey: "pr-4", revision, account: "casey", ...shown(store, "pr-4") })).toEqual({ ok: false, error: "The guide is rebuilding for new commits; your text is kept. Try again when it’s ready." });
});

test("the review bundle says whether the signed-in account wrote the PR", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "mine", kind: "pr", number: 5, repo: "acme/web", author: "Casey", headSha: "sha123", status: "ready", createdAt: 1 });
  store.saveReview({ targetKey: "theirs", kind: "pr", number: 6, repo: "acme/web", author: "dana", headSha: "sha123", status: "ready", createdAt: 1 });
  expect((await harness.behavior.callRpc("getReviewBundle", { targetKey: "mine" }) as any).review.ownPr).toBe(true);
  expect((await harness.behavior.callRpc("getReviewBundle", { targetKey: "theirs" }) as any).review.ownPr).toBe(false);
});

test("the list says Your PR for a PR the signed-in account wrote before the sync has read it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "mine", kind: "pr", number: 5, repo: "acme/web", author: "Casey", headSha: "sha123", status: "ready", createdAt: 1 });
  store.saveReview({ targetKey: "theirs", kind: "pr", number: 6, repo: "acme/web", author: "dana", headSha: "sha123", status: "ready", createdAt: 2 });
  // Before anything has read who you are, the list doesn't wait on gh for it.
  expect(Object.fromEntries(((await harness.behavior.callRpc("listReviews", null)) as any).reviews.map((r: any) => [r.targetKey, r.turn.label]))).toEqual({ mine: "Ready", theirs: "Ready" });
  // Once it has (here, opening a review), the list knows.
  await harness.behavior.callRpc("getReviewBundle", { targetKey: "theirs" });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as any;
  expect(Object.fromEntries(reviews.map((r: any) => [r.targetKey, r.turn.label]))).toEqual({ mine: "Your PR", theirs: "Ready" });
});

test("saveDraftComment with replaces refuses to replace a comment the box didn't show, and replaces the one it did", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-7", kind: "pr", number: 7, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-7", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-7" }) as any;
  const agents = { file: "a.ts", line: 2, side: "RIGHT" as const, author: "agent" as const, body: "Is this tested?" };
  // The agent comments on the line while the reviewer's new box, which showed none, is open there.
  store.upsertDraftComment("pr-7", agents);
  const mine = { file: "a.ts", line: 2, side: "RIGHT", body: "Mine." };
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-7", revision, comment: mine, replaces: null }))
    .rejects.toThrow("The comment on a.ts:2 changed as you wrote, so yours isn’t saved yet.");
  expect(store.getDraft("pr-7").comments).toEqual([agents]);
  // Shown the agent's comment, the reviewer replaces it.
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-7", revision, comment: mine, replaces: "Is this tested?" });
  expect(store.getDraft("pr-7").comments).toEqual([mine]);
  // On a line with no comment, null saves.
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-7", revision, comment: { ...mine, line: 1 }, replaces: null });
  expect(store.getDraft("pr-7").comments).toHaveLength(2);
});

test("saveDraftComment keeps an agent's comment the agent's when Undo puts it back", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-6", kind: "pr", number: 6, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-6", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-6" }) as any;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-6", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", author: "agent", body: "nit" } });
  expect(store.getDraft("pr-6").comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", author: "agent", body: "nit" }]);
});

test("saving a draft comment tells the review's other windows, so one with its box open reads it again", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-3", kind: "pr", number: 3, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-3", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-3" }) as any;
  const from = harness.inspection.realtimeSignals.length;
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-3", revision, comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } });
  expect(harness.inspection.realtimeSignals.slice(from).map((signal) => signal.channel)).toContain("draft:pr-3");
  // A refused save changes nothing, and says nothing.
  const refused = harness.inspection.realtimeSignals.length;
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-3", revision, replaces: "other", comment: { file: "a.ts", line: 1, side: "RIGHT", body: "mine" } })).rejects.toThrow(/changed as you wrote/);
  expect(harness.inspection.realtimeSignals.slice(refused).map((signal) => signal.channel)).not.toContain("draft:pr-3");
});

test("removing a draft comment tells the review's other windows, so none keeps showing it (70-review #8)", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-4", kind: "pr", number: 4, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.upsertDraftComment("pr-4", { file: "a.ts", line: 1, side: "RIGHT", body: "nit" });
  const from = harness.inspection.realtimeSignals.length;
  await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-4", file: "a.ts", line: 1, side: "RIGHT" });
  expect(store.getDraft("pr-4").comments).toEqual([]);
  expect(harness.inspection.realtimeSignals.slice(from).map((signal) => signal.channel)).toContain("draft:pr-4");
});

test("moveToSummary makes a comment on an older diff a line of the summary, which is then yours, and only such a comment", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-8", kind: "pr", number: 8, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.savePatch("pr-8", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n");
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const revisionOf = async () => (await rpc("getReviewBundle", { targetKey: "pr-8" })).revision;
  store.upsertDraftComment("pr-8", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", severity: "blocking", body: "Breaks." });
  store.upsertDraftComment("pr-8", { file: "a.ts", line: 3, side: "RIGHT", startLine: 2, body: "Two lines.\n\n```ts\nfix();\n```" });
  store.updateSummary("pr-8", { body: "The agent's summary.", bodyAuthor: "agent" });
  const at = { targetKey: "pr-8", file: "a.ts", line: 1, side: "RIGHT" };
  // On the current diff: edit or remove it.
  await expect(rpc("moveToSummary", { ...at, revision: await revisionOf() })).rejects.toThrow("The comment on a.ts:1 isn’t on an older diff. Edit or remove it instead.");
  store.savePatch("pr-8", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+uno\n+dos\n");
  expect((await rpc("getDraft", { targetKey: "pr-8" })).stale).toHaveLength(2);
  // Against the diff the page showed.
  await expect(rpc("moveToSummary", { ...at, revision: "old" })).rejects.toThrow("This review changed in another window.");
  const from = harness.inspection.realtimeSignals.length;
  const moved = await rpc("moveToSummary", { ...at, revision: await revisionOf() });
  expect(moved.draft.body).toBe("The agent's summary.\n\n- On `a.ts:1` (an earlier diff): **Blocking:** Breaks.");
  expect(moved.draft.bodyAuthor).toBeUndefined();
  expect(moved.draft.comments.map((c: any) => c.line)).toEqual([3]);
  expect(moved.stale).toEqual([{ file: "a.ts", line: 3, side: "RIGHT" }]);
  expect(harness.inspection.realtimeSignals.slice(from).map((signal) => signal.channel)).toContain("draft:pr-8");
  // Moved, not removed: the agent's comment isn't a removal to learn from.
  expect(store.agentCommentChanges("pr-8")).toEqual([]);
  // The next goes under it, its later lines kept in the item.
  const second = await rpc("moveToSummary", { targetKey: "pr-8", revision: await revisionOf(), file: "a.ts", line: 3, side: "RIGHT" });
  expect(second.draft.body).toBe("The agent's summary.\n\n- On `a.ts:1` (an earlier diff): **Blocking:** Breaks.\n- On `a.ts:2–3` (an earlier diff): Two lines.\n\n  ```ts\n  fix();\n  ```");
  expect(second.draft.comments).toEqual([]);
});

test("moveToSummary marks a pre-existing comment's line as it would post", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-9", kind: "pr", number: 9, repo: "acme/web", headSha: "sha123", status: "ready", createdAt: 1 });
  store.upsertDraftComment("pr-9", { file: "a.ts", line: 1, side: "RIGHT", author: "agent", severity: "blocking", introduced: false, body: "Already racy." });
  store.savePatch("pr-9", "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+uno\n");
  const { revision } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-9" }) as any;
  const moved = await harness.behavior.callRpc("moveToSummary", { targetKey: "pr-9", revision, file: "a.ts", line: 1, side: "RIGHT" }) as any;
  expect(moved.draft.body).toBe("- On `a.ts:1` (an earlier diff): **Pre-existing:** **Blocking:** Already racy.");
});
