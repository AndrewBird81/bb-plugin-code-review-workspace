import { expect, test, vi } from "vitest";
import { SUMMARY_AT, type Discussion, type DiscussionEntry, type Draft, type DraftComment } from "../src/draft";
import type { FeedbackThread } from "../src/github/types";
import type { ReviewThread, ThreadComment } from "../src/threads";
import type { AssessmentVerdict, FeedbackItem, FeedbackView, ReplyDraft } from "./feedback";
import {
  buildItems, checkTally, draftStatus, fileCounts, groups, needsYou, shownItems, toSend, CHECK_LABEL, FILTER_LABEL, GROUP_TITLE, REPLY_DRAFT_LABEL, STATE_LABEL, SUMMARY_LABEL, THREAD_FLAG_LABEL,
  type CommentItem, type CommentSources, type ThreadItem,
} from "./comments";

// Every patch split into files, to count how often a build reads the whole patch.
const splits: string[] = [];
vi.mock("../src/patch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/patch")>();
  return { ...actual, splitPatchByFile: (patch: string) => { splits.push(patch); return actual.splitPatchByFile(patch); } };
});

const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (hours: number) => NOW - hours * 3_600_000;
const PR = "https://github.com/acme/web/pull/42";

// Review #42 in the harness (docs/verification/phone/harness.ts): a re-review, with src/server.ts split between two chapters.
const sections = [
  { id: "cache", diffs: [{ file: "src/cache.ts" }, { file: "src/clock.ts" }, { file: "src/server.ts", hunks: [2] }] },
  { id: "api", diffs: [{ file: "src/api/handler.ts" }, { file: "src/server.ts", hunks: [1] }, { file: "README.md" }] },
  { id: "chores", diffs: [{ file: "src/format.ts" }, { file: "db/migrate.sql" }] },
];
const patch = [
  "diff --git a/src/server.ts b/src/server.ts", "--- a/src/server.ts", "+++ b/src/server.ts",
  "@@ -1,3 +1,4 @@", ' import { createServer } from "node:http";', '+import { log } from "./log";', " const port = 8080;", " const app = createServer();",
  "@@ -36,3 +37,4 @@", " warm(cache);", '-cache.set("warm", data);', "+const clock = systemClock();", '+cache.set(scoped("system", "warm"), data, clock);', " listen(port);", "",
].join("\n");

// The draft: the agent's comments and yours, one drafted against an older diff, and discussions with the agent.
const comment = (file: string, line: number, severity: DraftComment["severity"], body: string, agent = false): DraftComment =>
  ({ file, line, side: "RIGHT", severity, body, ...(agent ? { author: "agent" as const } : {}) });
const expiry = comment("src/cache.ts", 16, "blocking", "An entry that expires exactly now is still served (`<=`). Should it be `<`?", true);
const ttl = comment("src/cache.ts", 21, "should-fix", "Read the default TTL from config, as the README says.");
const rename = comment("src/api/handler.ts", 5, "nit", "Rename `t` to `tenant`.", true);
const warmUp = comment("src/server.ts", 38, "question", "Does the warm-up need a real tenant too?");
const typo = comment("README.md", 2, "nit", "\"teh\" → \"the\".", true);
const draft: Draft = {
  targetKey: "pr-42", verdict: "REQUEST_CHANGES", body: "One blocker: the expiry boundary at `src/cache.ts:16`.", bodyAuthor: "agent",
  comments: [expiry, ttl, rename, warmUp, typo],
};
const message = (author: DiscussionEntry["author"], body: string, hours: number): DiscussionEntry => ({ author, kind: "message", body, createdAt: ago(hours) });
const discussions: Discussion[] = [
  { file: "src/cache.ts", line: 16, side: "RIGHT", waiting: false, entries: [message("reviewer", "Is `<` right here?", 3), message("agent", "Yes: an entry expiring now is stale.", 2)] },
  { file: "src/server.ts", line: 39, side: "RIGHT", startLine: 38, waiting: true, entries: [message("reviewer", "Why the fixed `system` tenant?", 1)] },
  { ...SUMMARY_AT, waiting: false, entries: [message("reviewer", "Shorter, please.", 1)] },
];

