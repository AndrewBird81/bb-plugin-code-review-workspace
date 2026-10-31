/**
 * A heading of the review's tabs in BB's side panel: what it is, then the review's id and name, so it's clear which
 * review it's for, "Review agent · api#4512 · Fix login race"; the name is cut first.
 */
export function TabTitle({ title, reviewId, reviewName }: { title: string; reviewId?: string; reviewName?: string }) {
  const dot = <span aria-hidden className="shrink-0 text-subtle-foreground">·</span>;
  return <h2 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm font-medium">
    <span className="shrink-0">{title}</span>
    {reviewId && <>{dot}<span className="max-w-[60%] shrink-0 truncate font-mono text-[11px] font-normal text-muted-foreground">{reviewId}</span></>}
    {reviewName && reviewName !== reviewId && <>{dot}<span title={reviewName} className="min-w-0 truncate text-xs font-normal text-muted-foreground">{reviewName}</span></>}
  </h2>;
}
