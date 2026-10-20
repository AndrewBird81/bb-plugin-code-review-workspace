// Whose turn a review is: the reviewer's (Needs review), the author's (Waiting
// on author), nobody's (Reviewed), or done (Archive). Pure, so the server and
// the panel agree; the server attaches its result to every review it returns.
import type { Verdict } from "../src/draft";

export type TurnGroup = "needs" | "waiting" | "reviewed" | "archive";

export type TurnReason =
  | "merged" | "closed" | "archived" | "unrequested" | "unreachable"
  | "failed"
  | "new" | "requested" | "team-requested" | "re-requested"
  | "question" | "mentioned" | "handled" | "looks-ready" | "dismissed"
  | "waiting" | "draft" | "snoozed"
  | "approved" | "commented"
  | "own";

/** Your review threads on the PR, by where each stands. */
export interface ThreadTally {
  total: number;
  /** Resolved on GitHub. */
  resolved: number;
  /** The author answered after your last comment, and it isn't a question. */
  answered: number;
  /** The author asked you something after your last comment. */
  questions: number;
  /** No response since your last comment. */
  open: number;
  /** The code under the comment changed. Overlaps the others. */
  outdated: number;
  /** Threads whose first comment says nit, FYI, optional, or non-blocking; the counts above leave them out. */
  nonBlocking?: number;
}

export interface ReviewRound {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  at: number;
  sha: string | null;
}

/** What GitHub says about the PR, as the turn rules need it. Times are epoch ms. */
export interface TurnSignals {
  /** Your latest real review (reply-only reviews don't count), and the commit it reviewed. */
  lastReviewAt?: number | null;
  lastReviewSha?: string | null;
  /** Your real reviews, oldest first. */
  rounds?: ReviewRound[];
  /** The latest review request for you or a team you're on, who made it, and how. */
  requestedAt?: number | null;
  requestedBy?: string | null;
  requestedVia?: "user" | "team" | null;
  /** A request for you or your team is pending on GitHub now. */
  requestPending?: boolean;
  isDraft?: boolean;
  /** When bb first saw the current head commit. */
  headSeenAt?: number | null;
  /** expected: a required check that hasn't reported. */
  ci?: "pass" | "fail" | "pending" | "expected" | "none";
  threads?: ThreadTally | null;
  /** The latest reply on one of your threads that asks you something: the author's, or a mention of you. */
  questionAt?: number | null;
  /** Who asked it. */
  questionBy?: string | null;
  /** The latest author reply on one of your threads. */
  replyAt?: number | null;
  /** When the last of your threads became resolved or answered; null while any is waiting on the author. */
  handledAt?: number | null;
  /** The latest comment on the PR, by someone else, that mentions you. */
  mentionAt?: number | null;
  mentionBy?: string | null;
  /** When bb saw GitHub dismiss your latest review. */
  dismissedAt?: number | null;
  /** Your changes-requested is what's left: everyone else who reviewed approved. */
  blocking?: boolean;
  /** Commits on the PR since your last review, when known. */
  commitsSince?: number | null;
  /** The PR's author. */
  author?: string | null;
}

/** The review assistant's latest check of your feedback, for one head commit. */
export interface AssessmentSummary {
  headSha: string;
  total: number;
  addressed: number;
  partial: number;
  notAddressed: number;
  disputed: number;
  unclear: number;
  assessedAt: number;
}

/** The review fields the rules read. */
export interface TurnInput {
  targetKey?: string;
  kind?: "pr" | "ref";
  status?: "generating" | "ready" | "error" | "tracked";
  createdAt?: number;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  archivedAt?: number | null;
  userArchivedAt?: number | null;
  submittedVerdict?: Verdict | null;
  submittedAt?: number | null;
  submittedHeadSha?: string | null;
  latestHeadSha?: string;
  headSha?: string;
  signals?: TurnSignals | null;
  snoozedAt?: number | null;
  /** Snooze until: set aside at snoozedAt until this time, or a newer signal. Without it, snoozedAt snoozes until the author responds. */
  snoozedUntil?: number | null;
  /** Snoozed until the head's checks finish: snoozedUntil is then the latest it waits, for checks that never report. */
  snoozedUntilChecks?: boolean | null;
  assessment?: AssessmentSummary | null;
  /** GitHub can't find the PR, or refuses access, since `since`. */
  unreachable?: { since: number; reason: "not-found" | "forbidden" } | null;
  /** You wrote the PR: GitHub allows you only a comment review, and there's no author to wait on. */
  ownPr?: boolean | null;
  /** A turn that came from a passing state (feedback handled, looks ready); it holds until you act. */
  heldTurn?: { reason: TurnReason; label: string; signal: string; at: number } | null;
}

