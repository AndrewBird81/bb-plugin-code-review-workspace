import { expect, test } from "vitest";
import { baselineOf, canSnooze, canSnoozeUntil, computeTurn, feedbackProgress, progressText, QUIET_MS, snoozeLabel, snoozeTimes, type TurnInput, type TurnOptions } from "../lib/turn";
import { threadSignals, turnOptions } from "./turn-signals";
import { defaultPreferences } from "./preferences";
import type { FeedbackThread } from "./github/types";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const hour = 3_600_000;
const t = (hoursAgo: number) => NOW - hoursAgo * hour;

/** You requested changes on sha1 five hours ago, with three threads. */
function changesRequested(extra: Partial<TurnInput> = {}, signals: TurnInput["signals"] = {}): TurnInput {
  return {
    targetKey: "pr-1", kind: "pr", status: "ready", prState: "OPEN", headSha: "sha1", latestHeadSha: "sha1",
    submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "sha1",
    ...extra,
    signals: {
      lastReviewAt: t(5), lastReviewSha: "sha1", ci: "pass",
      threads: { total: 3, resolved: 0, answered: 0, questions: 0, open: 3, outdated: 0 },
      ...signals,
    },
  };
}
const turn = (review: TurnInput, options?: Partial<TurnOptions>) =>
  computeTurn(review, { wakeOnReplies: "questions", pushChecks: "off", ...options }, NOW);

test("merged, closed, and archived reviews are in Archive", () => {
  expect(turn(changesRequested({ prState: "MERGED" }))).toMatchObject({ group: "archive", label: "Merged" });
  expect(turn(changesRequested({ prState: "CLOSED" }))).toMatchObject({ group: "archive", label: "Closed" });
  expect(turn(changesRequested({ userArchivedAt: t(1) }))).toMatchObject({ group: "archive", label: "Archived" });
});

test("a re-request after you archived a review brings it back", () => {
  const review = changesRequested({ userArchivedAt: t(2) }, { requestedAt: t(1), requestedBy: "alice" });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "re-requested", notify: true });
  // An older request doesn't.
  expect(turn(changesRequested({ userArchivedAt: t(0.5) }, { requestedAt: t(1) })).group).toBe("archive");
});

test("a review you haven't submitted yet is yours", () => {
  expect(turn({ targetKey: "a", status: "ready" })).toMatchObject({ group: "needs", reason: "new", label: "Ready" });
  expect(turn({ targetKey: "a", kind: "ref", status: "ready" })).toMatchObject({ group: "needs", label: "Ready" });
});

test("a request for your review alerts you; a team request is quieter", () => {
  const requested = turn({ targetKey: "a", kind: "pr", status: "tracked", signals: { requestedAt: t(1), requestedVia: "user", requestPending: true } });
  expect(requested).toMatchObject({ group: "needs", reason: "requested", notify: true, signal: `requested:${t(1)}` });
  const team = turn({ targetKey: "a", kind: "pr", status: "tracked", signals: { requestedAt: t(1), requestedVia: "team", requestPending: true } });
  expect(team).toMatchObject({ group: "needs", reason: "team-requested", notify: false });
});

test("a PR found on GitHub whose request was withdrawn, or a team's with team requests off, leaves Needs review", () => {
  const tracked = (signals: TurnInput["signals"], status: TurnInput["status"] = "tracked"): TurnInput => ({ targetKey: "a", kind: "pr", status, signals });
  expect(turn(tracked({ requestedAt: t(30), requestPending: false }))).toMatchObject({ group: "archive", reason: "unrequested", label: "No longer requested", signal: null });
  const team = tracked({ requestedAt: t(1), requestedVia: "team", requestPending: true });
  expect(turn(team, { teamRequests: false })).toMatchObject({ group: "archive", reason: "unrequested" });
  expect(turn(team, { teamRequests: true })).toMatchObject({ group: "needs", reason: "team-requested" });
  // Not read from GitHub yet, or with a guide you started, it stays.
  expect(turn(tracked(null))).toMatchObject({ group: "needs", label: "Tracked" });
  expect(turn(tracked({ requestPending: false }, "ready"))).toMatchObject({ group: "needs", label: "Ready" });
});