// Everyone's threads on GitHub, as getReviewThreads reads them.
let databaseId = 100;
const said = (author: string, body: string, hours: number, bot = false): ThreadComment => ({ id: `C${++databaseId}`, databaseId, author, body, createdAt: ago(hours), bot });
const thread = (id: string, path: string, line: number | null, comments: ThreadComment[], more: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id, isResolved: false, isOutdated: false, path, line, side: "RIGHT", comments, originalLine: line, startLine: null, subjectType: "LINE", resolvedBy: null, ...more });
const t1 = thread("T1", "src/cache.ts", 16, [said("reviewer", "**Blocking:** an entry that expires exactly now is still served.", 48), said("alice", "Fixed in the latest push: it's `<=` now.", 5)]);
const t2 = thread("T2", "README.md", 2, [said("reviewer", "nit: \"teh\" → \"the\"", 48)]);
const t3 = thread("T3", "src/api/handler.ts", 5, [said("reviewer", "Should this pass the tenant?", 48), said("alice", "Done.", 6)], { isResolved: true, resolvedBy: "alice" });
const t4 = thread("T4", "src/server.ts", 2, [said("reviewer", "**Should fix:** log startup as structured fields.", 48), said("alice", "Which fields do you want?", 4)]);
const t5 = thread("T5", "src/clock.ts", 3, [said("reviewer", "Inject the clock instead of calling Date.now().", 48)], { startLine: 1 });
const t6 = thread("T6", "src/cache.ts", null, [said("reviewer", "nit: rename `e` to `entry`.", 48)], { isOutdated: true, originalLine: 30 });
const b1 = thread("B1", "src/cache.ts", 14, [said("bob", "Could this be a Map?", 30), said("reviewer", "Good idea.", 29)]);
const b2 = thread("B2", "src/clock.ts", null, [said("carol", "Is this still needed?", 40)], { isOutdated: true, originalLine: 2 });
const b3 = thread("B3", "README.md", null, [said("dave", "Document the TTL here too.", 20)], { subjectType: "FILE", originalLine: null });
const b4 = thread("B4", "src/format.ts", 1, [said("erin", "Tabs?", 30), said("bob", "Spaces.", 29)], { isResolved: true, resolvedBy: "erin" });
const b5 = thread("B5", "db/migrate.sql", 1, [said("ci-bot", "Migration lint passed.", 10, true)]);
const threads = [t1, t2, t3, t4, t5, t6, b1, b2, b3, b4, b5];

// Your feedback: your threads as the server last read them, the agent's check, its drafted replies, and your summary's asks.
const stored = (live: ReviewThread, status: FeedbackThread["status"]): FeedbackThread & { url: string } => {
  const [first, ...replies] = live.comments;
  return {
    id: live.id, commentId: first.databaseId, reviewId: "R1", path: live.path, line: live.line, originalLine: live.originalLine ?? null, startLine: live.startLine ?? null,
    side: live.side, subjectType: "LINE", body: first.body, createdAt: first.createdAt!, isResolved: live.isResolved, resolvedBy: live.resolvedBy ?? null, isOutdated: live.isOutdated,
    replies: replies.map((reply) => ({ author: reply.author, bot: !!reply.bot, mine: reply.author === "reviewer", body: reply.body, createdAt: reply.createdAt! })),
    status, replyAt: null, url: `${PR}#discussion_r${first.databaseId}`,
  };
};
const checked = (id: string, verdict: AssessmentVerdict, evidence: string, fix?: { file: string; line: number }) => ({ id, verdict, evidence, ...fix, assessedAt: ago(1) });
const replied = (body: string, author: ReplyDraft["author"] = "agent"): ReplyDraft => ({ body, author, updatedAt: ago(1) });
const yours = (live: ReviewThread, status: FeedbackThread["status"], more: Partial<FeedbackItem> = {}): FeedbackItem =>
  ({ id: live.id, kind: "thread", title: live.comments[0].body, thread: stored(live, status), assessment: null, replyDraft: null, ...more });
const feedback: FeedbackView = {
  baseline: { sha: "c1", at: ago(48), verdict: "REQUEST_CHANGES" }, head: "d3", fetchedAt: ago(1), suggestionInDraft: false,
  run: { headSha: "d3", summary: "Two of six addressed.", suggestedVerdict: "REQUEST_CHANGES", suggestedBody: "", assessedAt: ago(1), current: true },
  items: [
    yours(t1, "answered", { assessment: checked("T1", "addressed", "`isExpired` now uses `<=`.", { file: "src/cache.ts", line: 17 }), replyDraft: replied("Thanks, confirmed.") }),
    yours(t2, "open", { replyDraft: replied("Fixed in abc123?") }),
    yours(t3, "resolved", { assessment: checked("T3", "unclear", "The handler changed; the tenant is passed elsewhere.") }),
    yours(t4, "question"),
    yours(t5, "open", { assessment: checked("T5", "not_addressed", "Still calls `Date.now()`.") }),
    yours(t6, "open", { assessment: checked("T6", "partial", "Renamed in one place of two.") }),
    { id: "summary:1", kind: "summary", title: "Make the TTL configurable", thread: null, assessment: checked("summary:1", "disputed", "The author says a constant is enough."), replyDraft: null },
    { id: "summary:2", kind: "summary", title: "Scope keys per tenant", thread: null, assessment: checked("summary:2", "addressed", "Keys include the tenant."), replyDraft: null },
  ],
};

