import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { startPlugin } from "./plugin-store.test-support";
import { prReviewKey, reviewNamed, targetKey } from "./targets";
import { toolText } from "./fake-host.test-support";
import { statusWhy } from "../lib/status-line";
import { defaultKnobs } from "../lib/knobs";
import { REVIEW_TABLES, storeOn, type ReviewLifecycle } from "./store";
import { queueStore } from "./store-queue";
import { mergeReviews } from "./merge";
import { assess, describeFeedback } from "./verification";
import { SUMMARY_AT, type DraftComment } from "./draft";
import type { FeedbackThread } from "./github/types";
import { testSql, testStore } from "./test-store.test-support";

// The plugin reads GitHub as it starts: here it can't.
vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn(async () => ({ stdout: "", stderr: "no GitHub here", code: 1 })) }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

const file = (lines: string[], header = "@@ -1,3 +1,4 @@") => ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", header, ...lines, ""].join("\n");
const GONE = "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ b/gone.ts\n@@ -1 +1 @@\n-old\n+new\n";
// The PR's own review read it at an older head; the folder's review, now the PR's, two lines further down.
const PATCH_P = file([" one", "+two", " three", " four"]) + GONE;
const PATCH_S = file(["+zero", "+half", " one", "+two", " three", " four"], "@@ -1,3 +1,6 @@");
const P = "pr-p", S = "br-s";
const at = (line: number, f = "a.ts") => ({ file: f, line, side: "RIGHT" as const });
const comment = (line: number, body: string, extra: Partial<DraftComment> = {}, f = "a.ts"): DraftComment => ({ ...at(line, f), body, ...extra });
const thread = (id: string): FeedbackThread => ({ id, commentId: 1, reviewId: null, path: "a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Fix", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null });

