import { Fragment, type ReactNode } from "react";
import type { ReviewItem } from "../lib/review-state";
import type { StatusPart, StatusTone } from "../lib/status-line";
import { cn } from "../lib/utils";
import { TONE_TEXT, type Tone } from "./ui/badge";
import { Icon, type IconName } from "./ui/icon";

/** The pull request (or local change) itself, colored like GitHub: open, merged, closed. */
export function kindLook(review: ReviewItem): { tone: Tone; icon: IconName } {
  if (review.prState === "MERGED") return { tone: "merged", icon: "GitMerge" };
  if (review.prState === "CLOSED" || review.archivedAt) return { tone: "danger", icon: "GitPullRequestClosed" };
  if (review.kind === "ref" || (review.kind !== "pr" && review.number == null)) return { tone: "primary", icon: "GitBranch" };
  if (review.userArchivedAt) return { tone: "neutral", icon: "GitPullRequest" };
  return { tone: "success", icon: "GitPullRequest" };
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
          {part.diff ? <><span className="text-diff-added">+{part.diff.additions.toLocaleString()}</span> <span className="text-diff-removed">−{part.diff.deletions.toLocaleString()}</span>
            {` · ${part.diff.files} ${part.diff.files === 1 ? "file" : "files"}`}</> : part.text}
        </span>
      </Fragment>)}
      {after && <span className={after.className}>{parts.length > 0 && dot}{after.content}</span>}
    </span>
  );
}