const sources: CommentSources = {
  draft: { draft, stale: [{ file: "src/cache.ts", line: 21, side: "RIGHT" }], discussions },
  threads, feedback, sections, patch, viewer: "reviewer", prUrl: PR,
  replyDrafts: [{ threadId: "T1", ...replied("Thanks, confirmed.") }, { threadId: "T2", ...replied("Fixed in abc123?") }, { threadId: "B1", ...replied("Let's do it in a follow-up.", "reviewer") }],
};
const row = (item: CommentItem) => [item.id, item.label, item.group, item.needs, item.chapterId, item.at?.lines ?? null];
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

test("every comment-like thing is built once, threads joined with your feedback, in reading order", () => {
  expect(buildItems(sources).map(row)).toEqual([
    // The whole PR's first: the asks from your review summary.
    ["summary:1", "From your review summary", "needs-you", "check", null, null],
    ["summary:2", "From your review summary", "on-github", null, null, null],
    // Then chapter by chapter, file by file, line by line; src/server.ts:38 is in the cache chapter's part of the file.
    ["B1", "Open", "on-github", null, "cache", "14"],
    ["draft:src/cache.ts:16:RIGHT", "Agent draft · not submitted", "not-submitted", null, "cache", "16"],
    ["T1", "Author replied", "needs-you", "replied", "cache", "16"],
    ["draft:src/cache.ts:21:RIGHT", "Older diff · not submitted", "needs-you", "older-diff", "cache", "21"],
    // An outdated thread sorts by where it was, and shows in its file's fold.
    ["T6", "Waiting on author", "needs-you", "check", "cache", "30"],
    ["B2", "Open", "on-github", null, "cache", "2"],
    ["T5", "Waiting on author", "needs-you", "check", "cache", "1–3"],
    ["draft:src/server.ts:38:RIGHT", "Draft · not submitted", "not-submitted", null, "cache", "38"],
    ["private:src/server.ts:39:RIGHT", "Private · with the agent", "private", null, "cache", "38–39"],
    ["draft:src/api/handler.ts:5:RIGHT", "Agent draft · not submitted", "not-submitted", null, "api", "5"],
    ["T3", "Resolved", "on-github", null, "api", "5"],
    ["T4", "Question for you", "needs-you", "question", "api", "2"],
    // A file comment comes first in its file, with no line.
    ["B3", "Open", "on-github", null, "api", null],
    ["draft:README.md:2:RIGHT", "Agent draft · not submitted", "not-submitted", null, "api", "2"],
    ["T2", "Waiting on author", "needs-you", "reply-drafted", "api", "2"],
    ["B4", "Resolved", "on-github", null, "chores", "1"],
    ["B5", "Open", "on-github", null, "chores", "1"],
  ]);
});

test("a draft comment says whose words it is, carries its discussion with the agent, and a nit is non-blocking", () => {
  const items = buildItems(sources);
  const find = (id: string) => items.find((item) => item.id === id)!;
  expect(find("draft:src/cache.ts:16:RIGHT")).toMatchObject({
    kind: "draft", state: "agent-draft", who: "Agent", nonBlocking: false, comment: expiry, discussion: discussions[0],
    at: { file: "src/cache.ts", line: 16, side: "RIGHT", lines: "16" }, latest: { who: "Agent", body: expiry.body, at: null },
  });
  expect(find("draft:src/server.ts:38:RIGHT")).toMatchObject({ state: "draft", who: "You", discussion: null });
  expect(find("draft:README.md:2:RIGHT")).toMatchObject({ nonBlocking: true });
  // The summary's discussion goes with the summary, in Finish: no item.
  expect(items.filter((item) => item.kind === "private")).toEqual([expect.objectContaining({
    who: "You", discussion: discussions[1], latest: { who: "You", body: "Why the fixed `system` tenant?", at: ago(1) },
  })]);
});

