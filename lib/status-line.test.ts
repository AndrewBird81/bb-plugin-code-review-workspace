import { expect, test } from "vitest";
import type { Turn } from "./turn";
import { snoozeLabel } from "./turn";
import type { ReviewItem } from "./review-state";
import { statusLine, statusWhy } from "./status-line";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse("2026-10-11T12:00:00Z");
const turn = (group: Turn["group"], reason: Turn["reason"], label = "", extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });
const review = (t: Turn, extra: Partial<ReviewItem> = {}): ReviewItem => ({ targetKey: "k", kind: "pr", status: "ready", turn: t, ...extra });
const said = (r: ReviewItem) => { const part = statusWhy(r, now); return part && [part.text, part.tone, part.icon]; };
const line = (r: ReviewItem, passingChecks = false) => statusLine(r, { now, passingChecks }).map((part) => part.text);

test("why it's yours says who asked, in words, with an icon and a tone only where it changes your next move", () => {
  const signals = { requestedBy: "alice", questionBy: "bob", mentionBy: "carol", author: "alice" };
  expect(said(review(turn("needs", "re-requested"), { signals }))).toEqual(["Re-requested by @alice", "foreground", "Repeat"]);
  // A first review is the usual case, so it's said quietly; what came back to you stands out.
  expect(said(review(turn("needs", "requested"), { signals }))).toEqual(["Requested by @alice", "neutral", "UserRoundPlus"]);
  expect(said(review(turn("needs", "requested")))).toEqual(["Review requested", "neutral", "UserRoundPlus"]);
  expect(said(review(turn("needs", "team-requested"), { signals: { requestedBy: "carol" } }))).toEqual(["Team request from @carol", "neutral", "UserRoundPlus"]);
  expect(said(review(turn("needs", "question", "Question for you"), { signals }))).toEqual(["Question from @bob", "warning", "MessageQuestion"]);
  expect(said(review(turn("needs", "question", "Author replied"), { signals }))).toEqual(["@alice replied", "foreground", "MessageSquare"]);
  expect(said(review(turn("needs", "mentioned"), { signals }))).toEqual(["Mentioned by @carol", "foreground", "MessageSquare"]);
  expect(said(review(turn("needs", "handled")))).toEqual(["Feedback handled", "success", "CircleCheck"]);
  expect(said(review(turn("needs", "looks-ready")))).toEqual(["Agent: all feedback addressed", "agent", "Sparkles"]);
  expect(said(review(turn("needs", "dismissed")))).toEqual(["Your review was dismissed", "warning", "AlertCircle"]);
  expect(said(review(turn("needs", "own")))).toEqual(["Your PR", "neutral", "UserRound"]);
  expect(said(review(turn("needs", "new"), { status: "tracked" }))).toEqual(["No guide yet", "neutral", undefined]);
  expect(said(review(turn("needs", "new")))).toEqual(["Guide ready", "neutral", undefined]);
  expect(said(review(turn("needs", "new"), { kind: "ref" }))).toEqual(["Local review", "neutral", "GitBranch"]);
});

test("the author's turn and settled reviews say what you did and when; archived ones how they ended", () => {
  expect(said(review(turn("waiting", "waiting", "Changes requested", { at: now - 2 * DAY }), { submittedVerdict: "REQUEST_CHANGES" }))).toEqual(["You requested changes 2d ago", "neutral", "FileDiff"]);
  expect(said(review(turn("waiting", "waiting", "Commented", { at: now - 3 * HOUR }), { submittedVerdict: "COMMENT" }))).toEqual(["You commented 3h ago", "neutral", "MessageSquare"]);
  expect(said(review(turn("waiting", "snoozed", "Snoozed until the author responds")))).toEqual(["Snoozed until the author responds", "neutral", "Clock"]);
  const until = now + 3 * DAY;
  expect(said(review(turn("waiting", "snoozed", "Snoozed"), { snoozedUntil: until }))).toEqual([snoozeLabel(until, now), "neutral", "Clock"]);
  expect(said(review(turn("waiting", "draft", "Draft")))).toEqual(["Draft PR", "neutral", "GitPullRequestDraft"]);
  expect(said(review(turn("reviewed", "approved", "Approved"), { submittedAt: now - 3 * DAY, submittedVerdict: "APPROVE" }))).toEqual(["You approved 3d ago", "neutral", "Check"]);
  expect(said(review(turn("reviewed", "commented", "Commented"), { signals: { lastReviewAt: now - DAY } }))).toEqual(["You commented 1d ago", "neutral", "MessageSquare"]);
  expect(said(review(turn("archive", "merged", "Merged")))).toEqual(["Merged", "merged", "GitMerge"]);
  expect(said(review(turn("archive", "closed", "Closed")))).toEqual(["Closed", "danger", "GitPullRequestClosed"]);
  expect(said(review(turn("archive", "archived", "Archived")))).toEqual(["Archived by you", "neutral", "Archive"]);
  expect(said(review(turn("archive", "unrequested", "No longer requested")))).toEqual(["No longer requested", "neutral", undefined]);
  expect(said(review(turn("archive", "unreachable", "Can’t read on GitHub")))).toEqual(["Can’t read on GitHub", "neutral", "EyeOff"]);
});