/** The PR's own review P, with something in every table, and the folder's review S that became the PR's. */
async function setup({ agentOnBoth = true } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  const sql = testSql(bb);
  await store.saveReview({ targetKey: P, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 1, headSha: "sha-p" });
  await store.saveReview({ targetKey: S, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt: 2, headSha: "sha-s" });
  await store.savePatch(P, PATCH_P);
  await store.savePatch(S, PATCH_S);
  await store.beginGeneration(P);
  await store.saveGuide(P, { title: "P's guide", sections: [], unplacedFiles: [] } as any);
  await store.setStatus(P, "ready");
  await store.backupGuide(P);
  await store.saveSnapshot(P, "sha-p", PATCH_P);
  await store.saveSnapshot(P, "send:1", PATCH_P);
  await store.saveSnapshotFiles(P, "send:1", { revisions: { "a.ts": "r1" }, hidden: [] });

  // two (line 2) moves to 4; three (3) lands on S's same comment; four (4) on S's other one; gone.ts's is lost.
  await store.upsertDraftComment(P, comment(2, "Why two?", { author: "agent" }));
  await store.upsertDraftComment(P, comment(3, "Same"));
  await store.upsertDraftComment(P, comment(4, "Theirs at four"));
  await store.upsertDraftComment(P, comment(1, "Lost", {}, "gone.ts"));
  await store.trackComments(P, [{ at: at(2), id: "c1", state: "sent", sendN: 1 }, { at: at(3), id: "c2", state: "sent", sendN: 1 }]);
  await store.upsertDraftComment(S, comment(5, "Same"));
  await store.upsertDraftComment(S, comment(6, "Mine at four"));
  await store.trackComments(S, [{ at: at(6), id: "c5", state: "sent", sendN: 2 }]);
  await store.setVerdict(P, "REQUEST_CHANGES");
  await store.updateSummary(P, { body: "Theirs", bodyAuthor: "agent" });
  await store.setVerdict(S, "APPROVE", "Mine");

  await store.addDiscussionMessage(P, at(2), "reviewer", "Really?");
  await store.addDiscussionMessage(P, SUMMARY_AT, "reviewer", "About the summary");
  await store.addDiscussionMessage(P, at(4), "reviewer", "On theirs at four");
  await store.noteAgentCommentChange(P, { ...at(2), kind: "edited", code: "two", body: "Why two?", removed: null });
  await store.noteAgentCommentChange(P, { ...at(1), kind: "removed", code: "one", body: "Nit", removed: "Nit" });
  await store.saveReviewerNotes(P, "P notes", 0);
  await store.saveReviewerNotes(S, "S notes", 0);
  await store.setReviewContext(P, "P context");
  await store.setReviewContext(S, "S context");
  const current = (await store.fileHashes(S)).current(["a.ts"]).get("a.ts")!;
  await store.setFileViewed(S, "a.ts", "stale", 9);
  await store.setFileViewed(P, "a.ts", current, 3);
  await store.setFileViewed(P, "gone.ts", "g", 4);
  await store.saveFeedbackThreads(P, [thread("T1")], 5);
  await store.setReplyDraft(P, "T1", "Thanks", "agent");
  await store.saveAssessmentItems(P, "send:1", [{ id: "c1", verdict: "addressed", evidence: "Fixed", assessedAt: 6 }]);
  await store.saveAssessmentItems(P, "sha-p", [{ id: "T1", verdict: "partial", evidence: "Half", assessedAt: 6 }]);
  await store.saveAssessmentRun(P, { headSha: "sha-p", summary: "Checked", suggestedVerdict: null, suggestedBody: "", assessedAt: 6 });
  await store.setAssistantThread(P, "agent-p");
  if (agentOnBoth) await store.setAssistantThread(S, "agent-s");
  await sql.run(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`, [P, "legacy-p"]);
  await sql.run(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user','Earlier',NULL,1)`, [P]);

  const lifecycleP: ReviewLifecycle = {
    prState: "OPEN", latestHeadSha: "sha-p", watchingSince: 10, watchedHead: "sha-0", notifiedSignal: "re-requested:9", signals: { lastReviewAt: 8 } as any,
    turnGroup: "waiting", preparedSignal: "re-requested:9", autoRunHead: "sha-p", ownPr: false, name: "Their name", pinnedAt: 5,
    mainThread: { threadId: "t-p", environmentId: null, origin: "forked", since: 1 },
    sends: [{ n: 1, at: 100, threadId: "t-p", ids: ["c1", "c2"] }], threadSends: { "gh-1": { id: "c9", sendN: 1 }, "gh-2": { id: "c8", sendN: 1 } },
    activity: [{ at: 50, text: "Posted a reply", asking: "direct" }], submittedAt: 70, submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "sha-p",
  };
  const lifecycleS: ReviewLifecycle = {
    ownPr: true, pinnedAt: 10, mainThread: { threadId: "t-s", environmentId: "env1", origin: "adopted", since: 2 },
    sends: [{ n: 1, at: 20, threadId: "t-s", ids: [] }, { n: 2, at: 30, threadId: "t-s", ids: ["c5"] }], threadSends: { "gh-1": { id: "c6", sendN: 2 } },
    activity: [{ at: 40, text: "Sent", asking: "direct" }, { at: 60, text: "Pushed", asking: "direct" }],
    prOffer: { key: P, number: 7, url: "https://github.com/acme/api/pull/7", moves: { comments: 4, summary: true, sends: 1 } },
  };
  await store.setLifecycle(P, lifecycleP);
  await store.setLifecycle(S, lifecycleS);
  return { bb, harness, store, sql, current };
}