test("a GitHub thread reads its author, replies, ages and check; yours by your login, someone else's by theirs", () => {
  const items = buildItems(sources);
  const find = (id: string) => items.find((item) => item.id === id) as ThreadItem;
  expect(find("T1")).toMatchObject({
    kind: "thread", id: "T1", mine: true, who: "You", replyTo: t1.comments[0].databaseId, tag: "Blocking", outdated: false, fileComment: false,
    messages: [
      { author: "reviewer", who: "You", mine: true, bot: false, body: t1.comments[0].body, createdAt: ago(48) },
      { author: "alice", who: "@alice", mine: false, bot: false, body: "Fixed in the latest push: it's `<=` now.", createdAt: ago(5) },
    ],
    latest: { who: "@alice", body: "Fixed in the latest push: it's `<=` now.", at: ago(5) },
    check: { verdict: "addressed", label: "Addressed", evidence: "`isExpired` now uses `<=`.", fix: { file: "src/cache.ts", line: 17 } },
    replyDraft: { body: "Thanks, confirmed.", author: "agent", label: "Agent reply draft · not sent" },
    url: `${PR}#discussion_r${t1.comments[0].databaseId}`, thread: t1, feedback: feedback.items[0],
  });
  expect(find("T3")).toMatchObject({ state: "resolved", resolvedBy: "alice", check: { label: "Unclear", fix: null } });
  expect(find("T6")).toMatchObject({ outdated: true, nonBlocking: true, tag: "Nit", at: { file: "src/cache.ts", line: null, lines: "30" }, check: { label: "Partial" } });
  expect(find("B1")).toMatchObject({
    mine: false, who: "@bob", check: null, feedback: null, url: `${PR}#discussion_r${b1.comments[0].databaseId}`,
    messages: [expect.objectContaining({ who: "@bob" }), expect.objectContaining({ who: "You", mine: true })],
    replyDraft: { body: "Let's do it in a follow-up.", author: "reviewer", label: "Reply draft · not sent" },
  });
  expect(find("B3")).toMatchObject({ fileComment: true, at: { file: "README.md", line: null, lines: null } });
  expect(find("B5").messages[0]).toMatchObject({ who: "@ci-bot", bot: true });
});

test("Needs you: older diff, then a question, then the agent's check, then a reply, then a drafted reply; blocking first", () => {
  expect(ids(needsYou(buildItems(sources)))).toEqual([
    "draft:src/cache.ts:21:RIGHT",
    "T4",
    // The check: not addressed, partial or disputed, on threads and on your summary's asks; the nit after the rest.
    "summary:1", "T5", "T6",
    "T1",
    "T2",
  ]);
});

test("Needs you takes nothing else: your own drafted replies, checks that say addressed or unclear, private talk, nor anything on a closed PR", () => {
  const items = buildItems(sources);
  const quiet = items.filter((item) => !item.needs).map((item) => item.id);
  expect(quiet).toEqual(expect.arrayContaining(["B1", "T3", "summary:2", "private:src/server.ts:39:RIGHT", "draft:src/cache.ts:16:RIGHT"]));
  // Resolved is settled, whatever an earlier check or a drafted reply says.
  const settled = buildItems({ ...sources, threads: threads.map((live) => live.id === "T5" || live.id === "T2" ? { ...live, isResolved: true } : live) });
  expect(settled.filter((item) => item.id === "T5" || item.id === "T2").map((item) => [item.id, item.state, item.needs, item.group])).toEqual([
    ["T5", "resolved", null, "on-github"], ["T2", "resolved", null, "on-github"],
  ]);
  // A closed or merged PR: its comments are listed where they live, and nothing needs you.
  const closed = buildItems({ ...sources, closed: true });
  expect(needsYou(closed)).toEqual([]);
  expect(closed.find((item) => item.id === "draft:src/cache.ts:21:RIGHT")).toMatchObject({ state: "older-diff", group: "not-submitted", needs: null });
  expect(closed.find((item) => item.id === "T4")).toMatchObject({ state: "question", group: "on-github" });
});

