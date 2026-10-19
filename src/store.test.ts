import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, reanchorAll } from "./store";
import { renamedPaths } from "./patch";
import { askAt, setAsk } from "./asks";
import { createHash } from "node:crypto";

// To count reads of a review's renames, which split its whole patch.
vi.mock("./patch", async (original) => {
  const actual = await original<typeof import("./patch")>();
  return { ...actual, renamedPaths: vi.fn(actual.renamedPaths) };
});

function store() {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  return createStore(bb);
}

test("review round-trips and lists newest first", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "generating", createdAt: 2 });
  expect(s.getReview("pr-1")?.number).toBe(1);
  expect(s.listReviews().map((r) => r.targetKey)).toEqual(["pr-2", "pr-1"]);
});

test("a saved patch reads back whole", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.savePatch("pr-1", "abcdef");
  expect(s.patch("pr-1")).toBe("abcdef");
});

test("saveReview round-trips headSha and cwd", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1, headSha: "abc", cwd: "/repo" });
  const meta = s.getReview("pr-1");
  expect(meta?.headSha).toBe("abc");
  expect(meta?.cwd).toBe("/repo");
});

test("file views upsert, read, and unset", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.setFileViewed("pr-1", "a.ts", "hash-a");
  s.setFileViewed("pr-1", "a.ts", "hash-a2"); // upsert same file → new hash
  s.setFileViewed("pr-1", "b.ts", "hash-b");
  const views = s.getFileViews("pr-1");
  expect(views).toHaveLength(2);
  expect(views.find((v) => v.file === "a.ts")?.hash).toBe("hash-a2");
  s.unsetFileViewed("pr-1", "a.ts");
  expect(s.getFileViews("pr-1").map((v) => v.file)).toEqual(["b.ts"]);
});

test("assistant thread ids round-trip and list", () => {
  const s = store();
  expect(s.getAssistantThread("pr-1")).toBeNull();
  s.setAssistantThread("pr-1", "th_9");
  s.setAssistantThread("pr-1", "th_10");
  s.setAssistantThread("pr-2", "th_11");
  expect(s.getAssistantThread("pr-1")).toBe("th_10");
  expect(s.listAssistantThreads()).toEqual([{ targetKey: "pr-1", threadId: "th_10" }, { targetKey: "pr-2", threadId: "th_11" }]);
  s.clearAssistantThread("pr-1");
  expect(s.getAssistantThread("pr-1")).toBeNull();
});

test("legacy agent messages list oldest-first with context, and clear", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = createStore(bb);
  const insert = bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES ('pr-1',?,?,?,1)`);
  insert.run("user", "why flagged?", JSON.stringify({ file: "a.ts", startLine: 3, endLine: 5 }));
  insert.run("assistant", "because it's a test file", null);
  const msgs = s.listAgentMessages("pr-1");
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[0].context).toEqual({ file: "a.ts", startLine: 3, endLine: 5 });
  expect(msgs[1].context).toBeNull();
  s.clearAgentMessages("pr-1");
  expect(s.listAgentMessages("pr-1")).toEqual([]);
});

test("deleteReview clears every per-review table and leaves other reviews intact", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = createStore(bb);
  for (const key of ["pr-1", "pr-2"]) {
    s.saveReview({ targetKey: key, kind: "pr", number: 1, status: "ready", createdAt: 1 });
    s.savePatch(key, "diff --git a/a.ts b/a.ts\n");
    s.beginGeneration(key);
    s.saveGuide(key, { title: "T", intent: "I", sections: [], unplacedFiles: [] });
    s.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
    s.setFileViewed(key, "a.ts", "hash");
    s.setAssistantThread(key, `th-${key}`);
    // Legacy conversation rows, from before conversations moved into bb threads.
    bb.storage.database().prepare(`INSERT INTO agent_threads (target_key,thread_id,created_at) VALUES (?,?,1)`).run(key, `legacy-${key}`);
    bb.storage.database().prepare(`INSERT INTO agent_messages (target_key,role,text,context,created_at) VALUES (?,'user','question',NULL,1)`).run(key);
    s.setLifecycle(key, { userArchivedAt: 1 });
    s.saveReviewerNotes(key, "private", 0);
    s.setReviewContext(key, "Implements LIN-1");
    s.addDiscussionMessage(key, { file: "a.ts", line: 1, side: "RIGHT" }, "reviewer", "Why?");
    s.saveSnapshot(key, "sha1", "diff --git a/a.ts b/a.ts\n");
    s.saveFeedbackThreads(key, [{ id: "t1", commentId: 1, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
      body: "Fix", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null }], 1);
    s.saveAssessmentItems(key, "sha1", [{ id: "t1", verdict: "addressed", evidence: "Fixed", assessedAt: 1 }]);
    s.saveAssessmentRun(key, { headSha: "sha1", summary: "", suggestedVerdict: null, suggestedBody: "", assessedAt: 1 });
    s.setReplyDraft(key, "t1", "Thanks", "agent");
    s.backupGuide(key);
    s.noteAgentCommentChange(key, { file: "a.ts", line: 1, side: "RIGHT", kind: "removed", code: "x", body: "Nit", removed: "Nit" });
  }
  s.deleteReview("pr-1");

  // Every table keyed by review, including ones added after this test.
  const db = bb.storage.database();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name)
    .filter((name) => (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === "target_key"))
    // A deleted PR stays out of discovery on purpose.
    .filter((name) => name !== "discovery_ignores");
  expect(tables.length).toBeGreaterThan(0);
  const count = (table: string, key: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE target_key=?`).get(key) as { n: number }).n;
  for (const table of tables) {
    expect({ table, rows: count(table, "pr-2") }).not.toEqual({ table, rows: 0 });
    expect({ table, rows: count(table, "pr-1") }).toEqual({ table, rows: 0 });
  }
  expect(s.getReview("pr-1")).toBeNull();
  expect(s.getReview("pr-2")).toMatchObject({ userArchivedAt: 1 });
});