const rows = async (sql: ReturnType<typeof testSql>, table: string, key: string) => (await sql.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE target_key=?`, [key])).length;

test("merging the PR's own review into the folder's moves every table's rows, or joins them, and leaves it archived, empty and pointing there", async () => {
  const { store, sql, current } = await setup();
  const { moved, adopted } = (await store.mergeReview(P, S))!;
  expect(moved).toEqual({ comments: 4, summary: true, sends: 1, verdict: "REQUEST_CHANGES" });
  expect(adopted).toBe(false);
  const tables = new Set<string>();
  const covered = (...names: string[]) => names.forEach((name) => tables.add(name));

  // Comments: moved with their lines, ids and Sends (renumbered after S's two); the same one once; the clashing one in
  // the summary; the lost one kept, drafted against an older diff.
  const draft = await store.getDraft(S);
  expect(draft.comments.map((c) => [c.file, c.line, c.body, c.id, c.state, c.sendN])).toEqual([
    ["a.ts", 5, "Same", "c2", "sent", 3],
    ["a.ts", 6, "Mine at four", "c5", "sent", 2],
    ["a.ts", 4, "Why two?", "c1", "sent", 3],
    ["gone.ts", 1, "Lost", undefined, undefined, undefined],
  ]);
  expect((await store.staleDraftComments(S)).map((c) => c.body)).toEqual(["Lost"]);
  expect(await store.draftCommentCode(S, at(4))).toBe("two");
  expect(draft).toMatchObject({ verdict: "APPROVE", verdictChosen: true, body: "Mine\n\nTheirs\n\n- On `a.ts:4` (an earlier diff): Theirs at four" });
  expect(draft.bodyAuthor).toBeUndefined();
  covered("drafts", "draft_comment_revisions");
  expect((await store.listDiscussions(S)).map((d) => [d.file, d.line, d.waiting, d.entries.map((e) => e.body)])).toEqual([
    ["a.ts", 4, true, ["Really?"]], ["", 0, true, ["About the summary"]],
  ]);
  covered("discussion_entries", "discussion_waits");
  expect((await store.agentCommentChanges(S)).map((c) => [c.kind, c.line])).toEqual([["edited", 4], ["removed", 1]]);
  covered("agent_comment_changes");

  // Sends, their diffs and checks, renumbered; thread Sends from both, the later Send's.
  const review = (await store.getReview(S))!;
  expect(review.sends?.map((send) => [send.n, send.threadId])).toEqual([[1, "t-s"], [2, "t-s"], [3, "t-p"]]);
  expect(review.threadSends).toEqual({ "gh-1": { id: "c9", sendN: 3 }, "gh-2": { id: "c8", sendN: 3 } });
  expect(await store.getSnapshot(S, "send:3")).toBe(PATCH_P);
  expect(await store.getSnapshotFiles(S, "send:3")).toEqual({ revisions: { "a.ts": "r1" }, hidden: [] });
  expect(await store.getSnapshot(S, "sha-p")).toBe(PATCH_P);
  covered("review_snapshots");
  expect((await store.getAssessment(S, "send:3")).items.map((item) => item.id)).toEqual(["c1"]);
  expect(await store.getAssessment(S, "sha-p")).toMatchObject({ items: [{ id: "T1" }], run: { summary: "Checked" } });
  covered("assessment_items", "assessment_runs");
  expect((await store.listFeedbackThreads(S)).map((t) => t.id)).toEqual(["T1"]);
  expect(await store.feedbackFetched(S)).toMatchObject({ prUpdatedAt: 5 });
  expect([...(await store.listReplyDrafts(S)).keys()]).toEqual(["T1"]);
  covered("feedback_threads", "feedback_fetches", "reply_drafts");

  // Notes, context and viewed marks joined: of two marks, the one this diff matches.
  expect((await store.getReviewerNotes(S)).body).toBe("S notes\n\nP notes");
  expect(await store.getReviewContext(S)).toBe("S context\n\nP context");
  expect((await store.getFileViews(S)).map((view) => [view.file, view.hash])).toEqual([["a.ts", current], ["gone.ts", "g"]]);
  covered("reviewer_notes", "review_context", "file_views");

  // The lifecycle: the sync's facts where S had none, so nothing alerts twice; S's main thread, P's an implementer.
  expect(review).toMatchObject({
    prState: "OPEN", latestHeadSha: "sha-p", watchingSince: 10, watchedHead: "sha-0", notifiedSignal: "re-requested:9", turnGroup: "waiting", preparedSignal: "re-requested:9", autoRunHead: "sha-p",
    ownPr: true, name: "Their name", pinnedAt: 5, mainThread: { threadId: "t-s" }, implementers: [{ threadId: "t-p" }],
    submittedAt: 70, submittedVerdict: "REQUEST_CHANGES", prOffer: null,
    mergedFrom: [{ key: P, at: expect.any(Number), id: "api#7", agentThreadId: "agent-p" }],
  });
  expect(review.activity?.map((entry) => entry.at)).toEqual([40, 50, 60]);
  covered("review_lifecycle");
  // S had its own agent: P's stays P's, named in mergedFrom.
  expect(await store.getAssistantThread(S)).toBe("agent-s");
  expect(await store.getAssistantThread(P)).toBe("agent-p");
  covered("assistant_threads");

  // What's left of P.
  expect(await store.getReview(P)).toMatchObject({ archivedAt: expect.any(Number), mergedInto: S, mergedAt: expect.any(Number), sends: [], threadSends: {}, mainThread: null, pinnedAt: null });
  expect(await store.getDraft(P)).toMatchObject({ body: "", comments: [] });
  expect((await store.getReviewerNotes(P)).body).toBe("");
  expect(await store.getReviewContext(P)).toBeNull();
  expect(await store.getFileViews(P)).toEqual([]);
  expect(await store.getSnapshot(P, "send:1")).toBeNull();
  expect(await store.getSnapshot(P, "sha-p")).toBe(PATCH_P);
  for (const table of ["draft_comment_revisions", "discussion_entries", "discussion_waits", "assessment_items", "assessment_runs", "feedback_threads", "feedback_fetches", "reply_drafts", "agent_comment_changes"]) {
    expect(await rows(sql, table, P), table).toBe(0);
  }
  // Its own rows stay with it: the PR's row, its diff, guide, kept guide, generation, and its legacy chat.
  expect(await store.patch(P)).toBe(PATCH_P);
  expect((await store.getGuide(P))?.title).toBe("P's guide");
  expect(await store.guideBackupHead(P)).toBe("sha-p");
  expect(await store.getAgentThread(P)).toBe("legacy-p");
  expect(await store.listAgentMessages(P)).toHaveLength(1);
  expect(await rows(sql, "generations", P)).toBe(1);
  expect(await store.getAgentThread(S)).toBeNull();
  covered("reviews", "patches", "guides", "guide_backups", "generations", "agent_threads", "agent_messages");
  expect([...tables].sort()).toEqual([...REVIEW_TABLES].sort());
});

test("the review that stays keeps its own Not pushed yet and its diffs at commits; only the other's Sends' diffs move over its", async () => {
  const { store } = await setup();
  await store.saveSnapshot(S, "not-pushed", "S's folder");
  await store.saveSnapshotFiles(S, "not-pushed", { revisions: { "a.ts": "s" }, hidden: [] });
  await store.saveSnapshot(S, "sha-p", "S at sha-p");
  await store.saveSnapshot(P, "not-pushed", "P's folder");
  await store.saveSnapshotFiles(P, "not-pushed", { revisions: { "a.ts": "p" }, hidden: [] });
  await store.saveSnapshotFiles(P, "sha-p", { revisions: { "a.ts": "p" }, hidden: [] });
  await store.mergeReview(P, S);
  expect(await store.getSnapshot(S, "not-pushed")).toBe("S's folder");
  expect(await store.getSnapshotFiles(S, "not-pushed")).toEqual({ revisions: { "a.ts": "s" }, hidden: [] });
  expect(await store.getSnapshot(S, "sha-p")).toBe("S at sha-p");
  // One it has none of is copied, as before.
  expect(await store.getSnapshotFiles(S, "sha-p")).toEqual({ revisions: { "a.ts": "p" }, hidden: [] });
  expect(await store.getSnapshot(S, "send:3")).toBe(PATCH_P);

  // With none of its own, it takes none of the other folder's.
  const fresh = await setup();
  await fresh.store.saveSnapshot(P, "not-pushed", "P's folder");
  await fresh.store.saveSnapshotFiles(P, "not-pushed", { revisions: { "a.ts": "p" }, hidden: [] });
  await fresh.store.mergeReview(P, S);
  expect(await fresh.store.getSnapshot(S, "not-pushed")).toBeNull();
  expect(await fresh.store.getSnapshotFiles(S, "not-pushed")).toBeNull();
});

test("a comment a thread tracks, where the review that stays has its own, stays where it was, drafted against an older diff, with its id, state and Send; the tally counts it", async () => {
  const { store, sql } = await setup();
  await store.deleteDraftComment(P, at(2));
  await store.deleteDiscussion(P, at(2));
  // At four, S's other comment; at three, the same as S's, both tracked.
  await store.trackComments(P, [{ at: at(4), id: "c3", state: "sent", sendN: 1 }]);
  await store.trackComments(S, [{ at: at(5), id: "c7", state: "sent", sendN: 2 }]);
  await store.addDiscussionMessage(P, at(3), "reviewer", "On the same");
  await mergeReviews({ bb: createFakePluginHost({ pluginId: "code-review-workspace" }).bb, store, changed: vi.fn() }, P, S);
  const draft = await store.getDraft(S);
  expect(draft.comments.map((c) => [c.line, c.body, c.id, c.state, c.sendN])).toEqual([
    [5, "Same", "c7", "sent", 2], [6, "Mine at four", "c5", "sent", 2], [3, "Same", "c2", "sent", 3], [4, "Theirs at four", "c3", "sent", 3], [1, "Lost", undefined, undefined, undefined],
  ]);
  expect(draft.body).toBe("Mine\n\nTheirs");
  expect((await store.staleDraftComments(S)).map((c) => c.body)).toEqual(["Same", "Theirs at four", "Lost"]);
  expect((await store.listDiscussions(S)).map((d) => [d.line, d.entries.map((e) => e.body)])).toEqual([[0, ["About the summary"]], [4, ["On theirs at four"]], [3, ["On the same"]]]);
  expect(await rows(sql, "discussion_entries", P)).toBe(0);
  // Out with the thread: S's two, P's two and the thread Sends.
  expect((await store.getReview(S))?.fixes).toEqual({ sent: 6, reported: 0, inferred: 0, checked: 0, fixed: 0 });
});

// Review 2's case: P's comment at two moves to four, where P's tracked c3 was; at c3's own new place, S's other comment.
test("a comment a thread tracks that can't stay where it was, its place taken, goes into the summary and stays with its id on the review merged away, where a report on it finds it; the tally counts it", async () => {
  const { bb, harness, store } = await setup();
  await store.trackComments(P, [{ at: at(4), id: "c3", state: "sent", sendN: 1 }]);
  await mergeReviews({ bb, store, changed: vi.fn() }, P, S);
  const draft = await store.getDraft(S);
  expect(draft.comments.map((c) => [c.line, c.body, c.id])).toEqual([[5, "Same", "c2"], [6, "Mine at four", "c5"], [4, "Why two?", "c1"], [1, "Lost", undefined]]);
  expect(draft.body).toBe("Mine\n\nTheirs\n\n- On `a.ts:4` (an earlier diff): Theirs at four");
  expect((await store.getDraft(P)).comments).toEqual([expect.objectContaining({ ...at(4), body: "Theirs at four", id: "c3", state: "sent", sendN: 3 })]);
  // Out with the thread: S's c5, P's c1, c2 and c3, and the thread Sends c9 and c8.
  expect((await store.getReview(S))?.fixes).toEqual({ sent: 6, reported: 0, inferred: 0, checked: 1, fixed: 1 });

  const queued = await startPlugin(bb);
  for (const id of ["c1", "c2", "c5", "c8", "c9"]) expect(await harness.behavior.runCli(["report", id, "done"], {})).toMatchObject({ exitCode: 0 });
  // Not Ready to re-review while c3 is out.
  expect((await queued.getReview(S))?.fixes).toMatchObject({ sent: 6, reported: 5 });
  expect((await queued.getReview(S))?.sends?.every((send) => send.readyAt === undefined)).toBe(true);
  const reported = await harness.behavior.runCli(["report", "c3", "done"], {});
  expect(reported).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^Reported c3 done on api#7\./) });
  expect((await queued.getDraft(P)).comments[0]?.claim).toMatchObject({ outcome: "done" });
  expect((await queued.getReview(S))?.fixes).toMatchObject({ sent: 6, reported: 6 });
  expect((await queued.getReview(S))?.sends?.every((send) => send.readyAt !== undefined)).toBe(true);
});

test("Check fixes lists a tracked comment left on the review merged away and records what it found of it, its inferred report there", async () => {
  const { bb, store } = await setup();
  await store.trackComments(P, [{ at: at(4), id: "c3", state: "sent", sendN: 1 }]);
  await mergeReviews({ bb, store, changed: vi.fn() }, P, S);
  const review = (await store.getReview(S))!;
  expect(await describeFeedback(store, review)).toMatch(/\[c3\] a\.ts:4 · Send 3 · not reported/);
  expect((await assess(store, review, { items: [{ id: "c3", verdict: "addressed", evidence: "Fixed in a.ts", claimed: "done" }] }, "agent-s")).ok).toBe(true);
  expect((await store.getDraft(P)).comments[0]?.claim).toMatchObject({ outcome: "done", inferred: true });
  expect((await store.getReview(S))?.fixes).toEqual({ sent: 6, reported: 0, inferred: 1, checked: 2, fixed: 2 });
});

test("a comment not on GitHub yet of the review merged away goes into your notes, from its old id, never the summary Submit posts; tracked, it stays with its id there too", async () => {
  const { store } = await setup();
  await store.saveSnapshot(P, "not-pushed", PATCH_P);
  await store.upsertDraftComment(P, { file: "a.ts", line: 2, side: "LOCAL", body: "Folder's" });
  await store.upsertDraftComment(P, { file: "a.ts", line: 3, side: "LOCAL", body: "Sent from the folder" });
  await store.trackComments(P, [{ at: { file: "a.ts", line: 3, side: "LOCAL" }, id: "c4", state: "sent", sendN: 1 }]);
  await store.mergeReview(P, S);
  const draft = await store.getDraft(S);
  expect(draft.comments.some((c) => c.side === "LOCAL")).toBe(false);
  expect(draft.body).toBe("Mine\n\nTheirs\n\n- On `a.ts:4` (an earlier diff): Theirs at four");
  expect((await store.getReviewerNotes(S)).body).toBe("S notes\n\nP notes\n\nNot on GitHub yet, from `api#7`:\n- On `a.ts:2` (an earlier diff): Folder's\n- On `a.ts:3` (an earlier diff): Sent from the folder");
  expect((await store.getDraft(P)).comments).toEqual([expect.objectContaining({ file: "a.ts", line: 3, side: "LOCAL", id: "c4", sendN: 3 })]);
});