test("your own PR needs your review until you've reviewed it, then it's Reviewed, never waiting and never alerting", () => {
  const own = (extra: Partial<TurnInput> = {}, signals: TurnInput["signals"] = {}) => changesRequested({ ownPr: true, ...extra }, signals);
  expect(turn({ targetKey: "a", kind: "pr", status: "ready", ownPr: true, createdAt: t(2) })).toMatchObject({ group: "needs", reason: "own", label: "Your PR", notify: false, signal: null, at: t(2) });
  expect(turn(own({ submittedVerdict: "COMMENT" }))).toMatchObject({ group: "reviewed", reason: "own", label: "Your PR" });
  // Open threads, questions, mentions, and pushes don't move it.
  expect(turn(own({ submittedVerdict: "COMMENT", latestHeadSha: "sha2" }, { questionAt: t(1), mentionAt: t(1), headSeenAt: t(1) })))
    .toMatchObject({ group: "reviewed", label: "Your PR · updated", updated: true, signal: null });
  expect(turn(own({ prState: "MERGED" })).group).toBe("archive");
});

test("your own PR found on GitHub waits in Reviewed until someone's comment waits for your reply, then it's yours, with an alert per comment", () => {
  const found: TurnInput = { targetKey: "pr-9", kind: "pr", status: "tracked", prState: "OPEN", ownPr: true, createdAt: t(9), signals: { ci: "pass" } };
  expect(turn(found)).toMatchObject({ group: "reviewed", reason: "own", label: "Your PR", signal: null, notify: false });
  const commented = { ...found, signals: { ...found.signals, newComments: { count: 3, at: t(1), by: "bob" } } };
  expect(turn(commented)).toMatchObject({ group: "needs", reason: "new-comments", label: "Your PR · 3 new comments", signal: `comments:${t(1)}`, notify: true, at: t(1), eventAt: t(1) });
  expect(turn({ ...found, signals: { newComments: { count: 1, at: t(1), by: "bob" } } }).label).toBe("Your PR · 1 new comment");
  // As many threads as Comments' Needs you counts, when that's not one a comment.
  expect(turn({ ...found, signals: { newComments: { count: 3, threads: 2, at: t(1), by: "bob" } } }).label).toBe("Your PR · 3 new comments in 2 threads");
  expect(turn({ ...found, signals: { newComments: { count: 2, threads: 1, at: t(1), by: "bob" } } }).label).toBe("Your PR · 2 new comments in 1 thread");
  expect(turn({ ...found, signals: { newComments: { count: 2, threads: 2, at: t(1), by: "bob" } } }).label).toBe("Your PR · 2 new comments");
  // One you started a review of, or reviewed, comes back the same way.
  expect(turn({ ...commented, status: "ready", submittedVerdict: "COMMENT", submittedAt: t(5) })).toMatchObject({ group: "needs", reason: "new-comments" });
  // Your reply, or a resolve, ends it: the sync reads no comment waiting.
  expect(turn({ ...commented, signals: { ...commented.signals, newComments: null } })).toMatchObject({ group: "reviewed", reason: "own" });
  // A snooze holds the comments it set aside; a newer one wakes it.
  const snoozed = { ...commented, snoozedAt: t(0.5), snoozedUntil: NOW + hour };
  expect(turn(snoozed)).toMatchObject({ group: "waiting", reason: "snoozed" });
  expect(turn({ ...snoozed, signals: { newComments: { count: 4, at: t(0.2), by: "carol" } } })).toMatchObject({ group: "needs", reason: "new-comments" });
  // A teammate's PR never reads them.
  expect(turn({ ...commented, ownPr: false, signals: { ...commented.signals, requestPending: true, requestedAt: t(8) } }).reason).toBe("requested");
});