test("draft comments upsert and delete", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "updated" });
  let d = s.getDraft("pr-1");
  expect(d.comments).toHaveLength(1);
  expect(d.comments[0].body).toBe("updated");
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", author: "agent", body: "agent's" });
  d = s.editDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT" }, "reworded")!;
  expect(d.comments[1]).toEqual({ file: "a.ts", line: 2, side: "RIGHT", author: "agent", body: "reworded" });
  expect(s.editDraftComment("pr-1", { file: "a.ts", line: 2, side: "LEFT" }, "x")).toBeNull();
  d = s.deleteDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT" })!;
  expect(d.comments.map((c) => c.body)).toEqual(["reworded"]);
  expect(s.deleteDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT" })).toBeNull();
});

test("the summary keeps who wrote it and the verdicts around it, and a change clears the fields it leaves undefined", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = createStore(bb);
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  const written = { verdict: null, comments: "0:811c9dc5" };
  s.updateSummary("pr-1", { body: "Looks good.", bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  expect(createStore(bb).getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Looks good.", comments: [], bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  // A comment change keeps the summary's fields.
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  expect(s.getDraft("pr-1")).toMatchObject({ bodyAuthor: "agent", suggestedVerdict: "APPROVE", written });
  s.updateSummary("pr-1", { bodyAuthor: undefined, written: undefined });
  expect(s.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "Looks good.", comments: [{ file: "a.ts", line: 1, side: "RIGHT", body: "x" }], suggestedVerdict: "APPROVE" });
});

test("picking a verdict keeps the summary and its author; a verdict with a body makes the summary the reviewer's", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  const written = { verdict: null, comments: "0:811c9dc5" };
  s.updateSummary("pr-1", { body: "Agent's words", bodyAuthor: "agent", written, suggestedVerdict: "APPROVE" });
  expect(s.setVerdict("pr-1", "REQUEST_CHANGES")).toMatchObject({ verdict: "REQUEST_CHANGES", verdictChosen: true, body: "Agent's words", bodyAuthor: "agent", written });
  // A panel from before the summary's own box sends the summary with the verdict; unchanged, it stays the agent's.
  expect(s.setVerdict("pr-1", "REQUEST_CHANGES", "Agent's words")).toMatchObject({ bodyAuthor: "agent", written });
  const mine = s.setVerdict("pr-1", "APPROVE", "My words");
  expect(mine).toMatchObject({ verdict: "APPROVE", verdictChosen: true, body: "My words", suggestedVerdict: "APPROVE" });
  expect(mine).not.toHaveProperty("bodyAuthor");
  expect(mine).not.toHaveProperty("written");

  // Submitting the summary and verdict clears them, and what was around them.
  s.clearSubmittedDraft(s.getDraft("pr-1"));
  expect(s.getDraft("pr-1")).toEqual({ targetKey: "pr-1", verdict: "COMMENT", body: "", comments: [] });
});

