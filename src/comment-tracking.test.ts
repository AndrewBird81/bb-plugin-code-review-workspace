// What 1.8.0's review loop keeps: each comment's id, state, Send, claim and editedBy, which only the server sets; the
// Sends and the agent's activity, kept short; a diff's files beside its snapshot; and lifecycle keys that never stand in
// for the review's own fields.
import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { newCommentIds, type ReviewLifecycle, type ReviewMeta, type SendEntry } from "./store";
import { toGithubReviewPayload, type Claim, type CommentLocation } from "./draft";
import { testStore } from "./test-store.test-support";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n";
const AT: CommentLocation = { file: "a.ts", line: 1, side: "RIGHT" };
const CLAIM: Claim = { outcome: "done", note: "Capped at 5.", commit: "abc1234", threadId: "thr_main", at: 5 };

async function review() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, repo: "acme/web", headSha: "sha1", status: "ready", createdAt: 1 });
  await store.savePatch("pr-1", PATCH);
  const call = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const { revision } = await call("getReviewBundle", { targetKey: "pr-1" });
  const save = (comment: Record<string, unknown>) => call("saveDraftComment", { targetKey: "pr-1", revision, comment: { ...AT, ...comment } });
  return { bb, store, call, save };
}

test("an edited sent comment keeps its id, Send and claim, and is open again, to go with the next Send", async () => {
  const { store, save } = await review();
  await save({ body: "Cap the retries." });
  await store.trackComments("pr-1", [{ at: AT, id: "c1", state: "sent", sendN: 1, claim: CLAIM }]);
  const { draft } = await save({ body: "Cap the retries at 5." });
  expect(draft.comments).toEqual([{ ...AT, body: "Cap the retries at 5.", id: "c1", state: "open", sendN: 1, claim: CLAIM }]);
  expect((await store.getDraft("pr-1")).comments).toEqual(draft.comments);
});

test("a page's save can't set the server's fields, and only a change to the text or lines opens a sent comment", async () => {
  const { store, save } = await review();
  await save({ body: "Cap the retries." });
  await store.trackComments("pr-1", [{ at: AT, id: "c1", state: "sent", sendN: 1, editedBy: "agent" }]);
  // As Mark pre-existing sends the comment it read, with other values in the server's fields: it stays sent.
  const read = { body: "Cap the retries.", id: "c9", state: "resolved", sendN: 7, claim: CLAIM };
  const kept = { ...AT, body: "Cap the retries.", id: "c1", state: "sent", sendN: 1, editedBy: "agent" };
  expect((await save(read)).draft.comments).toEqual([kept]);
  expect((await save({ ...read, introduced: false, severity: "nit" })).draft.comments).toEqual([{ ...kept, introduced: false, severity: "nit" }]);
  // A new comment starts with none of them, whatever the page says.
  const at3 = { ...AT, line: 3 };
  expect((await save({ ...read, ...at3, editedBy: "agent", body: "And here." })).draft.comments[1]).toEqual({ ...at3, body: "And here." });
  // Its text changed: open, and no longer the agent's edit.
  expect((await save({ ...read, body: "Cap the retries at 5." })).draft.comments[0]).toEqual({ ...AT, body: "Cap the retries at 5.", id: "c1", state: "open", sendN: 1 });
});

test("a ranged sent comment given new lines is open again, and no longer the agent's edit", async () => {
  const { store, save } = await review();
  await save({ line: 2, startLine: 1, body: "Cap the retries." });
  const at = { ...AT, line: 2 };
  await store.trackComments("pr-1", [{ at, id: "c1", state: "sent", sendN: 1, editedBy: "agent" }]);
  expect((await save({ ...at, body: "Cap the retries." })).draft.comments).toEqual([{ ...at, body: "Cap the retries.", id: "c1", state: "open", sendN: 1 }]);
});