test("with Include your own PRs off, your PRs found on GitHub leave the list until you start a review of one", () => {
  const found: TurnInput = { targetKey: "pr-9", kind: "pr", status: "tracked", prState: "OPEN", ownPr: true, signals: { newComments: { count: 2, at: t(1), by: "bob" } } };
  expect(turn(found, { ownPrs: false })).toMatchObject({ group: "archive", reason: "own" });
  expect(turn({ ...found, status: "ready" }, { ownPrs: false })).toMatchObject({ group: "needs", reason: "new-comments" });
  expect(turnOptions({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, trackOwnPrs: false } }).ownPrs).toBe(false);
  expect(turnOptions(defaultPreferences).ownPrs).toBe(true);
});

test("your own PR's threads aren't progress: an answered one waits for your reply", () => {
  const threads = { total: 3, resolved: 1, answered: 2, questions: 0, open: 0, outdated: 0 };
  expect(feedbackProgress({ ownPr: true, signals: { threads } })).toBeNull();
  expect(feedbackProgress({ ownPr: false, signals: { threads } })).toMatchObject({ done: 3, total: 3 });
});

test("a PR GitHub can't find for a week goes to Archive", () => {
  const gone = (days: number, reason: "not-found" | "forbidden" = "not-found") => changesRequested({ unreachable: { since: NOW - days * 24 * hour, reason } });
  expect(turn(gone(1)).group).toBe("waiting");
  expect(turn(gone(8))).toMatchObject({ group: "archive", reason: "unreachable", label: "Can’t read on GitHub" });
  // Access refused, say for SSO, may come back: it stays.
  expect(turn(gone(8, "forbidden")).group).toBe("waiting");
});

test("a team request after your review isn't a re-request, and doesn't undo your archive", () => {
  const team = { requestedAt: t(1), requestedBy: "carol", requestedVia: "team" as const, requestPending: true };
  expect(turn(changesRequested({}, team))).toMatchObject({ group: "waiting", reason: "waiting" });
  expect(turn(changesRequested({ userArchivedAt: t(2) }, team)).group).toBe("archive");
});

test("a push alone doesn't make it your turn", () => {
  const pushed = turn(changesRequested({ latestHeadSha: "sha2" }, { headSeenAt: t(3) }));
  expect(pushed).toMatchObject({ group: "waiting", reason: "waiting", label: "Changes requested", updated: true, signal: null });
});

test("a re-request after your review makes it your turn and alerts you", () => {
  const review = changesRequested({ latestHeadSha: "sha2" }, { requestedAt: t(1), requestedBy: "alice" });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "re-requested", label: "Re-requested", notify: true, signal: `re-requested:${t(1)}`, at: t(1) });
  // The original request, before your review, doesn't count.
  expect(turn(changesRequested({}, { requestedAt: t(6) })).group).toBe("waiting");
});

test("snoozing until the author responds hides a review until a newer signal", () => {
  const snoozed = changesRequested({ latestHeadSha: "sha2", snoozedAt: t(0.5) }, { requestedAt: t(1) });
  expect(turn(snoozed)).toMatchObject({ group: "waiting", reason: "snoozed", label: "Snoozed until the author responds" });
  // A push after the snooze doesn't wake it.
  expect(turn({ ...snoozed, latestHeadSha: "sha3", signals: { ...snoozed.signals, headSeenAt: t(0.1) } }).group).toBe("waiting");
  // A new re-request does.
  expect(turn({ ...snoozed, signals: { ...snoozed.signals, requestedAt: t(0.2) } })).toMatchObject({ group: "needs", reason: "re-requested" });
});

test("Snooze until holds even a new request in Waiting on author, until that time or a newer request", () => {
  const request: TurnInput = { targetKey: "pr-1", kind: "pr", status: "tracked", prState: "OPEN", signals: { requestPending: true, requestedVia: "user", requestedAt: t(2) } };
  const snoozed = { ...request, snoozedAt: t(1), snoozedUntil: NOW + hour };
  expect(turn(snoozed)).toMatchObject({ group: "waiting", reason: "snoozed", label: "Snoozed", at: t(1) });
  expect(computeTurn(snoozed, undefined, NOW + hour)).toMatchObject({ group: "needs", reason: "requested" });
  expect(turn({ ...snoozed, signals: { ...snoozed.signals, requestedAt: t(0.5) } })).toMatchObject({ group: "needs", reason: "requested" });
  // Your own PR too.
  expect(turn({ ...snoozed, ownPr: true })).toMatchObject({ group: "waiting", reason: "snoozed" });
});