test("a discussion's latest agent change keeps what it replaced, until the reviewer undoes it", () => {
  const s = store();
  const at = { file: "a.ts", line: 1, side: "RIGHT" } as const;
  s.noteDiscussionChange("pr-1", at, "added", { body: "x", previous: null });
  // Recorded only where the reviewer started a discussion.
  expect(s.listDiscussions("pr-1")).toEqual([]);
  s.addDiscussionMessage("pr-1", at, "reviewer", "Comment here?");
  s.noteDiscussionChange("pr-1", at, "added", { body: "Added", previous: null });
  expect(s.lastDiscussionChange("pr-1", at)).toEqual({ kind: "added", body: "Added", previous: null });
  s.noteDiscussionChange("pr-1", at, "edited", { body: "Edited", previous: { body: "Added", author: "agent" } });
  // A reply after the change doesn't hide it.
  s.addDiscussionMessage("pr-1", at, "agent", "Done.");
  expect(s.lastDiscussionChange("pr-1", at)).toEqual({ kind: "edited", body: "Edited", previous: { body: "Added", author: "agent" } });
  s.noteDiscussionRestored("pr-1", at);
  expect(s.lastDiscussionChange("pr-1", at)).toBeNull();
  expect(s.listDiscussions("pr-1")[0].entries.map((e) => [e.author, e.kind])).toEqual([["reviewer", "message"], ["agent", "added"], ["agent", "edited"], ["agent", "message"], ["reviewer", "restored"]]);
  // Changes recorded before entries kept what they replaced can't be undone.
  s.noteDiscussionChange("pr-1", at, "removed");
  expect(s.lastDiscussionChange("pr-1", at)).toBeNull();
});

const thread = (id: string, isResolved: boolean): import("./github/types").FeedbackThread => ({
  id, commentId: 1, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
  body: "Fix this", createdAt: 1, isResolved, resolvedBy: null, isOutdated: false, replies: [], status: isResolved ? "resolved" : "open", replyAt: null,
});

test("feedback threads remember when bb first saw each one resolved", () => {
  const s = store();
  s.saveFeedbackThreads("pr-1", [thread("t1", false), thread("t2", true)], 10);
  const first = s.listFeedbackThreads("pr-1");
  expect(first.find((t) => t.id === "t1")?.resolvedSeenAt).toBeNull();
  const seen = first.find((t) => t.id === "t2")!.resolvedSeenAt!;
  expect(seen).toBeGreaterThan(0);
  s.saveFeedbackThreads("pr-1", [thread("t2", true)], 20);
  expect(s.listFeedbackThreads("pr-1")).toMatchObject([{ id: "t2", resolvedSeenAt: seen }]);
  expect(s.feedbackFetched("pr-1")).toMatchObject({ prUpdatedAt: 20 });
  // Unresolving forgets it.
  s.saveFeedbackThreads("pr-1", [thread("t2", false)], 30);
  expect(s.listFeedbackThreads("pr-1")[0].resolvedSeenAt).toBeNull();
});