test("an agent's edit of a sent comment's text opens it again, and resolved and dismissed comments stay so: only a click changes them", async () => {
  const { store } = await review();
  const at2 = { ...AT, line: 2 }, at3 = { ...AT, line: 3 };
  for (const at of [AT, at2, at3]) await store.upsertDraftComment("pr-1", { ...at, body: "Old.", author: "agent" });
  await store.trackComments("pr-1", [{ at: AT, id: "c1", state: "sent", sendN: 1 }, { at: at2, id: "c2", state: "resolved", sendN: 1 }, { at: at3, id: "c3", state: "dismissed", sendN: 1 }]);
  // A new severity, or the same text, changes nothing for the thread.
  await store.editDraftComment("pr-1", AT, "Old.", "nit");
  expect((await store.getDraft("pr-1")).comments[0].state).toBe("sent");
  await store.editDraftComment("pr-1", AT, "New.");
  for (const at of [at2, at3]) await store.upsertDraftComment("pr-1", { ...at, body: "New.", author: "agent" });
  expect((await store.getDraft("pr-1")).comments.map(({ id, state, body }) => ({ id, state, body }))).toEqual([
    { id: "c1", state: "open", body: "New." }, { id: "c2", state: "resolved", body: "New." }, { id: "c3", state: "dismissed", body: "New." },
  ]);
});

test("trackComments sets only the server's fields, clears one given as undefined, and skips a comment no longer there", async () => {
  const { store } = await review();
  await store.upsertDraftComment("pr-1", { ...AT, body: "Cap the retries." });
  await store.trackComments("pr-1", [{ at: AT, id: "c1", state: "sent", sendN: 2, claim: CLAIM, editedBy: "agent" }, { at: { ...AT, line: 3 }, state: "resolved" }]);
  // A whole comment passed as the change sets its tracking, never its text or place.
  const whole = { at: AT, ...AT, line: 3, body: "Rewritten.", severity: "nit", state: "open", claim: undefined };
  const draft = await store.trackComments("pr-1", [whole as Parameters<typeof store.trackComments>[1][number]]);
  expect(draft.comments).toEqual([{ ...AT, body: "Cap the retries.", id: "c1", state: "open", sendN: 2, editedBy: "agent" }]);
  expect(await store.getDraft("pr-1")).toEqual(draft);
});

test("a tracked comment posts to GitHub as it would untracked", async () => {
  const { store } = await review();
  await store.upsertDraftComment("pr-1", { ...AT, line: 2, startLine: 1, severity: "should-fix", body: "Cap the retries." });
  const untracked = JSON.stringify(toGithubReviewPayload(await store.getDraft("pr-1"), true));
  await store.trackComments("pr-1", [{ at: { ...AT, line: 2 }, id: "c1", state: "sent", sendN: 1, claim: CLAIM, editedBy: "agent" }]);
  expect(JSON.stringify(toGithubReviewPayload(await store.getDraft("pr-1"), true))).toBe(untracked);
});

test("comment ids count up across reviews and Sends from the install's counter, in one turn of the queue each", async () => {
  const { bb, store } = await review();
  const kv = bb.storage.kv;
  const [first, second] = await Promise.all([newCommentIds(store, kv, 2), newCommentIds(store, kv, 1)]);
  expect([...first, ...second]).toEqual(["c1", "c2", "c3"]);
  expect(await store.exclusive((tx) => newCommentIds(tx, kv, 0))).toEqual([]);
  expect(await store.exclusive((tx) => newCommentIds(tx, kv, 2))).toEqual(["c4", "c5"]);
});

test("a counter kv lost, as a reinstall that kept Postgres loses it, starts after the highest id the reviews hold", async () => {
  const { bb, store } = await review();
  await store.upsertDraftComment("pr-1", { ...AT, body: "Cap the retries." });
  await store.trackComments("pr-1", [{ at: AT, id: "c7", state: "sent", sendN: 1 }]);
  await store.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "ready", createdAt: 2 });
  await store.setLifecycle("pr-2", { threadSends: { PRRT_1: { id: "c12", sendN: 2 } }, sends: [{ n: 1, at: 1, threadId: "thr_fix", ids: ["c9"] }, { n: 2, at: 2, threadId: "thr_fix", ids: ["c12"] }] });
  expect(await newCommentIds(store, bb.storage.kv, 1)).toEqual(["c13"]);
  expect(await newCommentIds(store, bb.storage.kv, 1)).toEqual(["c14"]);
});

