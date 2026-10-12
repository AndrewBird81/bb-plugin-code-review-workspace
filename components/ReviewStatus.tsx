import { Fragment, type ReactNode } from "react";
import { reviewState, type ReviewItem } from "../lib/review-state";
import type { StatusPart, StatusTone } from "../lib/status-line";
import { snoozeLabel } from "../lib/turn";
import { cn } from "../lib/utils";
import { Badge, TONE_TEXT, type Tone } from "./ui/badge";
import { Icon, type IconName } from "./ui/icon";

/** How a review's status reads: GitHub's verdict colors, the agent's for its work, chosen by whose turn it is and why. */
export function statusLook(review: ReviewItem): { label: string; tone: Tone; icon?: IconName; busy?: boolean } {
  const { label, reason, failed, group } = reviewState(review);
  if (label === "Generating") return { label, tone: "agent", icon: "Loading", busy: true };
  // A failed guide keeps the reason underneath; the failure is what to show.
  if (failed || label === "Failed") return { label, tone: "danger", icon: "AlertTriangle" };
  switch (reason) {
    case "merged": return { label, tone: "merged", icon: "GitMerge" };
    case "closed": return { label, tone: "danger", icon: "GitPullRequestClosed" };
    case "archived": return { label, tone: "neutral", icon: "Archive" };
    case "unrequested": return { label, tone: "neutral" };
    case "unreachable": return { label, tone: "neutral", icon: "EyeOff" };
    // Your own PR stands out only while it's yours to review.
    case "own": return { label, tone: group === "needs" ? "primary" : "neutral", icon: "UserRound" };
    case "re-requested": return { label, tone: "primary", icon: "Repeat" };
    case "team-requested": return { label, tone: "neutral" };
    case "question": return { label, tone: "warning", icon: "MessageQuestion" };
    case "mentioned": return { label, tone: "primary", icon: "MessageSquare" };
    case "handled": return { label, tone: "success", icon: "CircleCheck" };
    case "looks-ready": return { label, tone: "agent", icon: "Sparkles" };
    case "dismissed": return { label, tone: "warning", icon: "AlertCircle" };
    case "waiting": return label === "Changes requested" ? { label, tone: "warning", icon: "FileDiff" } : { label, tone: "neutral", icon: "MessageSquare" };
    // The wake time reads in your time zone, not the server's.
    // Until the author responds, the turn still says "Not yet", the old name of that Snooze.
    case "snoozed": return { label: label === "Snoozed" && review.snoozedUntil ? snoozeLabel(review.snoozedUntil) : "Snoozed", tone: "neutral", icon: "Clock" };
    case "draft": return { label, tone: "neutral", icon: "GitPullRequestDraft" };
    case "approved": return { label, tone: "success", icon: "Check" };
    case "commented": return { label, tone: "neutral", icon: "MessageSquare" };
    default: return { label, tone: "primary" };
  }
}

/** The pull request (or local change) itself, colored like GitHub: open, merged, closed. */
export function kindLook(review: ReviewItem): { tone: Tone; icon: IconName } {
  if (review.prState === "MERGED") return { tone: "merged", icon: "GitMerge" };
  if (review.prState === "CLOSED" || review.archivedAt) return { tone: "danger", icon: "GitPullRequestClosed" };
  if (review.kind === "ref" || (review.kind !== "pr" && review.number == null)) return { tone: "primary", icon: "GitBranch" };
  if (review.userArchivedAt) return { tone: "neutral", icon: "GitPullRequest" };
  return { tone: "success", icon: "GitPullRequest" };
}

export function StatusBadge({ review, className }: { review: ReviewItem; className?: string }) {
  const look = statusLook(review);
  return (
    <Badge tone={look.tone} className={className} dot={!look.icon} icon={look.icon && <Icon name={look.icon} className={cn(look.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />}>
      {look.label}
    </Badge>
  );
}

/** A status part's tone as its text color: the kit's tones, and foreground. */
export const STATUS_TEXT: Record<StatusTone, string> = { ...TONE_TEXT, foreground: "text-foreground" };

/**
 * A status line (lib/status-line.ts) on one line, its parts between dots, each an icon and words in its tone, then
 * `after` (such as where the PR is, with its class) when there's room. It truncates at the end; a part's `detail` is its
 * tooltip.
 */
export function StatusLine({ parts, after, className }: { parts: StatusPart[]; after?: { content: ReactNode; className?: string }; className?: string }) {
  const dot = <><span aria-hidden className="text-subtle-foreground"> · </span><span className="sr-only">, </span></>;
  return (
    // Relative, so the screen reader's commas, placed absolutely, are clipped with the rest.
    <span className={cn("relative block min-w-0 truncate", className)}>
      {parts.map((part, index) => <Fragment key={`${part.kind}-${index}`}>
        {index > 0 && dot}
        <span title={part.detail} className={STATUS_TEXT[part.tone]}>
          {part.icon && <Icon name={part.icon} className={cn("mr-1 inline size-3 align-[-2px]", part.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />}
          {part.text}
        </span>
      </Fragment>)}
      {after && <span className={after.className}>{parts.length > 0 && dot}{after.content}</span>}
    </span>
  );
}
