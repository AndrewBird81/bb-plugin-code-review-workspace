import { expect, test } from "vitest";
import type { Turn } from "./turn";
import { snoozeLabel } from "./turn";
import { GUIDE_STOPPED, needsGroup, reviewState, type ReviewItem } from "./review-state";
import { statusLine, statusWhy } from "./status-line";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse("2026-10-11T12:00:00Z");
const turn = (group: Turn["group"], reason: Turn["reason"], label = "", extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });
const review = (t: Turn, extra: Partial<ReviewItem> = {}): ReviewItem => ({ targetKey: "k", kind: "pr", status: "ready", turn: t, ...extra });
const knobs = { unattendedAgents: true, localDiffChanges: true };
const said = (r: ReviewItem) => { const part = statusWhy(r, knobs, now); return part && [part.text, part.tone, part.icon]; };
const line = (r: ReviewItem, passingChecks = false) => statusLine(r, { now, passingChecks, knobs }).map((part) => part.text);

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
  // Your PR with comments waiting for your reply, which bring it back to you.
  const commented = review(turn("needs", "new-comments", "Your PR · 3 new comments"), { ownPr: true, signals: { newComments: { count: 3, at: now - HOUR, by: "bob" } } });
  expect(said(commented)).toEqual(["Your PR · 3 new comments", "foreground", "MessageSquare"]);
  expect(statusWhy(commented, knobs, now)?.detail).toBe("The latest from @bob");
  expect(needsGroup(commented)).toBe("back");
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
  expect(statusWhy(review(requested, { status: "generating" }), knobs, now)).toEqual({ kind: "why", text: "Building guide…", tone: "agent", icon: "Loading", busy: true });
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error" }))).toEqual(["Guide failed", "danger", "AlertTriangle"]);
  // One waiting for its writer's machine to restart it says so, as its page does, until the wait ends (72-hands-on #2).
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error", restartPending: { since: now } }))).toEqual(["Waiting for the guide writer’s machine", "warning", "Clock"]);
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error", restartPending: null }))).toEqual(["Guide failed", "danger", "AlertTriangle"]);
  // A first guide you stopped didn't fail (bug bash LIV-2); it stays in Needs review.
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error", guideError: { at: now, text: GUIDE_STOPPED } }))).toEqual(["Guide stopped", "neutral", "Route"]);
  expect(said(review({ ...requested, failed: true, label: "Failed" }, { status: "error", guideError: { at: now, text: "The guide writer failed." } }))).toEqual(["Guide failed", "danger", "AlertTriangle"]);
  expect(statusWhy(review(turn("needs", "re-requested"), { verifyingSince: now - 60_000 }), knobs, now)).toMatchObject({ text: "Checking your feedback…", tone: "agent", busy: true });
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
  expect(statusLine(busy, { now, knobs }).map((part) => part.kind)).toEqual(["blocking", "why", "progress", "commits", "checks", "size"]);
  // Passing checks are news only where asked for, as on the Overview.
  const passing = review(turn("needs", "requested"), { signals: { ci: "pass" }, prSize: { additions: 2, deletions: 0, files: 1 } });
  expect(line(passing)).toEqual(["Review requested", "+2 −0 · 1 file"]);
  expect(line(passing, true)).toEqual(["Review requested", "Checks passing", "+2 −0 · 1 file"]);
  expect(line(review(turn("needs", "requested"), { signals: { ci: "expected", commitsSince: 1 } }))).toEqual(["Review requested", "+1 commit", "Checks expected"]);
  // Checks just read, as the Overview has them, say what they say now, not what the last sync saw.
  expect(statusLine(passing, { now, passingChecks: true, ci: "fail", knobs }).map((part) => part.text)).toEqual(["Review requested", "Checks failing", "+2 −0 · 1 file"]);
  expect(statusLine(passing, { now, passingChecks: true, ci: "none", knobs }).map((part) => part.text)).toEqual(["Review requested", "+2 −0 · 1 file"]);
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
  expect(statusLine(stacked, { now, knobs }).find((part) => part.kind === "unreachable")?.detail).toBe("GitHub refused access, for example for SSO");
  const bottom = review(turn("needs", "requested"), { stack: { members: [{ ...parent, reviewed: true }, { ...parent, targetKey: "pr-42", number: 42 }], index: 0, parent: null, children: [] } });
  expect(line(bottom)).toEqual(["Review requested", "Stack 1 of 2"]);
});

test("a run skipped while Start agents on their own was off says whether it still is", () => {
  const skipped = review(turn("needs", "requested"), { authorAssociation: "MEMBER", skippedRun: { run: "guide", head: "h", at: 1, why: "settings" } });
  const notRun = (unattendedAgents: boolean) => statusLine(skipped, { now, knobs: { ...knobs, unattendedAgents } }).find((part) => part.kind === "not-run")?.text;
  expect(notRun(false)).toBe("Not run automatically: Start agents on their own is off in Settings");
  expect(notRun(true)).toBe("Not run automatically: Start agents on their own was off in Settings when this came in");
});

