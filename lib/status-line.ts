// Where a review stands, in one vocabulary for the inbox's rows, BB's thread list and the review's Overview: why it's
// yours (or whose turn it is, or how it ended), then only the facts that change whether to open it now. Icon and text,
// never color alone.
import type { Tone } from "../components/ui/badge";
import type { IconName } from "../components/ui/icon";
import { timeAgo } from "../components/time-ago";
import { reviewState, type ReviewItem } from "./review-state";
import { notRunReason } from "./trust";
import { baselineOf, progressText, snoozeLabel, type TurnSignals } from "./turn";

/** foreground: plain text that stands out, for what came back to you; the tones color only what changes your next move. */
export type StatusTone = Tone | "foreground";

export type StatusKind = "blocking" | "why" | "not-run" | "unreachable" | "progress" | "commits" | "checks" | "size" | "stack" | "stack-unreviewed";

export interface StatusPart {
  kind: StatusKind;
  text: string;
  tone: StatusTone;
  icon?: IconName;
  /** Work under way: its icon spins. */
  busy?: boolean;
  /** What it means in full, for a tooltip. */
  detail?: string;
}

const why = (text: string, tone: StatusTone, icon?: IconName, extra: Partial<StatusPart> = {}): StatusPart => ({ kind: "why", text, tone, ...(icon ? { icon } : {}), ...extra });

/** Why the review is where it is: agent work under way, whose turn it is and why, or how it ended. */
export function statusWhy(review: ReviewItem, now = Date.now()): StatusPart | null {
  const turn = reviewState(review);
  const s = review.signals ?? {};
  const by = (prefix: string, login: string | null | undefined, otherwise: string) => login ? `${prefix} @${login}` : otherwise;
  const ago = (at: number | null | undefined) => { const elapsed = timeAgo(at, now); return elapsed ? ` ${elapsed}` : ""; };
  if (review.status === "generating") return why("Building guide…", "agent", "Loading", { busy: true });
  if (turn.failed) return why("Guide failed", "danger", "AlertTriangle");
  if (review.verifyingSince && turn.group !== "archive") return why("Checking your feedback…", "agent", "Loading", { busy: true });
  switch (turn.reason) {
    case "re-requested": return why(by("Re-requested by", s.requestedBy, "Re-requested"), "foreground", "Repeat");
    case "requested": return why(by("Requested by", s.requestedBy, "Review requested"), "neutral", "UserRoundPlus");
    case "team-requested": return why(by("Team request from", s.requestedBy, "Team review requested"), "neutral", "UserRoundPlus");
    case "question": {
      // "Any reply" brings a review back for an answer that isn't a question too.
      const replied = turn.label === "Author replied" || (turn.at != null && turn.at !== s.questionAt && turn.at === s.replyAt);
      const author = review.author ?? s.author;
      return replied ? why(author ? `@${author} replied` : "Author replied", "foreground", "MessageSquare")
        : why(by("Question from", s.questionBy, "Question for you"), "warning", "MessageQuestion");
    }
    case "mentioned": return why(by("Mentioned by", s.mentionBy, "Mentioned you"), "foreground", "MessageSquare");
    case "handled": return why("Feedback handled", "success", "CircleCheck");
    case "looks-ready": return why("Agent: all feedback addressed", "agent", "Sparkles");
    case "dismissed": return why("Your review was dismissed", "warning", "AlertCircle");
    case "own": return why("Your PR", "neutral", "UserRound");
    case "new": return review.kind === "ref" ? why("Local review", "neutral", "GitBranch")
      : review.status === "tracked" ? why("No guide yet", "neutral") : why("Guide ready", "neutral");
    case "waiting": return review.submittedVerdict === "COMMENT" ? why(`You commented${ago(turn.at)}`, "neutral", "MessageSquare")
      : why(`You requested changes${ago(turn.at)}`, "neutral", "FileDiff");
    case "snoozed": return why(review.snoozedUntil && turn.label === "Snoozed" ? snoozeLabel(review.snoozedUntil, now) : "Snoozed until the author responds", "neutral", "Clock");
    case "draft": return why("Draft PR", "neutral", "GitPullRequestDraft");
    case "approved": return why(`You approved${ago(baselineOf(review).at)}`, "neutral", "Check");
    case "commented": return why(`You commented${ago(baselineOf(review).at)}`, "neutral", "MessageSquare");
    case "merged": return why("Merged", "merged", "GitMerge");
    case "closed": return why("Closed", "danger", "GitPullRequestClosed");
    case "archived": return why("Archived by you", "neutral", "Archive");
    case "unrequested": return why("No longer requested", "neutral");
    case "unreachable": return why("Can’t read on GitHub", "neutral", "EyeOff");
    default: return null;
  }
}