test("Snooze until holds a review you gave until that time, then it's back as it was; a newer signal wakes it sooner", () => {
  const snoozed = changesRequested({ latestHeadSha: "sha2", snoozedAt: t(0.5), snoozedUntil: NOW + hour }, { requestedAt: t(1) });
  expect(turn(snoozed)).toMatchObject({ group: "waiting", reason: "snoozed", label: "Snoozed" });
  expect(computeTurn(snoozed, undefined, NOW + 2 * hour)).toMatchObject({ group: "needs", reason: "re-requested", signal: `re-requested:${t(1)}` });
  expect(turn({ ...snoozed, signals: { ...snoozed.signals, questionAt: t(0.2) } })).toMatchObject({ group: "needs", reason: "question" });
});

test("any review whose turn it is can be snoozed until a time, except a local one or a failed guide", () => {
  const request: TurnInput = { targetKey: "pr-1", kind: "pr", status: "tracked", signals: { requestPending: true, requestedAt: t(2) } };
  expect(canSnoozeUntil(request, turn(request))).toBe(true);
  const local: TurnInput = { targetKey: "ref", kind: "ref", status: "ready" };
  expect(canSnoozeUntil(local, turn(local))).toBe(false);
  const failed = { ...request, status: "error" as const };
  expect(canSnoozeUntil(failed, turn(failed))).toBe(false);
  const waiting = changesRequested();
  expect(canSnoozeUntil(waiting, turn(waiting))).toBe(false);
});

test("snooze times are later today, tomorrow morning, and next Monday morning, in local time", () => {
  const saturday = new Date(2026, 9, 10, 12, 0);
  expect(snoozeTimes(saturday.getTime())).toEqual({
    laterToday: new Date(2026, 9, 10, 15, 0).getTime(), tomorrow: new Date(2026, 9, 11, 9, 0).getTime(), nextMonday: new Date(2026, 9, 12, 9, 0).getTime(),
  });
  // Late in the day there's no later today; on a Monday, next Monday is a week away.
  expect(snoozeTimes(new Date(2026, 9, 10, 22, 0).getTime()).laterToday).toBeNull();
  expect(snoozeTimes(new Date(2026, 9, 12, 8, 0).getTime()).nextMonday).toBe(new Date(2026, 9, 19, 9, 0).getTime());
});

test("a snooze's label says when it wakes", () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime();
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(snoozeLabel(new Date(2026, 9, 10, 15, 0).getTime(), now)).toBe(`Snoozed until ${time(new Date(2026, 9, 10, 15, 0))}`);
  expect(snoozeLabel(new Date(2026, 9, 11, 9, 0).getTime(), now)).toBe(`Snoozed until tomorrow ${time(new Date(2026, 9, 11, 9, 0))}`);
  expect(snoozeLabel(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe(`Snoozed until ${new Date(2026, 9, 12).toLocaleDateString([], { weekday: "short" })} ${time(new Date(2026, 9, 12, 9, 0))}`);
  expect(snoozeLabel(new Date(2026, 9, 30, 9, 0).getTime(), now)).toBe(`Snoozed until ${new Date(2026, 9, 30).toLocaleDateString([], { month: "short", day: "numeric" })}`);
});

test("a question on your thread wakes the review; other replies only if you choose", () => {
  expect(turn(changesRequested({}, { questionAt: t(1), replyAt: t(1) }))).toMatchObject({ group: "needs", reason: "question", label: "Question for you", notify: true });
  expect(turn(changesRequested({}, { replyAt: t(1) })).group).toBe("waiting");
  expect(turn(changesRequested({}, { replyAt: t(1) }), { wakeOnReplies: "any" })).toMatchObject({ group: "needs", label: "Author replied" });
  // Your newer review answers it.
  expect(turn(changesRequested({}, { questionAt: t(6) })).group).toBe("waiting");
});

test("a mention after your review wakes it", () => {
  expect(turn(changesRequested({}, { mentionAt: t(1), mentionBy: "alice" }))).toMatchObject({ group: "needs", reason: "mentioned", notify: true });
});

test("with Come back when you're mentioned off, a mention after your review leaves it waiting", () => {
  const mentioned = changesRequested({}, { mentionAt: t(1), mentionBy: "alice" });
  expect(turn(mentioned, { mentions: false })).toMatchObject({ group: "waiting", notify: false });
  expect(turnOptions({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, mentionsWake: false } })).toMatchObject({ mentions: false });
  expect(turn(mentioned, turnOptions(defaultPreferences))).toMatchObject({ group: "needs", reason: "mentioned" });
});