test("groups come in order, show each item once under All, and count what their chips show", () => {
  const items = buildItems(sources);
  const list = groups(items);
  // Not submitted counts every draft comment, as Submit does: the one on an older diff too, which All shows in Needs you.
  expect(list.map((group) => [group.id, group.title, group.count, group.summary, group.elsewhere])).toEqual([
    ["needs-you", "Needs you", 7, null, 0],
    ["not-submitted", "Not submitted · only in BB", 5, "1 blocking · 1 should fix · 1 question · 2 nits", 1],
    ["on-github", "On GitHub", 7, "Yours: 2 of 4 handled +2 nits", 0],
    ["private", "Private · with the agent", 1, null, 0],
  ]);
  expect(list[1].count).toBe(toSend(sources).comments);
  expect(list[1].summary).toBe(toSend(sources).severities);
  const shown = list.flatMap((group) => ids([...group.items, ...group.folded?.items ?? []]));
  expect(shown).toHaveLength(items.length);
  expect(new Set(shown).size).toBe(items.length);
  expect(ids(list[0].items)).toEqual(ids(needsYou(items)));
  expect(ids(list[1].items)).toEqual(["draft:src/cache.ts:16:RIGHT", "draft:src/server.ts:38:RIGHT", "draft:src/api/handler.ts:5:RIGHT", "draft:README.md:2:RIGHT"]);
  // On GitHub: yours first, then other people's; resolved and outdated threads folded, yours first there too.
  expect(ids(list[2].items)).toEqual(["summary:2", "B1", "B3", "B5"]);
  expect(list[2].folded).toEqual({ label: "2 resolved · 1 outdated", items: expect.anything() });
  expect(ids(list[2].folded!.items)).toEqual(["T3", "B2", "B4"]);
  expect(list[3].folded).toBeNull();
  expect(FILTER_LABEL).toEqual({ all: "All", "needs-you": "Needs you", "not-submitted": "Not submitted", "on-github": "On GitHub" });
});

test("the check strip and the file headers count from the same items", () => {
  const items = buildItems(sources);
  // Your blocking feedback: T1, T3, T4, T5 and both asks; the agent says T1 and the second ask are addressed.
  expect(checkTally(items)).toBe("2 of 6 addressed");
  expect(checkTally(buildItems({ ...sources, feedback: { ...feedback, items: feedback.items.map((item) => ({ ...item, assessment: null })) } }))).toBeNull();
  expect(Object.fromEntries(fileCounts(items))).toEqual({
    "src/cache.ts": { notSubmitted: 2, onGitHub: 3 },
    "src/clock.ts": { notSubmitted: 0, onGitHub: 2 },
    "src/server.ts": { notSubmitted: 1, onGitHub: 1 },
    "src/api/handler.ts": { notSubmitted: 1, onGitHub: 0 },
    "README.md": { notSubmitted: 1, onGitHub: 2 },
    "db/migrate.sql": { notSubmitted: 0, onGitHub: 1 },
  });
});

test("toSend counts what Submit posts by severity and author, what holds it, and the replies that post on their own", () => {
  expect(toSend(sources)).toEqual({
    verdict: "REQUEST_CHANGES", comments: 5,
    bySeverity: { blocking: 1, "should-fix": 1, question: 1, nit: 2 }, severities: "1 blocking · 1 should fix · 1 question · 2 nits",
    byAuthor: { you: 2, agent: 3 }, olderDiff: 1, replyDrafts: 3, summary: "agent",
  });
  // Hidden nits are still sent: the count is the draft's, whatever the list shows.
  expect(toSend({ ...sources, draft: { draft: { ...draft, body: " ", bodyAuthor: undefined }, stale: [] } })).toMatchObject({ comments: 5, olderDiff: 0, summary: null });
  expect(toSend({ ...sources, draft: { draft: { ...draft, bodyAuthor: undefined }, stale: [] } }).summary).toBe("reviewer");
  // Without getReplyDrafts, your threads' drafted replies from getFeedback; one on a thread no longer listed isn't counted.
  expect(toSend({ ...sources, replyDrafts: undefined }).replyDrafts).toBe(2);
  expect(toSend({ ...sources, replyDrafts: [...sources.replyDrafts!, { threadId: "GONE", ...replied("Hello?") }] }).replyDrafts).toBe(3);
  expect(toSend({ ...sources, draft: null })).toMatchObject({ verdict: "COMMENT", comments: 0, summary: null });
});

