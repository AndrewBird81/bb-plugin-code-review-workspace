import type { CommentLocation } from "../src/draft";
import { useSentTo } from "../lib/review-links";
import { cn } from "../lib/utils";
import { age } from "./time-ago";
import { Icon } from "./ui/icon";

/** "Sent to ‹thread› · 2m" under a draft comment's state, once Send to thread sent it. It's still only in BB. */
export function SentLine({ at, className }: { at: CommentLocation; className?: string }) {
  const sent = useSentTo(at);
  if (!sent) return null;
  const when = age(sent.at);
  return <p className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
    <Icon name="Send" className="size-3.5 shrink-0" aria-hidden />
    <span className="min-w-0 truncate">Sent to <span className="text-foreground">{sent.title ?? "the thread that made the change"}</span></span>
    {when && <span className="shrink-0">· {when}</span>}
  </p>;
}
