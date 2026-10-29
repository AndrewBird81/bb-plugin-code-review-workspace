import { reviewIdentity, type Identifiable, type ReviewIdentity } from "../lib/review-identity";
import { cn } from "../lib/utils";
import { InlineCode } from "./ui/inline-code";

/** The id's chip: monospace, muted (4.5:1 or more in both themes). */
export const ID_CHIP = "inline-flex min-w-0 max-w-full rounded-md bg-muted px-1.5 font-mono text-[11px] leading-5 text-muted-foreground";

/**
 * A review's id, api#4512, as a chip, its whole id and name on hover. Short of room, the repository's name is cut, past
 * 160px: `#4512` always shows, and `:feat/x` unless its own length passes the room. Screen readers hear the whole id.
 */
export function ReviewIdChip({ identity, className }: { identity: ReviewIdentity; className?: string }) {
  return (
    <span data-review-id title={`${identity.repo && identity.repo !== identity.idRepo ? `${identity.repo}${identity.idTail}` : identity.id} · ${identity.name}`} className={cn(ID_CHIP, className)}>
      {/* Read as one word, however its two parts are laid out. */}
      <span className="sr-only">{identity.id}</span>
      {/* The repository's name gives way first; a PR's #4512 never does, nor a local review's :branch until the name
          has gone, as a phone's dock needs for a long branch. */}
      {identity.idRepo && <span aria-hidden className="min-w-0 max-w-40 shrink-[100] truncate">{identity.idRepo}</span>}
      {identity.idTail && <span aria-hidden className={cn("whitespace-nowrap", identity.idTail.startsWith("#") ? "shrink-0" : "min-w-0 truncate")}>{identity.idTail}</span>}
    </span>
  );
}

/** A page bar's title (PageBar): the review's id, then its name, as its window's title has them, the name wrapping beside the id. */
export function ReviewTitle({ review }: { review: Identifiable }) {
  const identity = reviewIdentity(review);
  // The chip on the name's first line: its box, which cuts its words, has no baseline of its own to align by.
  return <><ReviewIdChip identity={identity} className="-mt-px shrink-0 self-start" /> <span className="line-clamp-2 min-w-0 break-words"><InlineCode text={identity.name} /></span></>;
}
