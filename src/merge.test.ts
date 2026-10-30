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
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
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
  return { store, sql, current };
}

const rows = async (sql: ReturnType<typeof testSql>, table: string, key: string) => (await sql.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE target_key=?`, [key])).length;

test("merging the PR's own review into the folder's moves every table's rows, or joins them, and leaves it archived, empty and pointing there", async () => {
  const { store, sql, current } = await setup();
  const { moved, adopted } = await store.mergeReview(P, S);
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
  for (const table of ["draft_comment_revisions", "discussion_waits", "assessment_items", "assessment_runs", "feedback_threads", "feedback_fetches", "reply_drafts", "agent_comment_changes"]) {
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

test("a review with no agent of its own takes the other's conversation, which goes on there", async () => {
  const { store } = await setup({ agentOnBoth: false });
  const { adopted } = await store.mergeReview(P, S);
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