test("] and [ step through the list in its order and filter, with chapters to switch to", () => {
  const items = buildItems(sources);
  const all = shownItems(items);
  expect(all).toHaveLength(16);
  expect(all[0]).toMatchObject({ id: "draft:src/cache.ts:21:RIGHT", at: { file: "src/cache.ts", line: 21, side: "RIGHT", lines: "21" }, chapterId: "cache", group: "needs-you" });
  // Not submitted is every draft comment, in reading order: the one on an older diff too.
  expect(shownItems(items, "not-submitted").map((stop) => [stop.id, stop.chapterId])).toEqual([
    ["draft:src/cache.ts:16:RIGHT", "cache"], ["draft:src/cache.ts:21:RIGHT", "cache"], ["draft:src/server.ts:38:RIGHT", "cache"], ["draft:src/api/handler.ts:5:RIGHT", "api"], ["draft:README.md:2:RIGHT", "api"],
  ]);
  // The whole PR's ask has no place in the code; the list shows it.
  expect(shownItems(items, "on-github").map((stop) => [stop.id, stop.at?.line ?? null])).toEqual([["summary:2", null], ["B1", 14], ["B3", null], ["B5", 1]]);
  expect(ids(shownItems(items, "on-github", true))).toEqual(["summary:2", "B1", "B3", "B5", "T3", "B2", "B4"]);
  expect(ids(shownItems(items)).slice(-1)).toEqual(["private:src/server.ts:39:RIGHT"]);
});

test("GitHub's read decides whether a thread is resolved; your feedback says who answered since your last comment", () => {
  const items = buildItems({
    ...sources,
    threads: [{ ...t4, isResolved: true }, { ...t3, isResolved: false }],
    feedback: { ...feedback, items: [yours(t4, "question"), yours(t3, "resolved")] },
  });
  expect(items.map((item) => [item.id, item.state, item.needs])).toEqual(expect.arrayContaining([["T4", "resolved", null], ["T3", "waiting", null]]));
});

test("getReplyDrafts' drafted replies stand over getFeedback's", () => {
  const items = buildItems({ ...sources, replyDrafts: [] });
  expect(items.find((item) => item.id === "T1")).toMatchObject({ replyDraft: null, needs: "replied" });
  expect(items.find((item) => item.id === "T2")).toMatchObject({ replyDraft: null, needs: null, group: "on-github" });
  expect(buildItems({ ...sources, replyDrafts: undefined }).find((item) => item.id === "T2")).toMatchObject({ replyDraft: { author: "agent" }, needs: "reply-drafted" });
});

test("a thread GitHub didn't list shows as your feedback last read it, and one it listed without comments takes them from there", () => {
  // getReviewThreads failed: your threads still show; nobody else's can.
  const unread = buildItems({ ...sources, threads: [] }).filter((item): item is ThreadItem => item.kind === "thread");
  expect(unread.map((item) => item.id)).toEqual(["T1", "T6", "T5", "T3", "T4", "T2"]);
  expect(unread[0]).toMatchObject({
    thread: null, mine: true, state: "replied", replyTo: t1.comments[0].databaseId, url: `${PR}#discussion_r${t1.comments[0].databaseId}`,
    messages: [
      { author: "reviewer", who: "You", mine: true, bot: false, body: t1.comments[0].body, createdAt: ago(48) },
      { author: "alice", who: "@alice", mine: false, bot: false, body: "Fixed in the latest push: it's `<=` now.", createdAt: ago(5) },
    ],
  });
  // The harness's stand-in for gh answers the threads query without comments.
  const bare = buildItems({ ...sources, viewer: null, threads: [{ ...t1, comments: [] }] }).find((item) => item.id === "T1") as ThreadItem;
  expect(bare.messages.map((entry) => entry.who)).toEqual(["You", "@alice"]);
  expect(bare.replyTo).toBe(t1.comments[0].databaseId);
});

test("without your login, it's the author of your threads' first comments; a thread you started that your feedback hasn't read yet is yours", () => {
  const fresh = thread("T9", "src/clock.ts", 4, [said("reviewer", "Why a class?", 0.1)]);
  const items = buildItems({ ...sources, viewer: undefined, threads: [...threads, fresh] });
  expect(items.find((item) => item.id === "T9")).toMatchObject({ mine: true, who: "You", state: "waiting", needs: null, group: "on-github", feedback: null });
  expect((items.find((item) => item.id === "B1") as ThreadItem).messages.map((entry) => entry.who)).toEqual(["@bob", "You"]);
  // With nothing of yours to tell by, every thread is someone else's.
  const strangers = buildItems({ ...sources, viewer: null, feedback: null, threads: [fresh] });
  expect(strangers.find((item) => item.id === "T9")).toMatchObject({ mine: false, who: "@reviewer", state: "open" });
});