test("feedback handled: every thread resolved or answered, new commits, CI settled, author quiet", () => {
  const handled = { threads: { total: 3, resolved: 2, answered: 1, questions: 0, open: 0, outdated: 1 }, handledAt: t(1), headSeenAt: t(2) };
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, handled))).toMatchObject({ group: "needs", reason: "handled", notify: true, signal: `handled:${t(1)}`, eventAt: t(1) });
  // Without new commits, CI still running or failing, or within the quiet period, it waits.
  expect(turn(changesRequested({}, handled)).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "pending", headSeenAt: t(0.5) })).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "expected", headSeenAt: t(0.5) })).group).toBe("waiting");
  // Checks still pending, or expected but never reported, an hour after the push count as settled.
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "pending" })).reason).toBe("handled");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "expected" })).reason).toBe("handled");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, ci: "fail" })).group).toBe("waiting");
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, handledAt: NOW - QUIET_MS / 2 })).group).toBe("waiting");
  // Handled before your last review doesn't count.
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { ...handled, handledAt: t(6), headSeenAt: t(7) })).group).toBe("waiting");
});

test("the assistant's all-addressed check counts only when you opt in", () => {
  const review = changesRequested({ latestHeadSha: "sha2", assessment: { headSha: "sha2", total: 4, addressed: 4, partial: 0, notAddressed: 0, disputed: 0, unclear: 0, assessedAt: t(1) } });
  expect(turn(review).group).toBe("waiting");
  expect(turn(review, { pushChecks: "progress" }).group).toBe("waiting");
  expect(turn(review, { pushChecks: "ready" })).toMatchObject({ group: "needs", reason: "looks-ready", label: "Looks ready" });
  // A check of an older head doesn't.
  expect(turn({ ...review, latestHeadSha: "sha3" }, { pushChecks: "ready" }).group).toBe("waiting");
});

test("an approval stays reviewed when new commits arrive", () => {
  expect(turn(changesRequested({ submittedVerdict: "APPROVE", latestHeadSha: "sha2" }))).toMatchObject({ group: "reviewed", label: "Approved · updated", updated: true });
});

test("a dismissed review is yours again, without an alert", () => {
  expect(turn(changesRequested({ submittedVerdict: null }))).toMatchObject({ group: "needs", reason: "dismissed", notify: false });
});

test("a comment review waits on the author only while it has threads", () => {
  expect(turn(changesRequested({ submittedVerdict: "COMMENT" }, { threads: null }))).toMatchObject({ group: "reviewed", label: "Commented" });
  expect(turn(changesRequested({ submittedVerdict: "COMMENT" }))).toMatchObject({ group: "waiting", label: "Commented" });
  // With every thread resolved or answered, nothing is open; new commits on top bring it back as handled.
  const handled = { threads: { total: 2, resolved: 1, answered: 1, questions: 0, open: 0, outdated: 0 }, handledAt: t(1), headSeenAt: t(2) };
  expect(turn(changesRequested({ submittedVerdict: "COMMENT" }, handled))).toMatchObject({ group: "reviewed", reason: "commented", label: "Commented" });
  expect(turn(changesRequested({ submittedVerdict: "COMMENT", latestHeadSha: "sha2" }, handled))).toMatchObject({ group: "needs", reason: "handled" });
});

test("a draft PR waits on the author", () => {
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { isDraft: true }))).toMatchObject({ group: "waiting", reason: "draft" });
});