// bug bash AGT-5: an automatic review that couldn't start says why, as the text it is.
test("a run that couldn't start says why", () => {
  const failed = review(turn("needs", "new"), { kind: "ref", skippedRun: { run: "review", head: null, at: 1, why: "failed", error: "Laptop is <b>offline</b>." } });
  expect(statusLine(failed, { now, knobs }).find((part) => part.kind === "not-run")?.text).toBe("Not run automatically: it couldn’t start (Laptop is <b>offline</b>)");
  const unsaid = review(turn("needs", "new"), { kind: "ref", skippedRun: { run: "review", head: null, at: 1, why: "failed" } });
  expect(statusLine(unsaid, { now, knobs }).find((part) => part.kind === "not-run")?.text).toBe("Not run automatically: it couldn’t start");
});

// bug bash LIV-2: a first guide you stopped is stored as status "error" with guideError "Stopped". Its page and bb review
// list say "Guide stopped", but All reviews and the Overview said "Guide failed", in red.
test("a guide you stopped says so, not that it failed, and still needs you", () => {
  const stopped = review({ ...turn("needs", "requested"), failed: true, label: "Failed" }, { status: "error", guideError: { at: now, text: GUIDE_STOPPED } });
  expect(reviewState(stopped)).toMatchObject({ group: "needs", failed: true });
  expect(statusWhy(stopped, knobs, now)).toEqual({ kind: "why", text: "Guide stopped", tone: "neutral", icon: "Route" });
});

test("a folder's review says what changed in its folder, that it's paused on another branch, or that its folder is gone", () => {
  const feature = { environmentId: "env1", hostId: "h", machine: "MaxBook", path: "/p", branch: "bb/snooze-thr_a1", baseRef: "main", repo: "acme/web" };
  expect(said(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: 3 } }))).toEqual(["3 files changed", "foreground", "FileDiff"]);
  expect(said(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: 1 } }))).toEqual(["1 file changed", "foreground", "FileDiff"]);
  expect(said(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: null } }))).toEqual(["Local review", "neutral", "GitBranch"]);
  // With Notice when a local review's code changes off, the last count isn't said.
  expect(statusWhy(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: 3 } }), { localDiffChanges: false }, now)?.text).toBe("Local review");
  expect(line(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: 3 } }))).toContain("3 files changed");
  expect(statusLine(review(turn("needs", "new"), { kind: "ref", feature: { ...feature, changedFiles: 3 } }), { now, knobs: { unattendedAgents: true, localDiffChanges: false } }).map((part) => part.text)).toContain("Local review");
  expect(said(review(turn("waiting", "paused", "Paused"), { kind: "ref", feature: { ...feature, pausedOn: "bb/fix-docs-thr_cd34" } }))).toEqual(["Paused: on fix-docs", "neutral", "GitBranch"]);
  expect(said(review(turn("archive", "folder-gone", "Folder removed"), { kind: "ref", feature: { ...feature, folderGone: true } }))).toEqual(["Folder removed", "neutral", "Folder"]);
});

test("comments sent to fix: how many the main thread reported while it works, then Ready to re-review with the count, back to you; archived first, back to you too; a local review's check is of its fixes", () => {
  const fixes = { sent: 3, reported: 1, inferred: 0, checked: 0, fixed: 0 };
  expect(said(review(turn("waiting", "fixes-sent", "1 of 3 reported"), { kind: "ref", fixes }))).toEqual(["1 of 3 reported", "neutral", "Send"]);
  const ready = review(turn("needs", "fixes-ready", "Ready to re-review"), { kind: "ref", fixes: { ...fixes, reported: 3, checked: 3, fixed: 2 } });
  expect(said(ready)).toEqual(["Ready to re-review · 3 of 3 reported", "foreground", "ArrowTurnBackward"]);
  expect(statusWhy(ready, knobs, now)?.detail).toBe("The main thread reported all 3 comments you sent. Checked: 2 look fixed, 1 doesn't");
  expect(needsGroup(ready)).toBe("back");
  const archived = review(turn("needs", "fixes-stopped", "Main thread archived · 1 of 3 reported"), { kind: "ref", fixes });
  expect(said(archived)).toEqual(["Main thread archived · 1 of 3 reported", "foreground", "Archive"]);
  expect(needsGroup(archived)).toBe("back");
  expect(said(review(turn("needs", "fixes-stopped", "Main thread deleted · 1 of 3 reported"), { kind: "ref", fixes }))?.[2]).toBe("Trash2");
  expect(statusWhy({ ...ready, verifyingSince: now - 60_000 }, knobs, now)).toMatchObject({ text: "Checking the fixes…", tone: "agent", busy: true });
  // On a PR, Check fixes says so; its other checks are of your feedback, Sends or not.
  const pr = review(turn("needs", "fixes-ready", "Ready to re-review"), { kind: "pr", fixes: { ...fixes, reported: 3 }, verifyingSince: now - 60_000 });
  expect(statusWhy({ ...pr, verifyingFixes: true }, knobs, now)?.text).toBe("Checking the fixes…");
  expect(statusWhy(pr, knobs, now)?.text).toBe("Checking your feedback…");
});