test("threads read without the newer fields still build", () => {
  const old: ReviewThread[] = [
    { id: "O1", isResolved: false, isOutdated: false, path: "src/cache.ts", line: 14, side: "RIGHT", comments: [{ id: "c1", databaseId: 7, author: "dependabot[bot]", body: "Bump" }] },
    { id: "O2", isResolved: false, isOutdated: true, path: "src/clock.ts", line: null, side: "RIGHT", comments: [{ id: "c2", databaseId: 8, author: "bob", body: "Moved?" }] },
  ];
  const items = buildItems({ draft: null, threads: old, feedback: null, sections, patch, viewer: "reviewer" });
  expect(items.map((item) => [item.id, item.state, item.at?.lines ?? null, item.chapterId])).toEqual([["O1", "open", "14", "cache"], ["O2", "open", null, "cache"]]);
  expect((items[0] as ThreadItem).messages[0]).toEqual({ author: "dependabot[bot]", who: "@dependabot[bot]", mine: false, bot: true, body: "Bump", createdAt: null });
  expect(items[0]).toMatchObject({ resolvedBy: null, fileComment: false, url: null });
});

test("a local review has only what's in BB: drafts and private discussions", () => {
  const items = buildItems({ draft: { draft: { ...draft, verdict: "COMMENT", body: "" }, stale: [{ file: "src/cache.ts", line: 21, side: "RIGHT" }], discussions }, threads: [], feedback: null, sections, patch });
  expect(groups(items).map((group) => [group.id, group.count, group.summary])).toEqual([
    ["needs-you", 1, null], ["not-submitted", 5, "1 blocking · 1 should fix · 1 question · 2 nits"], ["on-github", 0, null], ["private", 1, null],
  ]);
  expect(checkTally(items)).toBeNull();
  expect(toSend({ draft: { draft: { ...draft, body: "" }, stale: [] }, threads: [], feedback: null, sections, patch })).toMatchObject({ comments: 5, replyDrafts: 0, summary: null });
});

test("a file no chapter shows, such as one gone from the PR, comes last, by name", () => {
  const gone = [comment("src/zeta.ts", 1, undefined, "Gone"), comment("src/alpha.ts", 9, undefined, "Gone too")];
  const items = buildItems({ ...sources, draft: { draft: { ...draft, comments: [...gone, ...draft.comments] }, stale: [], discussions: [] }, threads: [], feedback: null });
  expect(items.map((item) => [item.id, item.chapterId]).slice(-2)).toEqual([["draft:src/alpha.ts:9:RIGHT", null], ["draft:src/zeta.ts:1:RIGHT", null]]);
});

test("a file split across chapters puts each item in the chapter with its hunk, reading the patch once", () => {
  // Another file's diff too, so the patch isn't src/server.ts's alone.
  const wide = `${patch}diff --git a/src/cache.ts b/src/cache.ts\n--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -16 +16 @@\n-  return expiresAt < now;\n+  return expiresAt <= now;\n`;
  splits.length = 0;
  const items = buildItems({ ...sources, patch: wide });
  expect(items.filter((item) => item.at?.file === "src/server.ts").map((item) => [item.id, item.chapterId])).toEqual([
    ["draft:src/server.ts:38:RIGHT", "cache"], ["private:src/server.ts:39:RIGHT", "cache"], ["T4", "api"],
  ]);
  expect(splits.filter((text) => text === wide)).toHaveLength(1);
});

test("the words for every state, thread flag, check, reply draft and summary", () => {
  expect(STATE_LABEL).toEqual({
    draft: "Draft · not submitted", "agent-draft": "Agent draft · not submitted", "older-diff": "Older diff · not submitted", private: "Private · with the agent",
    waiting: "Waiting on author", replied: "Author replied", question: "Question for you", resolved: "Resolved", open: "Open", "needs-reply": "Needs your reply",
    "summary-ask": "From your review summary",
  });
  expect(THREAD_FLAG_LABEL).toEqual({ outdated: "Outdated", fileComment: "File comment" });
  expect(CHECK_LABEL).toEqual({ addressed: "Addressed", partial: "Partial", not_addressed: "Not addressed", disputed: "Author disagrees", unclear: "Unclear" });
  expect(REPLY_DRAFT_LABEL).toEqual({ reviewer: "Reply draft · not sent", agent: "Agent reply draft · not sent" });
  expect(SUMMARY_LABEL).toEqual({ reviewer: "Summary · not submitted", agent: "Agent summary · not submitted" });
  expect(GROUP_TITLE).toEqual({ "needs-you": "Needs you", "not-submitted": "Not submitted · only in BB", "on-github": "On GitHub", private: "Private · with the agent" });
});

// Your own PR (S6): every thread is yours to answer; bots' are folded.