test("a diff's revisions and hidden files are kept beside its snapshot, and pruned with it", async () => {
  const { store } = await review();
  const files = { revisions: { "a.ts": "rev-a", "b.ts": "rev-b" }, hidden: [{ path: ".env.local", reason: "secret" as const }] };
  expect(await store.getSnapshotFiles("pr-1", "send:1")).toBeNull();
  await store.saveSnapshot("pr-1", "send:1", PATCH);
  await store.saveSnapshotFiles("pr-1", "send:1", files);
  await store.saveSnapshotFiles("pr-1", "send:2", { revisions: {}, hidden: [] });
  expect(await store.getSnapshotFiles("pr-1", "send:1")).toEqual(files);
  expect(await store.getSnapshot("pr-1", "send:1")).toBe(PATCH);
  await store.pruneSnapshots("pr-1", ["send:1"]);
  expect(await store.getSnapshotFiles("pr-1", "send:1")).toEqual(files);
  expect(await store.getSnapshotFiles("pr-1", "send:2")).toBeNull();
  await store.pruneSnapshots("pr-1", []);
  expect([await store.getSnapshot("pr-1", "send:1"), await store.getSnapshotFiles("pr-1", "send:1")]).toEqual([null, null]);
});

test("a review keeps its last 20 Sends and older ones a comment or GitHub thread still names, and its last 100 actions", async () => {
  const { store } = await review();
  await store.upsertDraftComment("pr-1", { ...AT, body: "Cap the retries." });
  await store.trackComments("pr-1", [{ at: AT, id: "c1", state: "sent", sendN: 2 }]);
  const sends: SendEntry[] = Array.from({ length: 25 }, (_, i) => ({ n: i + 1, at: i, threadId: "thr_main", ids: [`c${i + 1}`] }));
  await store.setLifecycle("pr-1", { threadSends: { PRRT_1: { id: "c4", sendN: 4 } } });
  await store.setLifecycle("pr-1", { sends });
  expect((await store.getReview("pr-1"))!.sends!.map((s) => s.n)).toEqual([2, 4, ...Array.from({ length: 20 }, (_, i) => i + 6)]);
  const activity = Array.from({ length: 130 }, (_, i) => ({ at: i, text: `Posted reply ${i}`, asking: "direct" as const }));
  await store.setLifecycle("pr-1", { activity });
  expect((await store.getReview("pr-1"))!.activity).toEqual(activity.slice(30));
  // Another change leaves them be.
  await store.setLifecycle("pr-1", { letPush: true });
  expect((await store.getReview("pr-1"))!.sends).toHaveLength(22);
});

test("1.8.0's lifecycle keys never stand in for a review's own fields, and read back as they were set", async () => {
  const { store } = await review();
  const meta: ReviewMeta = {
    targetKey: "ref-1", kind: "ref", number: 3, repo: "acme/web", title: "T", author: "casey", base: "main", head: "feature", gitRef: "main...feature",
    url: "https://example.test", status: "ready", createdAt: 2, projectId: "p1", headSha: "sha2",
  };
  await store.saveReview(meta);
  const columns = Object.keys((await store.getReview("ref-1"))!);
  const thread = { threadId: "thr_main", environmentId: "env-1", origin: "adopted" as const, since: 3 };
  const fixer = { threadId: "thr_old", environmentId: "env-2", origin: "fresh" as const, since: 2, branch: "bb/fix-review-thr_old" };
  const lifecycle: Required<Pick<ReviewLifecycle, "feature" | "mainThread" | "implementers" | "sends" | "threadSends" | "readyToApprove" | "letPush" | "includeHidden" | "activity">> = {
    feature: { environmentId: "env-1", hostId: "host-1", machine: "MaxBook", path: "/Users/casey/src/web", branch: "feature", baseRef: "main", repo: "acme/web", pausedOn: "other", folderGone: true },
    mainThread: thread,
    implementers: [fixer],
    sends: [{ n: 1, at: 4, threadId: "thr_main", ids: ["c1"], patch: "diff --git a/a.ts b/a.ts\n", readyAt: 5, checkedAt: 6 }],
    threadSends: { PRRT_1: { id: "c2", sendN: 1, claim: CLAIM } },
    readyToApprove: { action: "approve", verdict: "APPROVE", body: "LGTM", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Nice." }], headSha: "sha2", token: "t1", from: "thr_orchestrator", at: 5 },
    letPush: true,
    includeHidden: [".env.local"],
    activity: [{ at: 6, text: "Posted a reply on a.ts:1", asking: "relayed", from: "thr_orchestrator", url: "https://example.test/r" }],
  };
  expect(Object.keys(lifecycle).filter((key) => columns.includes(key))).toEqual([]);
  await store.setLifecycle("ref-1", lifecycle);
  expect(await store.getReview("ref-1")).toEqual({ ...meta, ...lifecycle });
  expect((await store.listReviews()).find((r) => r.targetKey === "ref-1")).toEqual({ ...meta, ...lifecycle });
});