export interface TurnOptions {
  /** Which author replies on your threads make it your turn. */
  wakeOnReplies: "questions" | "any";
  /** "ready": the assistant judging every item addressed makes it your turn. */
  pushChecks: "off" | "progress" | "ready";
  /** How long the author must be quiet before "Feedback handled" counts. */
  quietMs?: number;
  /** false: a PR found on GitHub only through a team request leaves your list. */
  teamRequests?: boolean;
  /** false: a mention doesn't make it your turn. */
  mentions?: boolean;
}

export interface Turn {
  group: TurnGroup;
  reason: TurnReason;
  /** The status badge. */
  label: string;
  /** Identifies the event that made it your turn; a new one alerts again. Null when it isn't your turn. */
  signal: string | null;
  /** When the current state began, for "your turn for 2d". */
  at: number | null;
  /** Whether becoming your turn this way deserves a Needs You alert. */
  notify: boolean;
  /** Everyone else approved; only your changes-requested is left. */
  blocking: boolean;
  /** The head moved since your last review. */
  updated: boolean;
  /** When the event behind this turn happened, such as the re-request. Null when there isn't one. */
  eventAt: number | null;
  /** The guide couldn't be (re)generated; the turn underneath still stands. */
  failed: boolean;
}

export const QUIET_MS = 10 * 60_000;
/** How long GitHub must not find a PR before it goes to Archive. */
export const UNREACHABLE_MS = 7 * 86_400_000;
/** How long after a push checks may stay pending or expected before they count as settled: some never report. */
export const CI_STALE_MS = 60 * 60_000;
export const defaultTurnOptions: TurnOptions = { wakeOnReplies: "questions", pushChecks: "off" };
/** The badge of a review snoozed until its checks finish. */
export const CHECKS_SNOOZE_LABEL = "Snoozed until checks finish";

const VERDICT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };

/** Whether `t` is a time later than every floor. */
function after(t: number | null | undefined, ...floors: Array<number | null | undefined>): t is number {
  return typeof t === "number" && floors.every((floor) => t > (floor ?? 0));
}

