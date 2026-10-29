// Turns what GitHub says about a PR into the signals the turn rules read.
import type { ReviewLifecycle, ReviewMeta } from "./store";
import type { FeedbackThread, PrFacts } from "./github/types";
import type { ReviewPreferences } from "./preferences";
import { feedbackProgress, newCommentsText, type Turn, type TurnOptions, type TurnSignals } from "../lib/turn";
import { verdictFromMine } from "./review-verdict";
import { threadLabel } from "./github/threads";
import { foreignHeadOwner } from "../lib/trust";

export function turnOptions(preferences: ReviewPreferences): TurnOptions {
  return { wakeOnReplies: preferences.wakeOnReplies, pushChecks: preferences.pushChecks, teamRequests: preferences.trackTeamRequests, mentions: preferences.knobs.mentionsWake, ownPrs: preferences.knobs.trackOwnPrs };
}

/** What the sync and the agents keep for the GitHub account reading the PR; another account starts without it. */
export const READER_STATE: ReviewLifecycle = {
  assessment: null, heldTurn: null, approvedHead: null, approvedAt: null, skippedRun: null, notifiedSignal: null, preparedSignal: null, pendingAlert: null,
};

/**
 * The review's state after a read of its PR. `startedAt` is when the read began:
 * a review submitted here after that is newer than GitHub's answer and stands.
 */
export function factsUpdate(previous: ReviewMeta, facts: PrFacts, viewer: string, startedAt: number, now: number): ReviewLifecycle {
  const s = previous.signals ?? {};
  // GitHub's editedAt follows the PR's body. A new title, which the agents read too, is an edit from when a read saw
  // it; once the PR is watched, as before then is history. The latest edit stands.
  const retitled = previous.watchingSince != null && !!previous.title && !!facts.title && facts.title !== previous.title ? now : null;
  const edits = [facts.editedAt, previous.prEditedAt, retitled].filter((at): at is number => at != null);
  const update: ReviewLifecycle = {
    prState: facts.state, startedPrState: null, latestHeadSha: facts.headSha, ...(facts.baseRefName ? { latestBase: facts.baseRefName } : {}), unreachable: null, prSize: facts.size ?? null,
    prLabels: facts.labels ?? [], prTeams: facts.reviewTeams ?? [], prReviewers: facts.reviewers ?? [],
    prUpdatedAt: Number.isFinite(facts.updatedAt) ? facts.updatedAt : null, prMergedAt: facts.mergedAt ?? null, prClosedAt: facts.closedAt ?? null,
    stackParent: facts.stackParent ?? null, ownPr: !!facts.author && facts.author.toLowerCase() === viewer.toLowerCase(), authorAssociation: facts.authorAssociation ?? null,
    foreignHeadOwner: foreignHeadOwner(facts.headForkOwner, facts.author, viewer), prEditedAt: edits.length ? Math.max(...edits) : null,
    archivedAt: facts.state === "OPEN" ? null : previous.archivedAt ?? now,
    // The account reading the PR, which the review's verdict and checks belong to.
    reviewer: viewer,
    ...(previous.reviewer && previous.reviewer !== viewer ? READER_STATE : {}),
  };
  const own = verdictFromMine(facts.myReviews);
  const local = previous.submittedAt ?? 0;
  if (local < startedAt) {
    // GitHub can lag right after a write: keep a review submitted here until GitHub reports it,
    // recognized by its id. Without one (older receipts), its time; after ten minutes, GitHub's word stands.
    const seen = previous.submittedReviewId ? facts.myReviews.some((r) => r.id === previous.submittedReviewId) : (own?.at ?? 0) >= local - 1000;
    if (own && (seen || now - local > RECEIPT_GRACE || own.verdict === null) || previous.reviewer && previous.reviewer !== viewer) {
      Object.assign(update, { submittedVerdict: own?.verdict ?? null, submittedAt: own?.at || null, submittedHeadSha: own?.sha ?? null, reviewer: viewer, submittedReviewId: null });
    }
  }
  const verdict = "submittedVerdict" in update ? update.submittedVerdict : previous.submittedVerdict;
  // A request to you outranks a later one to a team you're on. A pending request keeps its time if its event scrolls out of the timeline.
  const request = facts.requests.filter((r) => r.via === "user").at(-1) ?? facts.requests.at(-1)
    ?? (facts.requestPending && s.requestedAt ? { at: s.requestedAt, by: s.requestedBy ?? null, via: s.requestedVia ?? facts.requestPending.via } : undefined);
  const others = facts.otherOpinions;
  // GitHub reads your last 30 reviews, and each thread reply is one, so past 30 replies none may be a real review.
  // Your reviews don't go away: the last one this account read stands.
  const kept = !own && (!previous.reviewer || previous.reviewer === viewer) && s.lastReviewAt != null;
  const lastSha = own ? own.sha : kept ? s.lastReviewSha ?? null : null;
  const reviewedAt = lastSha ? facts.commits.lastIndexOf(lastSha) : -1;
  // When the timeline no longer says when GitHub dismissed your review, the first read that saw it stands in.
  const dismissedAt = facts.myReviews.filter((r) => r.state === "DISMISSED").at(-1)?.dismissedAt;
  const dismissed = own?.verdict === null ? (dismissedAt ?? s.dismissedAt ?? (previous.submittedVerdict ? now : own.at)) : kept ? s.dismissedAt ?? null : null;
  // A new review of yours ends a turn that was holding for you.
  if (own && own.at > (s.lastReviewAt ?? 0) && previous.heldTurn) update.heldTurn = null;
  update.signals = {
    ...s,
    dismissedAt: dismissed,
    lastReviewAt: own ? own.at : kept ? s.lastReviewAt : null,
    lastReviewSha: lastSha,
    rounds: kept ? s.rounds ?? [] : facts.myReviews.slice(-10).map((r) => ({ state: r.state, at: r.submittedAt, sha: r.sha })),
    requestedAt: request?.at ?? null,
    requestedBy: request?.by ?? null,
    // What's pending says how you're asked now: a direct request's event can scroll out while a team one's stays.
    requestedVia: facts.requestPending?.via ?? request?.via ?? null,
    requestPending: !!facts.requestPending,
    isDraft: facts.isDraft,
    headSeenAt: facts.headSha !== previous.latestHeadSha ? now : s.headSeenAt ?? now,
    ci: facts.ci,
    mentionAt: facts.mention?.at ?? null,
    mentionBy: facts.mention?.by ?? null,
    blocking: verdict === "REQUEST_CHANGES" && others.length > 0 && others.every((o) => o.state === "APPROVED"),
    commitsSince: reviewedAt >= 0 ? facts.commits.length - 1 - reviewedAt : null,
    author: facts.author,
  };
  update.reviewBodies = kept ? previous.reviewBodies ?? [] : facts.myReviews.filter((r) => r.body.trim()).slice(-3)
    .map((r) => ({ state: r.state, at: r.submittedAt, body: r.body.slice(0, 4000) }));
  return update;
}

