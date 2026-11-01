import { expect, test } from "vitest";
import { computeTurn, type TurnInput } from "./turn";
import { sinceOf, standingKey, standingOf } from "./review-status";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const t = (hoursAgo: number) => NOW - hoursAgo * 3_600_000;
const standing = (review: TurnInput & Parameters<typeof standingOf>[0]) => standingOf(review, computeTurn(review, undefined, NOW));
const local = (extra: Parameters<typeof standingOf>[0] = {}) => ({ targetKey: "br-1", kind: "ref" as const, status: "ready" as const, createdAt: t(9), ...extra });

test("who a review waits on follows its turn: you in Needs review, the thread fixing or pushing, the PR's author, or no one", () => {
  expect(standing(local())).toEqual({ waitsOn: "user", thread: null, approved: false, archived: false });
  const sends = [{ n: 1, at: t(3), threadId: "coder", ids: ["c1"] }];
  expect(standing(local({ sends, fixes: { sent: 1, reported: 0, inferred: 0, checked: 0, fixed: 0 } }))).toMatchObject({ waitsOn: "agent", thread: "coder" });
  expect(standing(local({ push: { state: "pushing", at: t(1), threadId: "main" } }))).toMatchObject({ waitsOn: "agent", thread: "main" });
  const changes = { targetKey: "pr-1", kind: "pr" as const, status: "ready" as const, headSha: "a", latestHeadSha: "a", submittedVerdict: "REQUEST_CHANGES" as const, submittedHeadSha: "a",
    signals: { lastReviewAt: t(5), lastReviewSha: "a", threads: { total: 1, resolved: 0, answered: 0, questions: 0, open: 1, outdated: 0 } } };
  expect(standing(changes)).toMatchObject({ waitsOn: "author", thread: null });
  // Snoozed, a draft PR, a folder on another branch or removed: no one, as in Archive.
  expect(standing({ ...changes, snoozedAt: t(1) })).toMatchObject({ waitsOn: "nobody" });
  expect(standing({ ...changes, signals: { ...changes.signals, isDraft: true } })).toMatchObject({ waitsOn: "nobody" });
  expect(standing(local({ feature: { pausedOn: "main" } }))).toMatchObject({ waitsOn: "nobody" });
  expect(standing(local({ feature: { folderGone: true } }))).toMatchObject({ waitsOn: "nobody" });
  expect(standing({ ...changes, prState: "MERGED" })).toEqual({ waitsOn: "nobody", thread: null, approved: false, archived: true });
});

test("approved is your approval of the code as it is now: on GitHub at the PR's head, or in the main thread while it covers it", () => {
  const approved = { targetKey: "pr-1", kind: "pr" as const, status: "ready" as const, headSha: "a", latestHeadSha: "a", submittedVerdict: "APPROVE" as const, submittedHeadSha: "a", signals: { lastReviewAt: t(5), lastReviewSha: "a" } };
  expect(standing(approved)).toMatchObject({ waitsOn: "nobody", approved: true });
  expect(standing({ ...approved, latestHeadSha: "b" })).toMatchObject({ waitsOn: "nobody", approved: false });
  // Asked again, it waits on you, approved still.
  expect(standing({ ...approved, signals: { ...approved.signals, requestedAt: t(1), requestedVia: "user" as const } })).toMatchObject({ waitsOn: "user", approved: true });
  expect(standing(local({ approvalSent: { at: t(2) } }))).toMatchObject({ waitsOn: "nobody", approved: true });
  expect(standing(local({ approvalSent: { at: t(2) }, feature: { changedFiles: 2 } }))).toMatchObject({ waitsOn: "user", approved: false });
  // Your own PR, a teammate's comment since: yours, the approval standing.
  const own = { targetKey: "br-1", kind: "pr" as const, status: "ready" as const, ownPr: true, headSha: "a", latestHeadSha: "a", createdAt: t(9), approvalSent: { at: t(2) } };
  expect(standing(own)).toMatchObject({ waitsOn: "nobody", approved: true });
  expect(standing({ ...own, signals: { newComments: { count: 1, at: t(1), by: "dana" } } })).toMatchObject({ waitsOn: "user", approved: true });
  expect(standing({ ...own, latestHeadSha: "b" })).toMatchObject({ waitsOn: "user", approved: false });
});

test("since is the event behind the standing, where it's no earlier than the last standing began; else when it's first seen so", () => {
  const key = standingKey({ waitsOn: "agent", thread: "coder", approved: false, archived: false });
  expect(key).toBe("agent");
  expect(standingKey({ waitsOn: "nobody", thread: null, approved: true, archived: true })).toBe("nobody+approved+archived");
  // Nothing kept yet: the event's time.
  expect(sinceOf(null, key, t(3), NOW)).toEqual({ key, at: t(3) });
  // Comments sent after you were asked: when they went.
  expect(sinceOf({ key: "user", at: t(5) }, key, t(3), NOW)).toEqual({ key, at: t(3) });
  // Back to Ready, since a time from before the approval it follows: when that's seen.
  expect(sinceOf({ key: "nobody+approved", at: t(2) }, "user", t(9), NOW)).toEqual({ key: "user", at: NOW });
  expect(sinceOf({ key: "nobody", at: t(2) }, "user", null, NOW)).toEqual({ key: "user", at: NOW });
  // As it stands still: kept, and moved on by a newer event behind it, as another Send; never back.
  expect(sinceOf({ key, at: t(3) }, key, t(3), NOW)).toEqual({ key, at: t(3) });
  expect(sinceOf({ key, at: t(3) }, key, t(1), NOW)).toEqual({ key, at: t(1) });
  expect(sinceOf({ key, at: t(1) }, key, t(3), NOW)).toEqual({ key, at: t(1) });
  // Never later than now, as an event GitHub dates a moment ahead.
  expect(sinceOf(null, key, NOW + 5_000, NOW)).toEqual({ key, at: NOW });
});