test("on your own PR a thread whose latest comment that isn't a bot's isn't yours needs your reply; bots' threads fold", () => {
  const b6 = thread("B6", "src/cache.ts", 20, [said("frank", "Why a Map?", 8), said("ci-bot", "Coverage dropped.", 7, true)]);
  const own: CommentSources = {
    draft: null, threads: [t1, t2, b1, b3, b4, b5, b6], sections, patch, viewer: "reviewer", prUrl: PR, ownPr: true,
    // The server keeps everyone's threads on your PR: none of them makes a thread yours.
    feedback: { ...feedback, items: [b1, b3, b5].map((live) => ({ ...yours(live, "open"), thread: { ...stored(live, "open"), author: live.comments[0].author, ...live.comments[0].bot ? { authorBot: true as const } : {} } })), run: null },
  };
  const items = buildItems(own);
  const byId = (id: string) => items.find((item) => item.id === id) as ThreadItem;
  expect([t1, t2, b1, b3, b4, b5, b6].map(({ id }) => [id, byId(id).state, byId(id).label, byId(id).needs, byId(id).mine])).toEqual([
    ["T1", "needs-reply", "Needs your reply to @alice", "needs-reply", true],
    ["T2", "open", "Open", null, true],
    ["B1", "open", "Open", null, false],
    ["B3", "needs-reply", "Needs your reply to @dave", "needs-reply", false],
    ["B4", "resolved", "Resolved", null, false],
    ["B5", "open", "Open", null, false],
    ["B6", "needs-reply", "Needs your reply to @frank", "needs-reply", false],
  ]);
  const list = groups(items);
  expect(ids(list[0].items).sort()).toEqual(["B3", "B6", "T1"]);
  expect(list[2].folded).toEqual({ label: "1 resolved · 1 from bots", items: expect.anything() });
  expect(ids(list[2].folded!.items).sort()).toEqual(["B4", "B5"]);
  // A thread GitHub didn't list reads from what the server kept, under its own author.
  const kept = buildItems({ ...own, threads: [] });
  expect((kept.find((item) => item.id === "B3") as ThreadItem)).toMatchObject({ state: "needs-reply", who: "@dave", mine: false });
  // One a bot started, which GitHub names without "[bot]", is told by what the server kept, and folds.
  expect((kept.find((item) => item.id === "B5") as ThreadItem)).toMatchObject({ state: "open", bot: true, needs: null });
  // Without your login, nothing the server kept is taken for yours.
  expect((buildItems({ ...own, viewer: null }).find((item) => item.id === "B1") as ThreadItem).mine).toBe(false);
});

test("on a teammate's PR, bots' threads stay where they were and nothing reads Needs your reply", () => {
  const items = buildItems(sources);
  expect(items.some((item) => item.kind === "thread" && (item.state === "needs-reply" || item.bot))).toBe(false);
  expect(groups(items)[2].folded?.label).toBe("2 resolved · 1 outdated");
});

test("a sent comment's report says Done or Declined with its note, without its closing stop; one the review agent's check found says it wasn't reported; each marks its icon", () => {
  const sent: DraftComment = { file: "src/a.ts", line: 1, side: "RIGHT", body: "Name it.", id: "c1", state: "sent", sendN: 1 };
  const local = { posts: false, own: true, sends: [{ n: 1, at: 1, threadId: "coder", ids: ["c1"] }] };
  expect(draftStatus({ ...sent, claim: { outcome: "done", note: "Renamed it `total`.", threadId: "coder", at: 1 } }, "draft", local)).toEqual({ label: "Done · Renamed it `total`", at: 1, mark: "done" });
  expect(draftStatus({ ...sent, claim: { outcome: "declined", note: "Later...", threadId: "coder", at: 1 } }, "draft", local)).toMatchObject({ label: "Declined · Later...", mark: "declined" });
  expect(draftStatus({ ...sent, claim: { outcome: "done", note: "a.ts:1 renamed", threadId: "agent", at: 1, inferred: true } }, "draft", local)).toMatchObject({ label: "Looks done · not reported", mark: "looks-done" });
  expect(draftStatus({ ...sent, claim: { outcome: "declined", threadId: "agent", at: 1, inferred: true } }, "draft", local)).toMatchObject({ label: "Looks declined · not reported", mark: "looks-declined" });
  expect(draftStatus(sent, "draft", local)).toMatchObject({ label: "Sent to the main thread · Send 1", mark: "sent" });
  // Where it posts on someone else's PR, it's still a draft first: no mark.
  expect(draftStatus(sent, "draft", { ...local, posts: true, own: false }).mark).toBeUndefined();
});
