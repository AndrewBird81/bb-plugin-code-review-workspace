import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, reanchorDraft, storeOn } from "./store";
import type { Sql } from "./db/sql";
import { renamedPaths } from "./patch";
import { askAt, setAsk } from "./asks";
import { createHash } from "node:crypto";
import { testSql, testStore } from "./test-store.test-support";

// To count reads of a review's renames, which split its whole patch.
vi.mock("./patch", async (original) => {
  const actual = await original<typeof import("./patch")>();
  return { ...actual, renamedPaths: vi.fn(actual.renamedPaths) };
});

function store() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  return testStore(bb);
}

test("review round-trips and lists newest first", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  await s.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "generating", createdAt: 2 });
  expect((await s.getReview("pr-1"))?.number).toBe(1);
  expect((await s.listReviews()).map((r) => r.targetKey)).toEqual(["pr-2", "pr-1"]);
});

test("a saved patch reads back whole", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  await s.savePatch("pr-1", "abcdef");
  expect(await s.patch("pr-1")).toBe("abcdef");
});

test("saveReview round-trips headSha and cwd", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1, headSha: "abc", cwd: "/repo" });
  const meta = await s.getReview("pr-1");
  expect(meta?.headSha).toBe("abc");
  expect(meta?.cwd).toBe("/repo");
});

test("file views upsert, read, and unset", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.setFileViewed("pr-1", "a.ts", "hash-a");
  await s.setFileViewed("pr-1", "a.ts", "hash-a2"); // upsert same file → new hash
  await s.setFileViewed("pr-1", "b.ts", "hash-b");
  const views = await s.getFileViews("pr-1");
  expect(views).toHaveLength(2);
  expect(views.find((v) => v.file === "a.ts")?.hash).toBe("hash-a2");
  await s.unsetFileViewed("pr-1", "a.ts");
  expect((await s.getFileViews("pr-1")).map((v) => v.file)).toEqual(["b.ts"]);
});

test("assistant thread ids round-trip and list", async () => {
  const s = store();
  expect(await s.getAssistantThread("pr-1")).toBeNull();
  await s.setAssistantThread("pr-1", "th_9");
  await s.setAssistantThread("pr-1", "th_10");
  await s.setAssistantThread("pr-2", "th_11");
  expect(await s.getAssistantThread("pr-1")).toBe("th_10");
  expect(await s.listAssistantThreads()).toEqual([{ targetKey: "pr-1", threadId: "th_10" }, { targetKey: "pr-2", threadId: "th_11" }]);
  await s.clearAssistantThread("pr-1");
  expect(await s.getAssistantThread("pr-1")).toBeNull();
});

test("legacy agent messages list oldest-first with context, and clear", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  const insert = `INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES ('pr-1',?,?,?,1)`;
  await testSql(bb).run(insert, ["user", "why flagged?", JSON.stringify({ file: "a.ts", startLine: 3, endLine: 5 })]);
  await testSql(bb).run(insert, ["assistant", "because it's a test file", null]);
  const msgs = await s.listAgentMessages("pr-1");
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[0].context).toEqual({ file: "a.ts", startLine: 3, endLine: 5 });
  expect(msgs[1].context).toBeNull();
  await s.clearAgentMessages("pr-1");
  expect(await s.listAgentMessages("pr-1")).toEqual([]);
});