const RECEIPT_GRACE = 10 * 60_000;

/**
 * Your threads' standing, as signals. Non-blocking threads are counted apart, and hold nothing but questions. On your
 * own PR (`ownPr`), also the comments waiting for your reply on everyone's threads.
 */
export function threadSignals(all: ReadonlyArray<FeedbackThread & { resolvedSeenAt?: number | null }>, ownPr = false): Pick<TurnSignals, "threads" | "questionAt" | "questionBy" | "replyAt" | "handledAt" | "newComments"> {
  const threads = all.filter((t) => !threadLabel(t.body)?.nonBlocking);
  const count = (status: FeedbackThread["status"]) => threads.filter((t) => t.status === status).length;
  const tally = {
    total: threads.length, resolved: count("resolved"), answered: count("answered"), questions: count("question"),
    open: count("open"), outdated: threads.filter((t) => t.isOutdated).length, nonBlocking: all.length - threads.length,
  };
  const latest = (times: Array<number | null | undefined>) => times.reduce<number | null>((max, t) => t != null && t > (max ?? 0) ? t : max, null);
  const handled = tally.total > 0 && tally.open === 0 && tally.questions === 0;
  const questionAt = latest(all.filter((t) => t.status === "question").map((t) => t.replyAt));
  const asked = all.find((t) => t.status === "question" && t.replyAt === questionAt);
  const waiting = all.flatMap((t) => t.needsReply ? [t.needsReply] : []);
  const newest = waiting.reduce<typeof waiting[number] | null>((max, w) => w.at > (max?.at ?? -Infinity) ? w : max, null);
  return {
    ...(ownPr ? { newComments: newest ? { count: waiting.reduce((sum, w) => sum + w.comments, 0), threads: waiting.length, at: newest.at, by: newest.by } : null } : {}),
    threads: all.length ? tally : null,
    questionAt,
    questionBy: asked?.replies.filter((r) => r.createdAt === questionAt && !r.mine).at(-1)?.author ?? null,
    replyAt: latest(all.filter((t) => t.status === "question" || t.status === "answered").map((t) => t.replyAt)),
    handledAt: handled ? latest(threads.map((t) => t.status === "resolved" ? t.resolvedSeenAt ?? null : t.replyAt)) : null,
  };
}

/** The Needs You alert's text: why it's your turn, then progress, CI, and commits. */
export function alertBody(review: ReviewMeta, turn: Turn): string {
  const s = review.signals ?? {};
  const author = s.author ? `@${s.author}` : "The author";
  const why: Partial<Record<Turn["reason"], string>> = {
    "re-requested": `${s.requestedBy ? `@${s.requestedBy}` : author} re-requested your review`,
    requested: `${s.requestedBy ? `@${s.requestedBy}` : author} requested your review`,
    question: `${s.questionBy ? `@${s.questionBy}` : author} asked you something on your feedback`,
    mentioned: `${s.mentionBy ? `@${s.mentionBy}` : author} mentioned you`,
    handled: `Every thread of your feedback is resolved or answered${s.threads?.nonBlocking ? ", apart from nits" : ""}`,
    "looks-ready": "The assistant found all your feedback addressed",
    "new-comments": s.newComments?.count === 1 ? `${s.newComments.by ? `@${s.newComments.by}` : "Someone"} commented on your PR`
      : `${s.newComments ? newCommentsText(s.newComments) : "New comments"} on your PR${s.newComments?.by ? `, the latest from @${s.newComments.by}` : ""}`,
  };
  if (turn.reason === "question" && turn.label === "Author replied") why.question = `${author} replied to your feedback`;
  const progress = feedbackProgress(review);
  const parts = [
    why[turn.reason] ?? "It’s your turn to review",
    progress && `${progress.done}/${progress.total} ${progress.source === "assistant" ? "addressed" : "resolved or answered"}`,
    s.ci === "pass" ? "CI passing" : s.ci === "fail" ? "CI failing" : s.ci === "pending" ? "CI running" : null,
    s.commitsSince ? `${s.commitsSince} new commit${s.commitsSince === 1 ? "" : "s"}` : null,
    turn.blocking ? "only your review blocks the merge" : null,
    review.status === "ready" && turn.reason === "requested" ? "guide ready" : null,
  ];
  return parts.filter(Boolean).join(" · ").slice(0, 600);
}