test("snapshots, assessments, and reply drafts round-trip", () => {
  const s = store();
  s.saveSnapshot("pr-1", "sha1", "one");
  s.saveSnapshot("pr-1", "sha2", "two");
  s.pruneSnapshots("pr-1", ["sha2"]);
  expect(s.getSnapshot("pr-1", "sha1")).toBeNull();
  expect(s.getSnapshot("pr-1", "sha2")).toBe("two");
  s.saveAssessmentItems("pr-1", "sha2", [{ id: "t1", verdict: "partial", evidence: "Half", assessedAt: 5 }]);
  s.saveAssessmentItems("pr-1", "sha2", [{ id: "t1", verdict: "addressed", evidence: "Done", assessedAt: 6 }]);
  s.saveAssessmentRun("pr-1", { headSha: "sha2", summary: "All good", suggestedVerdict: "APPROVE", suggestedBody: "Thanks", assessedAt: 6 });
  expect(s.getAssessment("pr-1", "sha2")).toEqual({ items: [{ id: "t1", verdict: "addressed", evidence: "Done", assessedAt: 6 }], run: expect.objectContaining({ summary: "All good" }) });
  expect(s.getAssessment("pr-1", "sha1")).toEqual({ items: [], run: null });
  expect(s.latestAssessmentRun("pr-1")?.headSha).toBe("sha2");
  s.setReplyDraft("pr-1", "t1", "Fixed, thanks", "agent");
  expect(s.listReplyDrafts("pr-1").get("t1")).toMatchObject({ body: "Fixed, thanks", author: "agent" });
  s.deleteReplyDraft("pr-1", "t1");
  expect(s.listReplyDrafts("pr-1").size).toBe(0);
  s.ignoreDiscovery("pr-1");
  expect(s.isDiscoveryIgnored("pr-1")).toBe(true);
  s.unignoreDiscovery("pr-1");
  expect(s.isDiscoveryIgnored("pr-1")).toBe(false);
});

test("a draft comment remembers its line's text and can move with it", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n context\n+added line\n");
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  expect(s.draftCommentCode("pr-1", { file: "a.ts", line: 2, side: "RIGHT" })).toBe("added line");
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n context\n+new first\n+added line\n");
  expect(s.staleDraftComments("pr-1")).toHaveLength(1);
  s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 3 }]);
  expect(s.getDraft("pr-1").comments).toMatchObject([{ line: 3, body: "Why?" }]);
  expect(s.staleDraftComments("pr-1")).toHaveLength(0);
  expect(s.draftCommentCode("pr-1", { file: "a.ts", line: 3, side: "RIGHT" })).toBe("added line");
});

test("a discussion follows its draft comment when a rebuild moves it", () => {
  const s = store();
  const headers = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts"];
  const patch = [...headers, "@@ -1,4 +1,5 @@", " one", "-two", "+two();", "+three();", " four", " five", ""].join("\n");
  // Two lines added at the top: `four` moves from new line 4 to 6.
  const next = [...headers, "@@ -1,4 +1,7 @@", "+zero", "+zero2", " one", "-two", "+two();", "+three();", " four", " five", ""].join("\n");
  s.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  s.savePatch("pr-1", patch);
  const at = { file: "a.ts", line: 4, side: "RIGHT" as const };
  s.upsertDraftComment("pr-1", { ...at, body: "Why?" });
  s.addDiscussionMessage("pr-1", at, "reviewer", "explain this?");
  setAsk(s, "pr-1", at, { threadId: "t1", state: "running", at: 1 });

  s.savePatch("pr-1", next);
  s.rebaseDraftComments("pr-1", reanchorAll(s, "pr-1", patch, next));

  expect(s.getDraft("pr-1").comments.map((c) => c.line)).toEqual([6]);
  expect(s.listDiscussions("pr-1").map((d) => ({ line: d.line, waiting: d.waiting }))).toEqual([{ line: 6, waiting: true }]);
  expect(askAt(s.getReview("pr-1"), { ...at, line: 6 })).toMatchObject({ threadId: "t1" });
  expect(askAt(s.getReview("pr-1"), at)).toBeNull();
});

test("comments that swap lines in a rebuild keep their own discussions", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "on a" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "on b" });
  s.addDiscussionMessage("pr-1", { file: "a.ts", line: 1, side: "RIGHT" }, "reviewer", "about a");
  s.addDiscussionMessage("pr-1", { file: "a.ts", line: 2, side: "RIGHT" }, "agent", "about b");
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+b\n+a\n");
  s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 1, side: "RIGHT" }, line: 2 }, { at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 1 }]);
  expect(s.listDiscussions("pr-1").map((d) => [d.line, d.entries.map((e) => e.body), d.waiting]).sort())
    .toEqual([[1, ["about b"], false], [2, ["about a"], true]]);
});