/** When anything last happened on the review: you reviewed it, the author pushed or replied, its turn changed, it was archived. */
export function lastActivity(review: ReviewItem): number | null {
  const s = review.signals ?? {};
  const at = Math.max(reviewState(review).at ?? 0, s.lastReviewAt ?? 0, s.headSeenAt ?? 0, s.replyAt ?? 0, review.submittedAt ?? 0, review.userArchivedAt ?? 0, review.archivedAt ?? 0);
  return at || review.createdAt || null;
}

const CHECKS: Record<"pass" | "fail" | "pending" | "expected", Pick<StatusPart, "text" | "tone" | "icon">> = {
  fail: { text: "Checks failing", tone: "danger", icon: "X" },
  pending: { text: "Checks pending", tone: "warning", icon: "CircleDashed" },
  expected: { text: "Checks expected", tone: "warning", icon: "CircleDashed" },
  pass: { text: "Checks passing", tone: "success", icon: "Check" },
};

/**
 * The status line, in order: Blocks merge, why, then a run that didn't start on its own, GitHub not reading the PR,
 * your feedback's progress, new commits, checks, size, and its place in a stack. Passing checks say nothing unless
 * `passingChecks`. `ci` is the checks as just read, where a page has them, in place of the last sync's.
 */
export function statusLine(review: ReviewItem, { now = Date.now(), passingChecks = false, ci = review.signals?.ci }: { now?: number; passingChecks?: boolean; ci?: TurnSignals["ci"] } = {}): StatusPart[] {
  const turn = reviewState(review);
  const s = review.signals ?? {};
  const parts: StatusPart[] = [];
  const done = turn.group === "archive";
  if (turn.blocking) parts.push({ kind: "blocking", text: "Blocks merge", tone: "warning", icon: "Lock", detail: "Everyone else approved: only your changes requested is left" });
  const reason = statusWhy(review, now);
  if (reason) parts.push(reason);
  if (review.skippedRun && !review.archivedAt) parts.push({ kind: "not-run", text: notRunReason(review), tone: "warning", icon: "Lock" });
  if (review.unreachable && turn.reason !== "unreachable") {
    parts.push({ kind: "unreachable", text: "Can’t read on GitHub", tone: "warning", icon: "AlertCircle", detail: review.unreachable.reason === "forbidden" ? "GitHub refused access, for example for SSO" : "Deleted, or you lost access" });
  }
  if (review.progress) parts.push({ kind: "progress", text: progressText(review.progress), tone: "neutral", ...(review.progress.source === "threads" ? { detail: "Resolved or answered" } : {}) });
  const commits = s.commitsSince ?? 0;
  if (commits > 0) parts.push({ kind: "commits", text: `+${commits} ${commits === 1 ? "commit" : "commits"}`, tone: "neutral", detail: "Since your review" });
  if (!done && ci && ci !== "none" && (ci !== "pass" || passingChecks)) parts.push({ kind: "checks", ...CHECKS[ci] });
  if (review.prSize) {
    const { additions, deletions, files } = review.prSize;
    parts.push({ kind: "size", text: `+${additions.toLocaleString()} −${deletions.toLocaleString()} · ${files} ${files === 1 ? "file" : "files"}`, tone: "neutral" });
  }
  const stack = review.stack;
  if (stack) {
    parts.push({ kind: "stack", text: `Stack ${stack.index + 1} of ${stack.members.length}${stack.parent ? ` · on #${stack.parent.number}` : ""}`, tone: "neutral" });
    if (stack.parent && !stack.parent.reviewed && !done) parts.push({ kind: "stack-unreviewed", text: `#${stack.parent.number} not reviewed yet`, tone: "warning" });
  }
  return parts;
}