test("a review with no agent of its own takes the other's conversation, which goes on there", async () => {
  const { store } = await setup({ agentOnBoth: false });
  const { adopted } = (await store.mergeReview(P, S))!;
  expect(adopted).toBe(true);
  expect(await store.getAssistantThread(S)).toBe("agent-p");
  expect(await store.getAssistantThread(P)).toBeNull();
  expect((await store.getReview(S))?.mergedFrom).toEqual([{ key: P, at: expect.any(Number), id: "api#7", agentThreadId: null }]);
});

test("a merge that fails partway changes nothing", async () => {
  const { store, sql } = await setup();
  const before = { p: await store.getDraft(P), s: await store.getDraft(S), review: await store.getReview(S), views: await store.getFileViews(S) };
  await expect(store.mergeReview(P, "br-missing")).rejects.toThrow("Review not found.");
  // The connection drops late in the merge, once the comments, summary and marks are written: all of it rolls back.
  const dropping: typeof sql = { ...sql, run: (text, params) => /INSERT INTO feedback_threads/.test(text) ? Promise.reject(new Error("Connection terminated unexpectedly")) : sql.run(text, params) };
  await expect(queueStore(storeOn(dropping)).mergeReview(P, S)).rejects.toThrow("Connection terminated unexpectedly");
  expect(await store.getDraft(P)).toEqual(before.p);
  expect(await store.getDraft(S)).toEqual(before.s);
  expect(await store.getReview(S)).toEqual(before.review);
  expect(await store.getFileViews(S)).toEqual(before.views);
  expect((await store.getReview(P))?.mergedInto).toBeUndefined();
});