test("threads already resolved on the first read date from their last activity", () => {
  const s = store();
  const old = { ...thread("t1", true), createdAt: 100, replies: [{ author: "alice", bot: false, mine: false, body: "Done", createdAt: 500 }] };
  s.saveFeedbackThreads("pr-1", [old, thread("t2", false)], 1);
  expect(s.listFeedbackThreads("pr-1").find((t) => t.id === "t1")?.resolvedSeenAt).toBe(500);
  // Later, a newly resolved thread dates from when bb saw it.
  s.saveFeedbackThreads("pr-1", [old, { ...thread("t2", true), createdAt: 100 }], 2);
  expect(s.listFeedbackThreads("pr-1").find((t) => t.id === "t2")!.resolvedSeenAt).toBeGreaterThan(1_000_000);
});

test("a failed or interrupted rebuild puts the previous guide and diff back", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1", base: "main", head: "feat" });
  s.savePatch("pr-1", "old patch");
  s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  s.backupGuide("pr-1");
  s.savePatch("pr-1", "new patch");
  s.saveReview({ ...s.getReview("pr-1")!, headSha: "sha2", status: "generating" });
  s.beginGeneration("pr-1");
  expect(s.getGuide("pr-1")).toBeNull();
  s.interruptGenerations();
  expect(s.getGuide("pr-1")?.title).toBe("Old");
  expect(s.patch("pr-1")).toBe("old patch");
  expect(s.getReview("pr-1")).toMatchObject({ headSha: "sha1", status: "error" });
  expect(s.restoreGuide("pr-1")).toBe(false);
});

test("restoring a guide moves unsent comments back to the restored diff, and never replaces a submitted guide", () => {
  const s = store();
  const p1 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n context\n+the line\n";
  const p2 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n context\n+new first\n+the line\n";
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
  s.savePatch("pr-1", p1);
  s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "Why?" });
  s.backupGuide("pr-1");
  // The rebuild moved the comment onto the new diff, then failed.
  s.savePatch("pr-1", p2);
  s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 3 }]);
  s.beginGeneration("pr-1");
  expect(s.restoreGuide("pr-1")).toBe(true);
  expect(s.getDraft("pr-1").comments).toMatchObject([{ line: 2 }]);
  expect(s.staleDraftComments("pr-1")).toHaveLength(0);
  // A worker that already submitted its guide keeps it.
  s.backupGuide("pr-1");
  s.saveGuide("pr-1", { title: "New", intent: "I", sections: [], unplacedFiles: [] });
  expect(s.restoreGuide("pr-1")).toBe(false);
  expect(s.getGuide("pr-1")?.title).toBe("New");
});

test("restoring a guide moves comments on neighbouring lines back together", () => {
  const s = store();
  const diff = (lines: string[]) => ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1, headSha: "sha1" });
  s.savePatch("pr-1", diff(["a", "b", "c"]));
  s.saveGuide("pr-1", { title: "Old", intent: "I", sections: [], unplacedFiles: [] });
  s.backupGuide("pr-1");
  s.savePatch("pr-1", diff(["x", "a", "b", "c"]));
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 3, side: "RIGHT", body: "on b" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "on a" });
  s.beginGeneration("pr-1");
  expect(s.restoreGuide("pr-1")).toBe(true);
  expect(s.getDraft("pr-1").comments.map((c) => [c.body, c.line])).toEqual([["on b", 2], ["on a", 1]]);
  expect(s.staleDraftComments("pr-1")).toEqual([]);
});

test("a comment whose new line another comment ends up on stays where it was, drafted against the older diff", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "first" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", body: "second" });
  s.savePatch("pr-1", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+b\n+b\n");
  s.rebaseDraftComments("pr-1", [{ at: { file: "a.ts", line: 1, side: "RIGHT" }, line: 2 }, { at: { file: "a.ts", line: 2, side: "RIGHT" }, line: 2 }]);
  expect(s.getDraft("pr-1").comments.map((c) => [c.body, c.line])).toEqual([["first", 1], ["second", 2]]);
  expect(s.staleDraftComments("pr-1").map((c) => c.body)).toEqual(["first"]);
});

test("a thread known to be open and resolved since dates from now, even after an account switch", () => {
  const s = store();
  s.saveFeedbackThreads("pr-1", [{ ...thread("t1", false), createdAt: 100 }], 1);
  s.clearFeedbackFetches();
  s.saveFeedbackThreads("pr-1", [{ ...thread("t1", true), createdAt: 100 }], 2);
  expect(s.listFeedbackThreads("pr-1")[0].resolvedSeenAt).toBeGreaterThan(1_000_000);
});

