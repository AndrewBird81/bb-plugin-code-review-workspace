import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";
import { deleteComment, editComment, undoChange } from "./draft-comments";
import { fixMessage } from "./fix-handoff";
import { summaryLine } from "../lib/move-to-summary";
import { toGithubReviewPayload } from "./draft";
import { reviewRevision } from "./review-revision";

vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n";
const at = { file: "a.ts", line: 3, side: "RIGHT" as const };
const comment = { ...at, author: "agent" as const, body: "Wrong docs", focus: "Docs", evidence: "a.ts:3" };

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = await startPlugin(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", patch);
  await store.upsertDraftComment("pr-1", comment);
  await store.addDiscussionMessage("pr-1", at, "reviewer", "Check this");
  const revision = await reviewRevision(store, "pr-1");
  return { store, harness, revision };
}

test("agent edits and relines keep focus; discussion Remove and Undo keep it too", async () => {
  const { store, harness } = await setup();
  expect((await editComment(store, "pr-1", { ...at, body: "Reworded" })).ok).toBe(true);
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ focus: "Docs", body: "Reworded" });
  expect((await editComment(store, "pr-1", { ...at, body: "Range", startLine: 2, code: "two\nthree" })).ok).toBe(true);
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ focus: "Docs", startLine: 2 });
  expect((await store.lastDiscussionChange("pr-1", at))?.previous).toMatchObject({ focus: "Docs" });
  expect((await undoChange(store, "pr-1", at)).ok).toBe(true);
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ focus: "Docs", body: "Reworded" });
  expect((await deleteComment(store, "pr-1", at)).ok).toBe(true);
  expect((await store.getDraft("pr-1")).comments).toEqual([]);
  expect((await undoChange(store, "pr-1", at)).ok).toBe(true);
  expect((await store.getDraft("pr-1")).comments[0]).toMatchObject({ focus: "Docs", body: "Reworded" });
  await harness.lifecycle.dispose();
});

test("panel Remove + Undo restores focus through the RPC; a panel edit drops it", async () => {
  const { store, harness, revision } = await setup();
  await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", ...at });
  const restored = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, replaces: null, restore: true, comment }) as any;
  expect(restored.draft.comments).toEqual([comment]);
  expect((await store.getDraft("pr-1")).comments).toEqual([comment]);
  await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { ...comment, focus: "x".repeat(25) } })).rejects.toThrow();
  for (const flags of [{}, { restore: true }, { restore: true, replaces: comment.body }]) {
    await store.upsertDraftComment("pr-1", comment);
    await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, ...flags, comment: { ...at, body: "My words", focus: "Docs" } });
    expect((await store.getDraft("pr-1")).comments).toEqual([{ ...at, body: "My words" }]);
    expect(toGithubReviewPayload(await store.getDraft("pr-1"), false, false, true).comments[0].body).toBe("My words");
  }
  await harness.lifecycle.dispose();
});

test("Send, discussion changes, learning, and move to summary never carry the GitHub focus label", async () => {
  const { store, harness, revision } = await setup();
  const focused = { ...comment, severity: "should-fix" as const };
  await store.upsertDraftComment("pr-1", focused);
  const text = "**Should fix:** Wrong docs";
  const review = (await store.getReview("pr-1"))!;
  expect(fixMessage(review, [focused], patch, [])).toContain(text);
  expect(fixMessage(review, [focused], patch, [])).not.toContain("Docs");
  expect(summaryLine(focused)).toContain(text);
  expect(summaryLine(focused)).not.toContain("Docs");
  await editComment(store, "pr-1", { ...at, body: "Reworded" });
  expect((await store.lastDiscussionChange("pr-1", at))?.body).toBe("**Should fix:** Reworded");
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, comment: { ...at, body: "My words" } });
  expect(await store.agentCommentChanges("pr-1")).toEqual([expect.objectContaining({ body: "**Should fix:** Reworded" })]);
  await harness.lifecycle.dispose();
});

test.each(["**", "\n", "@x"])("save and restore reject unsafe DraftComment.focus %j", async (focus) => {
  const { harness, revision } = await setup();
  for (const restore of [false, true]) {
    await expect(harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, restore, replaces: null, comment: { ...comment, focus } })).rejects.toThrow();
  }
  await harness.lifecycle.dispose();
});

test("restore trims safe DraftComment.focus", async () => {
  const { harness, revision } = await setup();
  await harness.behavior.callRpc("removeDraftComment", { targetKey: "pr-1", ...at });
  const restored = await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", revision, restore: true, replaces: null, comment: { ...comment, focus: "  文档 2._-  " } }) as any;
  expect(restored.draft.comments[0].focus).toBe("文档 2._-");
  await harness.lifecycle.dispose();
});

test("merge keeps comment focus and review delete removes the comment", async () => {
  const { store, harness } = await setup();
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: 2 });
  await store.savePatch("pr-2", patch);
  await store.mergeReview("pr-1", "pr-2");
  expect((await store.getDraft("pr-2")).comments).toEqual([comment]);
  await store.deleteReview("pr-2");
  expect((await store.getDraft("pr-2")).comments).toEqual([]);
  await harness.lifecycle.dispose();
});