export function computeTurn(review: TurnInput, options: TurnOptions = defaultTurnOptions, now = Date.now()): Turn {
  const s = review.signals ?? {};
  const head = review.latestHeadSha ?? review.headSha;
  // A review submitted here counts until GitHub reports it.
  const local = (review.submittedAt ?? 0) > (s.lastReviewAt ?? 0);
  const reviewedSha = (local ? review.submittedHeadSha : s.lastReviewSha ?? review.submittedHeadSha) ?? null;
  const updated = !!(head && reviewedSha && head !== reviewedSha);
  const base = { signal: null, at: null, notify: false, blocking: false, updated, eventAt: null, failed: false };
  const make = (group: TurnGroup, reason: TurnReason, label: string, extra: Partial<Turn> = {}): Turn =>
    ({ ...base, group, reason, label, ...extra });

  if (review.prState === "MERGED") return make("archive", "merged", "Merged");
  if (review.prState === "CLOSED" || review.archivedAt) return make("archive", "closed", "Closed");
  // Deleted, or out of your reach for good; access refused (say, for SSO) may come back.
  if (review.unreachable?.reason === "not-found" && now - review.unreachable.since >= UNREACHABLE_MS) return make("archive", "unreachable", "Can’t read on GitHub");

  // A local receipt counts until GitHub reports the review.
  const lastReviewAt = Math.max(s.lastReviewAt ?? 0, review.submittedAt ?? 0) || null;
  const reviewed = lastReviewAt !== null || !!review.submittedVerdict;
  // A snooze until a time ends then, and the review is back as it was; one until checks finish ends when they do, passing or failing.
  const checksDone = !!review.snoozedUntilChecks && checksFinished(s);
  const woke = review.snoozedUntil != null && (now >= review.snoozedUntil || checksDone);
  const snoozedAt = woke ? null : review.snoozedAt ?? null;
  const until = woke ? null : review.snoozedUntil ?? null;
  const snoozedLabel = until ? review.snoozedUntilChecks ? CHECKS_SNOOZE_LABEL : "Snoozed" : "Snoozed until the author responds";
  // Only a request to you asks you again; a team you're on being asked doesn't.
  const reRequested = reviewed && s.requestedVia !== "team" && after(s.requestedAt, lastReviewAt);

  // A person asking you again outranks your own archive.
  if (review.userArchivedAt && !(reRequested && after(s.requestedAt, review.userArchivedAt))) {
    return make("archive", "archived", "Archived");
  }
  const turn = reviewerTurn();
  // A failed guide needs you to retry, without losing why it's your turn.
  if (review.status === "error") return { ...turn, group: "needs", label: "Failed", failed: true };
  // Generation shows where the review stands; it doesn't move it.
  return review.status === "generating" ? { ...turn, label: "Generating" } : turn;

  function reviewerTurn(): Turn {
    if (review.kind === "ref") return make("needs", "new", "Ready", { at: review.createdAt ?? null });
    const tracked = review.status === "tracked";
    // Your own PR is yours to review until you have; then nothing brings it back.
    if (review.ownPr) {
      if (!reviewed && until) return make("waiting", "snoozed", snoozedLabel, { at: snoozedAt });
      if (!reviewed) return make("needs", "own", "Your PR", { at: review.createdAt ?? null });
      return make("reviewed", "own", updated ? "Your PR · updated" : "Your PR");
    }
    if (!reviewed) {
      if (tracked && s.isDraft) return make("waiting", "draft", "Draft");
      // A PR found on GitHub that no longer asks for you, or only asks a team when you've left those out.
      if (tracked && review.signals && (!s.requestPending || s.requestedVia === "team" && options.teamRequests === false)) {
        return make("archive", "unrequested", "No longer requested");
      }
      // Only a newer request wakes a snoozed one.
      if (until && !after(s.requestedAt, snoozedAt)) return make("waiting", "snoozed", snoozedLabel, { at: snoozedAt });
      if (s.requestPending || s.requestedAt) {
        const team = s.requestedVia === "team";
        return make("needs", team ? "team-requested" : "requested", team ? "Team review requested" : "Review requested", {
          signal: `requested:${s.requestedAt ?? "pending"}`, at: s.requestedAt ?? review.createdAt ?? null, notify: !team, eventAt: s.requestedAt ?? null,
        });
      }
      return make("needs", "new", tracked ? "Tracked" : "Ready", { at: review.createdAt ?? null });
    }

    const verdict = review.submittedVerdict ?? null;
    const blocking = verdict === "REQUEST_CHANGES" && !!s.blocking;
    const needs = (reason: TurnReason, label: string, signal: string, at: number, notify: boolean, eventAt = at) =>
      make("needs", reason, label, { signal, at, notify, blocking, eventAt });

    if (reRequested && after(s.requestedAt, snoozedAt)) {
      return needs("re-requested", "Re-requested", `re-requested:${s.requestedAt}`, s.requestedAt, true);
    }
    // GitHub dismissed your review, for example a stale approval.
    if (!verdict) {
      if (after(lastReviewAt, snoozedAt)) return needs("dismissed", "Review dismissed", `dismissed:${lastReviewAt}`, lastReviewAt!, false, s.dismissedAt ?? lastReviewAt!);
      return make("waiting", "snoozed", snoozedLabel, { at: snoozedAt });
    }
    // Someone asking you something is your turn whatever your verdict: a question on your thread, or any reply if you chose that, or a mention.
    const threads = s.threads;
    const hasThreads = !!threads && threads.total > 0;
    const replyAt = options.wakeOnReplies === "any" ? Math.max(s.replyAt ?? 0, s.questionAt ?? 0) || null : s.questionAt;
    if (after(replyAt, lastReviewAt, snoozedAt)) {
      const question = replyAt === s.questionAt;
      return needs("question", question ? "Question for you" : "Author replied", `reply:${replyAt}`, replyAt, true);
    }
    if (options.mentions !== false && after(s.mentionAt, lastReviewAt, snoozedAt)) {
      return needs("mentioned", "Mentioned you", `mention:${s.mentionAt}`, s.mentionAt, true);
    }
    if (s.isDraft) return make(verdict === "APPROVE" ? "reviewed" : "waiting", "draft", "Draft", { updated });
    if (verdict === "APPROVE") return make("reviewed", "approved", updated ? "Approved · updated" : "Approved");
    if (verdict === "COMMENT" && !hasThreads) return make("reviewed", "commented", "Commented");

    // A handled or looks-ready turn holds until you act, even if the author pushes again.
    const held = review.heldTurn;
    if (held && after(held.at, lastReviewAt, snoozedAt)) return needs(held.reason, held.label, held.signal, held.at, false);
    // Every thread resolved or answered, new commits, CI settled, and the author quiet for a while.
    const quietAt = Math.max(s.headSeenAt ?? 0, s.handledAt ?? 0) + (options.quietMs ?? QUIET_MS);
    if (hasThreads && updated && s.ci !== "fail" && ciSettled(s, now) && now >= quietAt && after(s.handledAt, lastReviewAt, snoozedAt)) {
      return needs("handled", "Feedback handled", `handled:${s.handledAt}`, quietAt, true, s.handledAt);
    }
    const assessment = review.assessment;
    if (options.pushChecks === "ready" && assessment && assessment.headSha === head && updated && assessment.total > 0
      && assessment.addressed === assessment.total && after(assessment.assessedAt, lastReviewAt, snoozedAt)) {
      return needs("looks-ready", "Looks ready", `looks-ready:${head}`, assessment.assessedAt, true);
    }
    // A comment review with nothing open isn't waiting on anyone.
    if (verdict === "COMMENT" && threads!.open + threads!.questions === 0) return make("reviewed", "commented", "Commented");
    if (snoozedAt && snoozedAt >= (lastReviewAt ?? 0)) return make("waiting", "snoozed", snoozedLabel, { at: snoozedAt, blocking });
    return make("waiting", "waiting", VERDICT_LABEL[verdict], { at: lastReviewAt, blocking });
  }
}