test("agent work and a failed guide take the place of why, in the agent's tone and danger", () => {
  const requested = turn("needs", "requested");
  expect(statusWhy(review(requested, { status: "generating" }), now)).toEqual({ kind: "why", text: "Building guide…", tone: "agent", icon: "Loading", busy: true });
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error" }))).toEqual(["Guide failed", "danger", "AlertTriangle"]);
  expect(statusWhy(review(turn("needs", "re-requested"), { verifyingSince: now - 60_000 }), now)).toMatchObject({ text: "Checking your feedback…", tone: "agent", busy: true });
  // Over by the time it's archived.
  expect(said(review(turn("archive", "merged"), { verifyingSince: now - 60_000 }))).toEqual(["Merged", "merged", "GitMerge"]);
});

test("the line puts Blocks merge first, then why, then only the facts that change whether to open it", () => {
  const busy = review(turn("needs", "re-requested", "Re-requested", { blocking: true }), {
    signals: { requestedBy: "alice", commitsSince: 3, ci: "fail" },
    progress: { done: 2, total: 2, source: "threads", nits: 1 },
    prSize: { additions: 1200, deletions: 30, files: 8 },
  });
  expect(line(busy)).toEqual(["Blocks merge", "Re-requested by @alice", "2/2 handled +1 nit", "+3 commits", "Checks failing", "+1,200 −30 · 8 files"]);
  expect(statusLine(busy, { now }).map((part) => part.kind)).toEqual(["blocking", "why", "progress", "commits", "checks", "size"]);
  // Passing checks are news only where asked for, as on the Overview.
  const passing = review(turn("needs", "requested"), { signals: { ci: "pass" }, prSize: { additions: 2, deletions: 0, files: 1 } });
  expect(line(passing)).toEqual(["Review requested", "+2 −0 · 1 file"]);
  expect(line(passing, true)).toEqual(["Review requested", "Checks passing", "+2 −0 · 1 file"]);
  expect(line(review(turn("needs", "requested"), { signals: { ci: "expected", commitsSince: 1 } }))).toEqual(["Review requested", "+1 commit", "Checks expected"]);
  // Checks just read, as the Overview has them, say what they say now, not what the last sync saw.
  expect(statusLine(passing, { now, passingChecks: true, ci: "fail" }).map((part) => part.text)).toEqual(["Review requested", "Checks failing", "+2 −0 · 1 file"]);
  expect(statusLine(passing, { now, passingChecks: true, ci: "none" }).map((part) => part.text)).toEqual(["Review requested", "+2 −0 · 1 file"]);
  // Archived, checks don't matter any more.
  expect(line(review(turn("archive", "merged"), { signals: { ci: "fail" } }))).toEqual(["Merged"]);
});

test("the line says why an agent didn't run, when GitHub can't read the PR, and where it sits in a stack", () => {
  const parent = { targetKey: "pr-41", number: 41, title: "Add the queue", url: null, status: "ready" as const, reviewed: false };
  const stacked = review(turn("needs", "requested"), {
    author: "mallory", repo: "acme/web", authorAssociation: "CONTRIBUTOR", skippedRun: { run: "guide", head: "h", at: 1 },
    unreachable: { since: 1, reason: "forbidden" },
    stack: { members: [parent, { ...parent, targetKey: "pr-42", number: 42 }], index: 1, parent, children: [] },
  });
  expect(line(stacked)).toEqual(["Review requested", "Not run automatically: @mallory isn’t a member of acme", "Can’t read on GitHub", "Stack 2 of 2 · on #41", "#41 not reviewed yet"]);
  expect(statusLine(stacked, { now }).find((part) => part.kind === "unreachable")?.detail).toBe("GitHub refused access, for example for SSO");
  const bottom = review(turn("needs", "requested"), { stack: { members: [{ ...parent, reviewed: true }, { ...parent, targetKey: "pr-42", number: 42 }], index: 0, parent: null, children: [] } });
  expect(line(bottom)).toEqual(["Review requested", "Stack 1 of 2"]);
});