test("a review merged into one that was merged in turn names the last: its PR's key, its key and its ids lead there", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const store = testStore(bb);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  for (const [k, createdAt] of [[prKey, 1], ["br-b", 2], ["br-c", 3]] as const) {
    await store.saveReview({ targetKey: k, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", status: "ready", createdAt });
  }
  await store.setLifecycle(prKey, { mergedInto: "br-b", archivedAt: 5 });
  await store.setLifecycle("br-b", { mergedInto: "br-c", archivedAt: 6 });
  expect(await prReviewKey(store, { repo: "acme/api", number: 7 })).toBe("br-c");
  for (const named of [prKey, "br-b"]) expect((await reviewNamed(store, bb, named))?.targetKey, named).toBe("br-c");
  // A merge that points back, which the store never makes, still ends.
  await store.setLifecycle("br-c", { mergedInto: prKey, archivedAt: 7 });
  expect(await prReviewKey(store, { repo: "acme/api", number: 7 })).toMatch(/^(pr-|br-)/);
});

// Two triggers, or two windows' Merge into one review, can reach the same merge at once.
test("merging twice, at once or later, merges once: nothing is copied again, what moved is kept, and the agent is told once", async () => {
  const { store } = await setup();
  await store.setLifecycle(S, { became: { at: 1, number: 7, url: "https://github.com/acme/api/pull/7", from: "api:feat", carried: 2, local: 0, outside: 0 } });
  const deps = { bb: createFakePluginHost({ pluginId: "code-review-workspace" }).bb, store, changed: vi.fn() };
  expect(await Promise.all([mergeReviews(deps, P, S), mergeReviews(deps, P, S)])).toEqual([true, false]);
  const merged = (await store.getReview(S))!;
  expect(merged.mergedFrom).toHaveLength(1);
  expect(merged.activity?.map((entry) => entry.at)).toEqual([40, 50, 60]);
  expect(merged.became?.merged).toEqual({ comments: 4, summary: true, sends: 1, verdict: "REQUEST_CHANGES" });
  // The agent took its note; merged again, it isn't told again.
  expect(merged.agentPrNote).toMatchObject({ number: 7 });
  await store.setLifecycle(S, { agentPrNote: null });
  const draft = await store.getDraft(S);
  expect(await mergeReviews(deps, P, S)).toBe(false);
  expect(await store.getReview(S)).toMatchObject({ agentPrNote: null, mergedFrom: [{ key: P }], became: { merged: { comments: 4 } } });
  expect(await store.getDraft(S)).toEqual(draft);
  // Nor into a review that was itself merged away.
  expect(await store.mergeReview("br-s", P)).toBeNull();
  expect((await store.getReview(S))?.mergedInto).toBeUndefined();
});

test("what's left of a merged review: its page opens the one it went into, Archive says so, its ids and link lead there, and its agent's tools say where the reviewer went", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: { threads: { get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }), update: async () => ({}) } } as any });
  const store = await startPlugin(bb);
  const prKey = targetKey({ kind: "pr", repo: "acme/api", number: 7 });
  for (const [k, createdAt] of [[prKey, 1], [S, 2]] as const) {
    await store.saveReview({ targetKey: k, kind: "pr", repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7", title: "Snooze checks", status: "ready", createdAt });
    await store.savePatch(k, PATCH_S);
  }
  await store.setAssistantThread(prKey, "agent-p");
  await store.setAssistantThread(S, "agent-s");
  await mergeReviews({ bb, store, changed: vi.fn() }, prKey, S);
  // S's agent is told once, by its review tools' next answer if no message of the review's reaches it first.
  const note = "This review is PR #7: https://github.com/acme/api/pull/7. Since your last turn it and the PR's other review were merged into one: the comments, summaries and Sends of both are here now. Treat it as that PR.";
  const patchRead = async () => toolText(await harness.behavior.callAgentTool("read_review_patch", { targetKey: S }, { threadId: "agent-s" }));
  expect(await patchRead()).toBe(`${note}\n\n${PATCH_S}`);
  expect(await patchRead()).toBe(PATCH_S);

  expect(await harness.behavior.callRpc("getReviewBundle", { targetKey: prKey })).toMatchObject({ review: null, mergedInto: { targetKey: S, id: "api#7" } });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: any[] };
  expect(reviews.find((review: any) => review.targetKey === prKey)).toMatchObject({ mergedIntoId: "api#7", turn: { group: "archive", reason: "merged-into" } });
  expect(statusWhy(reviews.find((review: any) => review.targetKey === prKey), defaultKnobs)?.text).toBe("Merged into api#7");
  for (const named of [prKey, "api#7", "https://github.com/acme/api/pull/7"]) expect((await reviewNamed(store, bb, named))?.targetKey, named).toBe(S);
  expect(await prReviewKey(store, { repo: "acme/api", number: 7 })).toBe(S);

  const away = "This review was merged into `api#7`. The reviewer continues there.";
  for (const [tool, input] of [["list_draft_comments", {}], ["read_review_patch", { targetKey: prKey }], ["list_feedback", {}]] as const) {
    expect(toolText(await harness.behavior.callAgentTool(tool, input, { threadId: "agent-p" })), tool).toBe(away);
  }
  expect(toolText(await harness.behavior.callAgentTool("list_draft_comments", {}, { threadId: "agent-s" }))).not.toBe(away);
});