/** Whether the head's checks have finished, passing or failing, for a snooze until they do. */
export function checksFinished(s: TurnSignals | null | undefined): boolean {
  return s?.ci !== "pending";
}

/** Whether the head's checks are done, or have been pending or expected so long they never will be. */
export function ciSettled(s: TurnSignals, now = Date.now()): boolean {
  return (s.ci !== "pending" && s.ci !== "expected") || now - (s.headSeenAt ?? now) >= CI_STALE_MS;
}

/**
 * Progress on your feedback for a list row, such as "2/5 addressed", and `nits`, your non-blocking threads,
 * which it leaves out. Null when there's nothing to count.
 */
export function feedbackProgress(review: TurnInput): { done: number; total: number; source: "assistant" | "threads"; nits?: number } | null {
  const head = review.latestHeadSha ?? review.headSha;
  const a = review.assessment;
  const t = review.signals?.threads;
  const nits = t?.nonBlocking ? { nits: t.nonBlocking } : {};
  if (a && a.total > 0 && a.headSha === head) return { done: a.addressed, total: a.total, source: "assistant", ...nits };
  if (t && t.total > 0) return { done: t.resolved + t.answered, total: t.total, source: "threads", ...nits };
  return null;
}

/** How progress reads: "2/5 addressed", or "2/5 handled" (resolved or answered) from GitHub, then "+2 nits". */
export function progressText(progress: NonNullable<ReturnType<typeof feedbackProgress>>): string {
  const nits = progress.nits ? ` +${progress.nits} nit${progress.nits === 1 ? "" : "s"}` : "";
  return `${progress.done}/${progress.total} ${progress.source === "assistant" ? "addressed" : "handled"}${nits}`;
}

/** The commit and time your feedback came from: your latest real review, or a newer one submitted here. */
export function baselineOf(review: TurnInput): { sha: string | null; at: number | null; verdict: Verdict | null } {
  const s = review.signals ?? {};
  const local = (review.submittedAt ?? 0) > (s.lastReviewAt ?? 0);
  return {
    sha: (local ? review.submittedHeadSha : s.lastReviewSha ?? review.submittedHeadSha) ?? null,
    at: (local ? review.submittedAt : s.lastReviewAt ?? review.submittedAt) ?? null,
    verdict: review.submittedVerdict ?? null,
  };
}

/** Whether snoozing until the author responds applies: it's your turn on a review you've already given, and the guide didn't fail. */
export function canSnooze(review: TurnInput, turn: Turn): boolean {
  return turn.group === "needs" && !turn.failed && baselineOf(review).at !== null;
}

/** Whether "Snooze until" applies: it's your turn on a PR, new request or not, and the guide didn't fail. */
export function canSnoozeUntil(review: TurnInput, turn: Turn): boolean {
  return turn.group === "needs" && !turn.failed && review.kind !== "ref";
}

/** Whether "Until checks finish" applies: a snooze until a time does, and the head's checks are still running. */
export function canSnoozeUntilChecks(review: TurnInput, turn: Turn, now = Date.now()): boolean {
  return canSnoozeUntil(review, turn) && !ciSettled(review.signals ?? {}, now);
}

/** When each snooze choice wakes, in local time: three hours from now (until 9 PM), and 9 AM tomorrow or next Monday. */
export function snoozeTimes(now = Date.now()): { laterToday: number | null; tomorrow: number; nextMonday: number } {
  const date = new Date(now);
  const morning = (days: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.getTime(); };
  return { laterToday: date.getHours() < 21 ? now + 3 * 3_600_000 : null, tomorrow: morning(1), nextMonday: morning((8 - date.getDay()) % 7 || 7) };
}

/** A snoozed review's badge: "Snoozed until 3:00 PM", "until tomorrow 9:00 AM", "until Mon 9:00 AM", or "until Oct 20". */
export function snoozeLabel(until: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  // Rounded, for days 23 or 25 hours long.
  const days = Math.round((day(until) - day(now)) / 86_400_000);
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `Snoozed until ${time}`;
  if (days === 1) return `Snoozed until tomorrow ${time}`;
  if (days < 7) return `Snoozed until ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `Snoozed until ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