test("the patch's hash is kept when it's saved, and its positions are parsed once per patch", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = createStore(bb);
  const one = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const two = one.replace("+b", "+c");
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.savePatch("pr-1", one);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(s.patchHash("pr-1")).toBe(sha(one));
  const positions = s.diffPositions("pr-1");
  expect(positions.get("a.ts")?.right.get(1)).toBe("b");
  expect(s.diffPositions("pr-1")).toBe(positions);
  s.savePatch("pr-1", two);
  expect(s.patchHash("pr-1")).toBe(sha(two));
  expect(s.diffPositions("pr-1").get("a.ts")?.right.get(1)).toBe("c");
  // A patch saved before its hash was kept gets one when it's first needed.
  bb.storage.database().prepare(`UPDATE patches SET hash=NULL`).run();
  expect(s.patchHash("pr-1")).toBe(sha(two));
  expect(s.patchHash("pr-2")).toBe(sha(""));
});

test("a comment's severity round-trips, a draft saved before severities loads with none, and an edit changes or keeps it", () => {
  const { bb } = createFakePluginHost({ pluginId: "code-review-workspace" });
  const s = createStore(bb);
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  bb.storage.database().prepare(`INSERT INTO drafts (target_key,verdict,body,comments) VALUES ('pr-1','COMMENT','',?)`)
    .run(JSON.stringify([{ file: "a.ts", line: 1, side: "RIGHT", body: "Old" }]));
  expect(s.getDraft("pr-1").comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", body: "Old" }]);
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Spacing" });
  expect(s.getDraft("pr-1").comments[1]).toEqual({ file: "a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Spacing" });
  const at = { file: "a.ts", line: 2, side: "RIGHT" as const };
  s.editDraftComment("pr-1", at, "Spacing here");
  expect(s.getDraft("pr-1").comments[1].severity).toBe("nit");
  s.editDraftComment("pr-1", at, "Spacing here", "blocking");
  expect(s.getDraft("pr-1").comments[1].severity).toBe("blocking");
  s.editDraftComment("pr-1", at, "Spacing here", null);
  expect(s.getDraft("pr-1").comments[1]).toEqual({ ...at, body: "Spacing here" });
});

test("listing discussions reads no patch for a review that has none, as startup does for every review", () => {
  const s = store();
  const renamed = "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
  for (let i = 0; i < 40; i++) {
    s.saveReview({ targetKey: `pr-${i}`, kind: "pr", number: i, status: "ready", createdAt: i });
    s.savePatch(`pr-${i}`, renamed);
  }
  vi.mocked(renamedPaths).mockClear();
  for (const review of s.listReviews()) expect(s.listDiscussions(review.targetKey)).toEqual([]);
  expect(renamedPaths).not.toHaveBeenCalled();
  // A review with a discussion still moves it to the file's new path.
  s.addDiscussionMessage("pr-1", { file: "old.ts", line: 1, side: "RIGHT" }, "reviewer", "why?");
  expect(s.listDiscussions("pr-1").map((d) => [d.file, d.waiting])).toEqual([["new.ts", true]]);
  expect(renamedPaths).toHaveBeenCalledTimes(1);
});

test("a stored guide's chapter with the Overview page's id reads back under an id no other chapter has", () => {
  const s = store();
  const chapter = (id: string, file: string) => ({ id, title: id, overview: "o", diffs: [{ file, summary: "x" }] });
  s.saveGuide("pr-1", { title: "t", intent: "i", unplacedFiles: [], sections: [chapter("c1", "a.ts"), chapter("overview", "b.ts"), chapter("overview-chapter", "c.ts")] });
  expect(s.getGuide("pr-1")?.sections.map((section) => [section.id, section.diffs[0].file])).toEqual([["c1", "a.ts"], ["overview-chapter-2", "b.ts"], ["overview-chapter", "c.ts"]]);
  s.saveGuide("pr-2", { title: "t", intent: "i", unplacedFiles: [], sections: [chapter("overview", "a.ts")] });
  expect(s.getGuide("pr-2")?.sections.map((section) => section.id)).toEqual(["overview-chapter"]);
});