test("generation relabels a review without moving it", () => {
  expect(turn(changesRequested({ status: "generating" }))).toMatchObject({ group: "waiting", label: "Generating" });
  expect(turn({ targetKey: "a", status: "generating" })).toMatchObject({ group: "needs", label: "Generating" });
  // A failed guide keeps why it's your turn, so its alert isn't lost.
  expect(turn(changesRequested({ status: "error" }, { requestedAt: t(1) }))).toMatchObject({ group: "needs", reason: "re-requested", label: "Failed", failed: true, signal: `re-requested:${t(1)}` });
  expect(turn(changesRequested({ status: "error" }))).toMatchObject({ group: "needs", reason: "waiting", label: "Failed", failed: true });
});

test("a local receipt counts until GitHub reports the review", () => {
  // You submitted locally an hour ago; GitHub still reports the earlier review and a request between the two.
  const review = changesRequested({ submittedAt: t(1) }, { requestedAt: t(2) });
  expect(turn(review).group).toBe("waiting");
});

test("blocking marks a changes-requested review that holds up the merge", () => {
  expect(turn(changesRequested({}, { blocking: true })).blocking).toBe(true);
  expect(turn(changesRequested({ latestHeadSha: "sha2" }, { blocking: true, requestedAt: t(1) }))).toMatchObject({ group: "needs", blocking: true });
});

test("progress prefers the assistant's check of the current head, then your threads", () => {
  const review = changesRequested({ latestHeadSha: "sha2" }, { threads: { total: 4, resolved: 1, answered: 1, questions: 0, open: 2, outdated: 0 } });
  expect(feedbackProgress(review)).toEqual({ done: 2, total: 4, source: "threads" });
  const checked = { ...review, assessment: { headSha: "sha2", total: 5, addressed: 3, partial: 1, notAddressed: 1, disputed: 0, unclear: 0, assessedAt: t(1) } };
  expect(feedbackProgress(checked)).toEqual({ done: 3, total: 5, source: "assistant" });
  expect(feedbackProgress({ targetKey: "a" })).toBeNull();
});

test("a handled turn holds until you act, even when the author pushes again", () => {
  const held = { reason: "handled" as const, label: "Feedback handled", signal: `handled:${t(1)}`, at: t(0.5) };
  // A new push restarted the quiet period, but the turn already came to you.
  const review = changesRequested({ latestHeadSha: "sha3", heldTurn: held }, { headSeenAt: NOW - 60_000, handledAt: t(1) });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "handled", signal: `handled:${t(1)}`, notify: false });
  // Your next review, or a snooze until the author responds, ends it.
  expect(turn({ ...review, submittedAt: NOW - 1000 }).group).toBe("waiting");
  expect(turn({ ...review, snoozedAt: NOW - 1000 }).group).toBe("waiting");
});

test("questions and mentions count whatever your verdict", () => {
  expect(turn(changesRequested({ submittedVerdict: "APPROVE" }, { questionAt: t(1) }))).toMatchObject({ group: "needs", reason: "question" });
  expect(turn(changesRequested({ submittedVerdict: "APPROVE" }, { mentionAt: t(1) }))).toMatchObject({ group: "needs", reason: "mentioned" });
  expect(turn(changesRequested({}, { questionAt: t(1), isDraft: true }))).toMatchObject({ group: "needs", reason: "question" });
});

test("the baseline is your latest review, here or on GitHub, and snoozing until the author responds needs one", () => {
  expect(baselineOf(changesRequested())).toEqual({ sha: "sha1", at: t(5), verdict: "REQUEST_CHANGES" });
  expect(baselineOf(changesRequested({ submittedAt: t(1), submittedHeadSha: "sha2" }))).toEqual({ sha: "sha2", at: t(1), verdict: "REQUEST_CHANGES" });
  const needs = changesRequested({}, { requestedAt: t(1) });
  expect(canSnooze(needs, turn(needs))).toBe(true);
  expect(canSnooze({ targetKey: "a", status: "ready" }, turn({ targetKey: "a", status: "ready" }))).toBe(false);
  const failed = changesRequested({ status: "error" }, { requestedAt: t(1) });
  expect(canSnooze(failed, turn(failed))).toBe(false);
});