test("deleteReview clears every per-review table and leaves other reviews intact", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    await s.saveReview({ targetKey: key, kind: "pr", number: 1, status: "ready", createdAt: 1 });
    await s.savePatch(key, "diff --git a/a.ts b/a.ts\n");
    await s.beginGeneration(key);
    await s.saveGuide(key, { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    await s.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
    await s.setFileViewed(key, "a.ts", "hash");
    await s.setAssistantThread(key, `th-${key}`);
    // Legacy conversation rows, from before conversations moved into bb threads.
    await testSql(bb).run(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`, [key, `legacy-${key}`]);
    await testSql(bb).run(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user','question',NULL,1)`, [key]);
    await s.setLifecycle(key, { userArchivedAt: 1 });
    await s.saveReviewerNotes(key, "private", 0);
    await s.setReviewContext(key, "Implements LIN-1");
    await s.addDiscussionMessage(key, { file: "a.ts", line: 1, side: "RIGHT" }, "reviewer", "Why?");
    await s.saveSnapshot(key, "sha1", "diff --git a/a.ts b/a.ts\n");
    await s.saveFeedbackThreads(key, [{ id: "t1", commentId: 1, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
      body: "Fix", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null }], 1);
    await s.saveAssessmentItems(key, "sha1", [{ id: "t1", verdict: "addressed", evidence: "Fixed", assessedAt: 1 }]);
    await s.saveAssessmentRun(key, { headSha: "sha1", summary: "", suggestedVerdict: null, suggestedBody: "", assessedAt: 1 });
    await s.setReplyDraft(key, "t1", "Thanks", "agent");
    await s.backupGuide(key);
    await s.noteAgentCommentChange(key, { file: "a.ts", line: 1, side: "RIGHT", kind: "removed", code: "x", body: "Nit", removed: "Nit" });
  }
  await s.deleteReview("pr-1");

  // Every table keyed by review, including ones added after this test.
  const sql = testSql(bb);
  const keyed = sql.dialect === "postgres"
    ? `SELECT table_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='target_key'`
    : `SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type='table' AND c.name='target_key'`;
  const tables = (await sql.all<{ name: string }>(keyed))
    .map((t) => t.name)
    // A deleted PR stays out of discovery on purpose.
    .filter((name) => name !== "discovery_ignores");
  expect(tables.length).toBeGreaterThan(0);
  const count = async (table: string, key: string) => (await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE target_key=?`, [key]))!.n;
  for (const table of tables) {
    expect({ table, rows: await count(table, "pr-2") }).not.toEqual({ table, rows: 0 });
    expect({ table, rows: await count(table, "pr-1") }).toEqual({ table, rows: 0 });
  }
  expect(await s.getReview("pr-1")).toBeNull();
  expect(await s.getReview("pr-2")).toMatchObject({ userArchivedAt: 1 });
});

test("draft comments upsert and delete", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "updated" });
  let d = await s.getDraft("pr-1");
  expect(d.comments).toHaveLength(1);
  expect(d.comments[0].body).toBe("updated");
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", author: "agent", body: "agent's" });
  d = (await s.editDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT" }, "reworded"))!;
  expect(d.comments[1]).toEqual({ file: "a.ts", line: 2, side: "RIGHT", author: "agent", body: "reworded" });
  expect(await s.editDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT" }, "x")).toBeNull();
  d = (await s.deleteDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT" }))!;
  expect(d.comments.map((c) => c.body)).toEqual(["reworded"]);
  expect(await s.deleteDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT" })).toBeNull();
});

test("the summary keeps who wrote it and the verdicts around it, and a change clears the fields it leaves undefined", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  const written = { verdict: null, comments: "0:811c9dc5" };
  await s.updateSummary("pr-1", { body: "Looks good.", bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  expect(await testStore(bb).getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Looks good.", comments: [], bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  // A comment change keeps the summary's fields.
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  expect(await s.getDraft("pr-1")).toMatchObject({ bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  await s.updateSummary("pr-1", { bodyAuthor: undefined, written: undefined });
  expect(await s.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Looks good.", comments: [{ file: "a.ts", line: 1, side: "RIGHT", body: "x" }], suggestedVerdict: "APPROVE" });
});

test("picking a verdict keeps the summary and its author; a verdict with a body makes the summary the reviewer's", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  const written = { verdict: null, comments: "0:811c9dc5" };
  await s.updateSummary("pr-1", { body: "Agent's words", bodyAuthor: "agent", written, suggestedVerdict: "APPROVE" });
  expect(await s.setVerdict("pr-1", "REQUEST_CHANGES")).toMatchObject({ verdict: "REQUEST_CHANGES", verdictChosen: true, body: "Agent's words", bodyAuthor: "agent", written });
  // A panel from before the summary's own box sends the summary with the verdict; unchanged, it stays the agent's.
  expect(await s.setVerdict("pr-1", "REQUEST_CHANGES", "Agent's words")).toMatchObject({ bodyAuthor: "agent", written });
  const mine = await s.setVerdict("pr-1", "APPROVE", "My words");
  expect(mine).toMatchObject({ verdict: "APPROVE", verdictChosen: true, body: "My words", suggestedVerdict: "APPROVE" });
  expect(mine).not.toHaveProperty("bodyAuthor");
  expect(mine).not.toHaveProperty("written");

  // Submitting the summary and verdict clears them, and what was around them.
  await s.clearSubmittedDraft(await s.getDraft("pr-1"));
  expect(await s.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "", comments: [] });
});

test("a discussion's latest agent change keeps what it replaced, until the reviewer undoes it", async () => {
  const s = store();
  const at = { file: "a.ts", line: 1, side: "RIGHT" } as const;
  await s.noteDiscussionChange("pr-1", at, "added", { body: "x", previous: null });
  // Recorded only where the reviewer started a discussion.
  expect(await s.listDiscussions("pr-1")).toEqual([]);
  await s.addDiscussionMessage("pr-1", at, "reviewer", "Comment here?");
  await s.noteDiscussionChange("pr-1", at, "added", { body: "Added", previous: null });
  expect(await s.lastDiscussionChange("pr-1", at)).toEqual({ kind: "added", body: "Added", previous: null });
  await s.noteDiscussionChange("pr-1", at, "edited", { body: "Edited", previous: { body: "Added", author: "agent" } });
  // A reply after the change doesn't hide it.
  await s.addDiscussionMessage("pr-1", at, "agent", "Done.");
  expect(await s.lastDiscussionChange("pr-1", at)).toEqual({ kind: "edited", body: "Edited", previous: { body: "Added", author: "agent" } });
  await s.noteDiscussionRestored("pr-1", at);
  expect(await s.lastDiscussionChange("pr-1", at)).toBeNull();
  expect((await s.listDiscussions("pr-1"))[0].entries.map((e) => [e.author, e.kind])).toEqual([["reviewer", "message"], ["agent", "added"], ["agent", "edited"], ["agent", "message"], ["reviewer", "restored"]]);
  // Changes recorded before entries kept what they replaced can't be undone.
  await s.noteDiscussionChange("pr-1", at, "removed");
  expect(await s.lastDiscussionChange("pr-1", at)).toBeNull();
});

const thread = (id: string, isResolved: boolean): import("./github/types").FeedbackThread => ({
  id, commentId: 1, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
  body: "Fix this", createdAt: 1, isResolved, resolvedBy: null, isOutdated: false, replies: [], status: isResolved ? "resolved" : "open", replyAt: null,
});

test("feedback threads remember when bb first saw each one resolved", async () => {
  const s = store();
  await s.saveFeedbackThreads("pr-1", [thread("t1", false), thread("t2", true)], 10);
  const first = await s.listFeedbackThreads("pr-1");
  expect(first.find((t) => t.id === "t1")?.resolvedSeenAt).toBeNull();
  const seen = first.find((t) => t.id === "t2")!.resolvedSeenAt!;
  expect(seen).toBeGreaterThan(0);
  await s.saveFeedbackThreads("pr-1", [thread("t2", true)], 20);
  expect(await s.listFeedbackThreads("pr-1")).toMatchObject([{ id: "t2", resolvedSeenAt: seen }]);
  expect(await s.feedbackFetched("pr-1")).toMatchObject({ prUpdatedAt: 20 });
  // Unresolving forgets it.
  await s.saveFeedbackThreads("pr-1", [thread("t2", false)], 30);
  expect((await s.listFeedbackThreads("pr-1"))[0].resolvedSeenAt).toBeNull();
});

/** A Store over the test backend's tables, counting the statements that write `table`. */
function countingWrites(table: string) {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  // Migrated by the Store's own open; counted from here.
  createStore(bb);
  const sql = testSql(bb);
  const counts = { writes: 0 };
  const counted: Sql = {
    dialect: sql.dialect,
    all: (text, params) => sql.all(text, params),
    get: (text, params) => sql.get(text, params),
    run: (text, params) => { if (new RegExp(`^(INSERT INTO|DELETE FROM|UPDATE) ${table}\\b`).test(text)) counts.writes++; return sql.run(text, params); },
    transaction: (fn) => sql.transaction(fn),
  };
  return { s: storeOn(counted), counts };
}

// bug bash H-prod-1: production's review-state poll rewrote unchanged review_lifecycle rows, 55 in 4 minutes, and
// deleted and inserted again unchanged feedback threads.
test("a lifecycle change that changes nothing writes nothing", async () => {
  const { s, counts } = countingWrites("review_lifecycle");
  await s.setLifecycle("pr-1", { turnGroup: "waiting", pushCheckTriedAt: 5 });
  expect(counts.writes).toBe(1);
  await s.setLifecycle("pr-1", { turnGroup: "waiting" });
  await s.setLifecycle("pr-1", {});
  expect(counts.writes).toBe(1);
  await s.setLifecycle("pr-1", { turnGroup: "needs" });
  expect(counts.writes).toBe(2);
});

test("feedback threads saved unchanged aren't written again, though the fetch is recorded", async () => {
  const { s, counts } = countingWrites("feedback_threads");
  expect(await s.saveFeedbackThreads("pr-1", [thread("t1", false), thread("t2", true)], 10)).toBe(true);
  const writes = counts.writes;
  expect(await s.saveFeedbackThreads("pr-1", [thread("t1", false), thread("t2", true)], 20)).toBe(false);
  expect(counts.writes).toBe(writes);
  expect(await s.feedbackFetched("pr-1")).toMatchObject({ prUpdatedAt: 20 });
  expect(await s.saveFeedbackThreads("pr-1", [thread("t2", true)], 30)).toBe(true);
  expect((await s.listFeedbackThreads("pr-1")).map((t) => t.id)).toEqual(["t2"]);
});

test("snapshots, assessments, and reply drafts round-trip", async () => {
  const s = store();
  await s.saveSnapshot("pr-1", "sha1", "one");
  await s.saveSnapshot("pr-1", "sha2", "two");
  await s.pruneSnapshots("pr-1", ["sha2"]);
  expect(await s.getSnapshot("pr-1", "sha1")).toBeNull();
  expect(await s.getSnapshot("pr-1", "sha2")).toBe("two");
  await s.saveAssessmentItems("pr-1", "sha2", [{ id: "t1", verdict: "partial", evidence: "Half", assessedAt: 5 }]);
  await s.saveAssessmentItems("pr-1", "sha2", [{ id: "t1", verdict: "addressed", evidence: "Done", assessedAt: 6 }]);
  await s.saveAssessmentRun("pr-1", { headSha: "sha2", summary: "All good", suggestedVerdict: "APPROVE", suggestedBody: "Thanks", assessedAt: 6 });
  expect(await s.getAssessment("pr-1", "sha2")).toEqual({ items: [{ id: "t1", verdict: "addressed", evidence: "Done", assessedAt: 6 }], run: expect.objectContaining({ summary: "All good" }) });
  expect(await s.getAssessment("pr-1", "sha1")).toEqual({ items: [], run: null });
  expect((await s.latestAssessmentRun("pr-1"))?.headSha).toBe("sha2");
  await s.setReplyDraft("pr-1", "t1", "Fixed, thanks", "agent");
  expect((await s.listReplyDrafts("pr-1")).get("t1")).toMatchObject({ body: "Fixed, thanks", author: "agent" });
  await s.deleteReplyDraft("pr-1", "t1");
  expect((await s.listReplyDrafts("pr-1")).size).toBe(0);
  await s.ignoreDiscovery("pr-1");
  expect(await s.isDiscoveryIgnored("pr-1")).toBe(true);
  await s.unignoreDiscovery("pr-1");
  expect(await s.isDiscoveryIgnored("pr-1")).toBe(false);
});

test("a draft comment remembers its line's text and can move with it", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n context\n+added line\n");
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  expect(await s.draftCommentCode("pr-1", { file: "a.ts", line: 2, side: "RIGHT" })).toBe("added line");
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n context\n+new first\n+added line\n");
  expect(await s.staleDraftComments("pr-1")).toHaveLength(1);
  await s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 3 }]);
  expect((await s.getDraft("pr-1")).comments).toMatchObject([{ line: 3, body: "Why?" }]);
  expect(await s.staleDraftComments("pr-1")).toHaveLength(0);
  expect(await s.draftCommentCode("pr-1", { file: "a.ts", line: 3, side: "RIGHT" })).toBe("added line");
});

test("a discussion follows its draft comment when a rebuild moves it", async () => {
  const s = store();
  const headers = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts"];
  const patch = [...headers, "@@ -1,4 +1,5 @@", " one", "-two", "+two();", "+three();", " four", " five", ""].join("\n");
  // Two lines added at the top: `four` moves from new line 4 to 6.
  const next = [...headers, "@@ -1,4 +1,7 @@", "+zero", "+zero2", " one", "-two", "+two();", "+three();", " four", " five", ""].join("\n");
  await s.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  await s.savePatch("pr-1", patch);
  const at = { file: "a.ts", line: 4, side: "RIGHT" as const };
  await s.upsertDraftComment("pr-1", { ...at, body: "Why?" });
  await s.addDiscussionMessage("pr-1", at, "reviewer", "explain this?");
  await setAsk(s, "pr-1", at, { threadId: "t1", state: "running", at: 1 });

  await s.savePatch("pr-1", next);
  await s.rebaseDraftComments("pr-1", await reanchorDraft(s, "pr-1", patch, next));

  expect((await s.getDraft("pr-1")).comments.map((c) => c.line)).toEqual([6]);
  expect((await s.listDiscussions("pr-1")).map((d) => ({ line: d.line, waiting: d.waiting }))).toEqual([{ line: 6, waiting: true }]);
  expect(askAt(await s.getReview("pr-1"), { ...at, line: 6 })).toMatchObject({ threadId: "t1" });
  expect(askAt(await s.getReview("pr-1"), at)).toBeNull();
});

test("comments that swap lines in a rebuild keep their own discussions", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "on a" });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "on b" });
  await s.addDiscussionMessage("pr-1", { file: "a.ts", line: 1, side: "RIGHT" }, "reviewer", "about a");
  await s.addDiscussionMessage("pr-1", { file: "a.ts", line: 2, side: "RIGHT" }, "agent", "about b");
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+b\n+a\n");
  await s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 1, side: "RIGHT" }, line: 2 }, { at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 1 }]);
  expect((await s.listDiscussions("pr-1")).map((d) => [d.line, d.entries.map((e) => e.body), d.waiting]).sort())
    .toEqual([[1, ["about b"], false], [2, ["about a"], true]]);
});

test("threads already resolved on the first read date from their last activity", async () => {
  const s = store();
  const old = { ...thread("t1", true), createdAt: 100, replies: [{ author: "alice", bot: false, mine: false, body: "Done", createdAt: 500 }] };
  await s.saveFeedbackThreads("pr-1", [old, thread("t2", false)], 1);
  expect((await s.listFeedbackThreads("pr-1")).find((t) => t.id === "t1")?.resolvedSeenAt).toBe(500);
  // Later, a newly resolved thread dates from when bb saw it.
  await s.saveFeedbackThreads("pr-1", [old, { ...thread("t2", true), createdAt: 100 }], 2);
  expect((await s.listFeedbackThreads("pr-1")).find((t) => t.id === "t2")!.resolvedSeenAt).toBeGreaterThan(1_000_000);
});

test("a failed or interrupted rebuild puts the previous guide and diff back", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1", base: "main", head: "feat" });
  await s.savePatch("pr-1", "old patch");
  await s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  await s.backupGuide("pr-1");
  await s.savePatch("pr-1", "new patch");
  await s.saveReview({ ...(await s.getReview("pr-1"))!, headSha: "sha2", status: "generating" });
  await s.beginGeneration("pr-1");
  expect(await s.getGuide("pr-1")).toBeNull();
  await s.interruptGenerations();
  expect((await s.getGuide("pr-1"))?.title).toBe("Old");
  expect(await s.patch("pr-1")).toBe("old patch");
  expect(await s.getReview("pr-1")).toMatchObject({ headSha: "sha1", status: "error" });
  expect(await s.restoreGuide("pr-1")).toBe(false);
});

test("an interruption whose second restore fails puts nothing back, the first restore's savepoint going with the whole transaction", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  for (const k of ["pr-1", "pr-2"]) {
    await s.saveReview({ targetKey: k, kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
    await s.savePatch(k, "old patch");
    await s.saveGuide(k, { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
    await s.backupGuide(k);
    await s.savePatch(k, "new patch");
    await s.saveReview({ ...(await s.getReview(k))!, headSha: "sha2", status: "generating" });
    await s.beginGeneration(k);
  }
  const sql = testSql(bb);
  const run = sql.run.bind(sql);
  let restores = 0;
  const failing = vi.spyOn(sql, "run").mockImplementation(async (text, params) => {
    if (text.startsWith("UPDATE reviews SET head_sha=?") && ++restores === 2) throw new Error("disk full");
    return run(text, params);
  });
  await expect(s.interruptGenerations()).rejects.toThrow("disk full");
  failing.mockRestore();
  expect(restores).toBe(2);
  for (const k of ["pr-1", "pr-2"]) {
    expect([await s.patch(k), await s.getGuide(k), await s.guideBackupHead(k)]).toEqual(["new patch", null, "sha1"]);
    expect(await s.getReview(k)).toMatchObject({ headSha: "sha2", status: "generating" });
  }
  // Tried again, it restores both.
  expect((await s.interruptGenerations()).map((g) => g.targetKey)).toEqual(["pr-1", "pr-2"]);
  expect(await s.getReview("pr-2")).toMatchObject({ headSha: "sha1", status: "error" });
});

test("restoring a guide moves unsent comments back to the restored diff, and never replaces a submitted guide", async () => {
  const s = store();
  const p1 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n context\n+the line\n";
  const p2 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n context\n+new first\n+the line\n";
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
  await s.savePatch("pr-1", p1);
  await s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  await s.backupGuide("pr-1");
  // The rebuild moved the comment onto the new diff, then failed.
  await s.savePatch("pr-1", p2);
  await s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 3 }]);
  await s.beginGeneration("pr-1");
  expect(await s.restoreGuide("pr-1")).toBe(true);
  expect((await s.getDraft("pr-1")).comments).toMatchObject([{ line: 2 }]);
  expect(await s.staleDraftComments("pr-1")).toHaveLength(0);
  // A worker that already submitted its guide keeps it.
  await s.backupGuide("pr-1");
  await s.saveGuide("pr-1", { title: "New", intent: "I", sections: [], unplacedFiles: [] });
  expect(await s.restoreGuide("pr-1")).toBe(false);
  expect((await s.getGuide("pr-1"))?.title).toBe("New");
});

test("restoring a guide moves comments on neighbouring lines back together", async () => {
  const s = store();
  const diff = (lines: string[]) => ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
  await s.savePatch("pr-1", diff(["a", "b", "c"]));
  await s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  await s.backupGuide("pr-1");
  await s.savePatch("pr-1", diff(["x", "a", "b", "c"]));
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", body: "on b" });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "on a" });
  await s.beginGeneration("pr-1");
  expect(await s.restoreGuide("pr-1")).toBe(true);
  expect((await s.getDraft("pr-1")).comments.map((c) => [c.body, c.line])).toEqual([["on b", 2], ["on a", 1]]);
  expect(await s.staleDraftComments("pr-1")).toEqual([]);
});

test("a comment whose new line another comment ends up on stays where it was, drafted against the older diff", async () => {
  const s = store();
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "first" });
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "second" });
  await s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+b\n+b\n");
  await s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 1, side: "RIGHT" }, line: 2 }, { at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 2 }]);
  expect((await s.getDraft("pr-1")).comments.map((c) => [c.body, c.line])).toEqual([["first", 1], ["second", 2]]);
  expect((await s.staleDraftComments("pr-1")).map((c) => c.body)).toEqual(["first"]);
});

test("a thread known to be open and resolved since dates from now, even after an account switch", async () => {
  const s = store();
  await s.saveFeedbackThreads("pr-1", [{ ...thread("t1", false), createdAt: 100 }], 1);
  await s.clearFeedbackFetches();
  await s.saveFeedbackThreads("pr-1", [{ ...thread("t1", true), createdAt: 100 }], 2);
  expect((await s.listFeedbackThreads("pr-1"))[0].resolvedSeenAt).toBeGreaterThan(1_000_000);
});

test("the patch's hash is kept when it's saved, and its positions are parsed once per patch", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  const one = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const two = one.replace("+b", "+c");
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await s.savePatch("pr-1", one);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(await s.patchHash("pr-1")).toBe(sha(one));
  const positions = await s.diffPositions("pr-1");
  expect(positions.get("a.ts")?.right.get(1)).toBe("b");
  expect(await s.diffPositions("pr-1")).toBe(positions);
  await s.savePatch("pr-1", two);
  expect(await s.patchHash("pr-1")).toBe(sha(two));
  expect((await s.diffPositions("pr-1")).get("a.ts")?.right.get(1)).toBe("c");
  // A patch saved before its hash was kept gets one when it's first needed.
  await testSql(bb).run(`UPDATE patches SET hash=NULL`);
  expect(await s.patchHash("pr-1")).toBe(sha(two));
  expect(await s.patchHash("pr-2")).toBe(sha(""));
});

test("a comment's severity round-trips, a draft saved before severities loads with none, and an edit changes or keeps it", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  await testSql(bb).run(`INSERT INTO drafts (target_key,verdict,body,comments) VALUES ('pr-1','COMMENT','',?)`, [JSON.stringify([{ file: "a.ts", line: 1, side: "RIGHT", body: "Old" }])]);
  expect((await s.getDraft("pr-1")).comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", body: "Old" }]);
  await s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Spacing" });
  expect((await s.getDraft("pr-1")).comments[1]).toEqual({ file: "a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Spacing" });
  const at = { file: "a.ts", line: 2, side: "RIGHT" as const };
  await s.editDraftComment("pr-1", at, "Spacing here");
  expect((await s.getDraft("pr-1")).comments[1].severity).toBe("nit");
  await s.editDraftComment("pr-1", at, "Spacing here", "blocking");
  expect((await s.getDraft("pr-1")).comments[1].severity).toBe("blocking");
  await s.editDraftComment("pr-1", at, "Spacing here", null);
  expect((await s.getDraft("pr-1")).comments[1]).toEqual({ ...at, body: "Spacing here" });
});

test("listing discussions reads no patch for a review that has none, as startup does for every review", async () => {
  const s = store();
  const renamed = "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
  for (let i = 0; i < 40; i++) {
    await s.saveReview({ targetKey: `pr-${i}`, kind: "pr", number: i, status: "ready", createdAt: i });
    await s.savePatch(`pr-${i}`, renamed);
  }
  vi.mocked(renamedPaths).mockClear();
  for (const review of await s.listReviews()) expect(await s.listDiscussions(review.targetKey)).toEqual([]);
  expect(renamedPaths).not.toHaveBeenCalled();
  // A review with a discussion still moves it to the file's new path.
  await s.addDiscussionMessage("pr-1", { file: "old.ts", line: 1, side: "RIGHT" }, "reviewer", "why?");
  expect((await s.listDiscussions("pr-1")).map((d) => [d.file, d.waiting])).toEqual([["new.ts", true]]);
  expect(renamedPaths).toHaveBeenCalledTimes(1);
});

test("a stored guide's chapter with the Overview page's id reads back under an id no other chapter has", async () => {
  const s = store();
  const chapter = (id: string, file: string) => ({ id, title: id, overview: "o", diffs: [{ file, summary: "x" }] });
  await s.saveGuide("pr-1", { title: "t", intent: "i", unplacedFiles: [], sections: [chapter("c1", "a.ts"), chapter("overview", "b.ts"), chapter("overview-chapter", "c.ts")] });
  expect((await s.getGuide("pr-1"))?.sections.map((section) => [section.id, section.diffs[0].file])).toEqual([["c1", "a.ts"], ["overview-chapter-2", "b.ts"], ["overview-chapter", "c.ts"]]);
  await s.saveGuide("pr-2", { title: "t", intent: "i", unplacedFiles: [], sections: [chapter("overview", "a.ts")] });
  expect((await s.getGuide("pr-2"))?.sections.map((section) => section.id)).toEqual(["overview-chapter"]);
});

// bug bash D6: a number no store column holds exactly, refused alike by both backends, where SQLite kept a fraction
// as REAL and Postgres refused it as text, or kept one past 2^53 that it then couldn't read.
test("a number parameter that isn't a safe integer is refused before it reaches either backend", async () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = testStore(bb);
  await s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  for (const viewedAt of [1.5, 2 ** 60, Number.NaN]) {
    await expect(s.setFileViewed("pr-1", "a.ts", "h", viewedAt)).rejects.toThrow(RangeError);
  }
  expect(await s.getFileViews("pr-1")).toEqual([]);
});

/** Has `table` refuse rows written to it, on either backend, as Postgres refuses a key past its btree's limit. */
async function refuseWrites(sql: Sql, table: string) {
  if (sql.dialect === "sqlite") {
    for (const event of ["INSERT", "UPDATE"]) await sql.run(`CREATE TRIGGER refuse_${table}_${event} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'index row size exceeds btree maximum'); END`);
  } else {
    await sql.run(`CREATE FUNCTION refuse_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'index row size exceeds btree maximum'; END $$`);
    await sql.run(`CREATE TRIGGER refuse_${table} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_${table}()`);
  }
}

// bug bash D5: the draft was written before the comment's revisions row, which Postgres refuses for a path past about
// 2.7 KB, so a failed save left the comment in the draft with no record of the diff it was drafted on.
test("a comment whose revisions row is refused leaves the draft as it was, and a draft that can't be written leaves the revisions", async () => {
  const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n";
  for (const refused of ["draft_comment_revisions", "drafts"]) {
    const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
    const s = testStore(bb);
    await s.saveReview({ targetKey: "pr-1", kind: "pr", status: "ready", createdAt: 1 });
    await s.savePatch("pr-1", PATCH);
    await s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "Kept" });
    const sql = testSql(bb);
    const revisions = () => sql.all(`SELECT file, line, side, patch_hash, code FROM draft_comment_revisions ORDER BY line`);
    const before = { draft: await s.getDraft("pr-1"), revisions: await revisions() };
    await refuseWrites(sql, refused);
    await expect(s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Not saved" })).rejects.toThrow("index row size exceeds btree maximum");
    expect({ draft: await s.getDraft("pr-1"), revisions: await revisions() }).toEqual(before);
  }
});