const mine = (status: FeedbackThread["status"], body: string, replyAt: number | null = null): FeedbackThread => ({
  id: body, commentId: 1, reviewId: null, path: "a.ts", line: 1, originalLine: 1, startLine: null, side: "RIGHT", subjectType: "LINE",
  body, createdAt: t(5), isResolved: status === "resolved", resolvedBy: null, isOutdated: false, replies: [], status, replyAt,
});

test("a non-blocking thread doesn't hold Feedback handled or count in progress, and is counted apart", () => {
  const threads = [mine("resolved", "Drops writes."), mine("answered", "**Should fix:** rename", t(1)), mine("open", "**Nit:** spacing"), mine("open", "FYI: a helper exists")];
  const signals = threadSignals(threads);
  expect(signals.threads).toEqual({ total: 2, resolved: 1, answered: 1, questions: 0, open: 0, outdated: 0, nonBlocking: 2 });
  expect(signals.handledAt).toBe(t(1));
  const review = changesRequested({ latestHeadSha: "sha2" }, { ...signals, headSeenAt: t(2) });
  expect(turn(review)).toMatchObject({ group: "needs", reason: "handled", label: "Feedback handled" });
  expect(feedbackProgress(review)).toEqual({ done: 2, total: 2, source: "threads", nits: 2 });
  expect(progressText(feedbackProgress(review)!)).toBe("2/2 handled +2 nits");
  expect(progressText({ done: 1, total: 3, source: "assistant", nits: 1 })).toBe("1/3 addressed +1 nit");
  expect(progressText({ done: 1, total: 3, source: "assistant" })).toBe("1/3 addressed");
  // A question on one is still a question for you.
  const asked = threadSignals([...threads, mine("question", "nit: why not a map?", t(0.5))]);
  expect(asked).toMatchObject({ questionAt: t(0.5), threads: { total: 2, nonBlocking: 3 } });
  // Only non-blocking threads open on a comment review: nobody's waiting.
  const comment = { ...changesRequested({ submittedVerdict: "COMMENT" }, threadSignals([mine("open", "nit: spacing")])) };
  expect(turn(comment)).toMatchObject({ group: "reviewed", label: "Commented" });
  expect(feedbackProgress(comment)).toBeNull();
});

test("a relayed approval waiting for your click is in Needs review, whatever the review waited on, and alerts nothing of its own; a merged PR's is done", () => {
  const ready = { readyToApprove: { at: t(1) } };
  for (const review of [changesRequested(ready), changesRequested({ ...ready, userArchivedAt: t(2) }), changesRequested({ ...ready, snoozedAt: t(2) })]) {
    expect(computeTurn(review, undefined, NOW)).toMatchObject({ group: "needs", reason: "ready-to-approve", label: "Ready to approve", at: t(1), notify: false, signal: null });
  }
  expect(computeTurn(changesRequested({ ...ready, prState: "MERGED" }), undefined, NOW)).toMatchObject({ group: "archive", reason: "merged" });
});

test("a row waiting to be approved carries the alert of the turn beneath it: a new comment on your own PR, or a re-request", () => {
  const ready = { readyToApprove: { at: t(1) } };
  const own: TurnInput = { targetKey: "pr-1", kind: "pr", status: "tracked", prState: "OPEN", ownPr: true, ...ready, signals: { newComments: { count: 2, at: t(0.5), by: "bob" } } };
  expect(computeTurn(own, undefined, NOW)).toEqual({ ...computeTurn({ ...own, readyToApprove: null }, undefined, NOW), reason: "ready-to-approve", label: "Ready to approve", at: t(1),
    under: { reason: "new-comments", label: "Your PR · 2 new comments" } });
  expect(computeTurn(own, undefined, NOW)).toMatchObject({ signal: `comments:${t(0.5)}`, notify: true, eventAt: t(0.5) });
  const asked = changesRequested(ready, { requestedAt: t(0.5), requestedVia: "user" });
  expect(computeTurn(asked, undefined, NOW)).toMatchObject({ reason: "ready-to-approve", signal: `re-requested:${t(0.5)}`, notify: true, under: { reason: "re-requested" } });
});
