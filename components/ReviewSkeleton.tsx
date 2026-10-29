import { memo, useId } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { GUIDE_STOPPED, type ReviewItem } from "../lib/review-state";
import { Skeleton } from "./ui/skeleton";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { IconTile } from "./ui/icon-tile";
import { PageBar, reviewSettingsItem } from "./PageBar";
import { ReviewTitle } from "./ReviewIdChip";
import { ReviewActions } from "./ReviewActions";
import { useThreadListReviews } from "./NeedsReviewSidebar";
import { TOUCH_CONTROL } from "./touch";

/** The workspace's shape, drawn in placeholders: chapters beside the code where there's room, then the files. */
function WorkspaceShape() {
  return (
    <div aria-hidden className="flex min-h-0 flex-1">
      <div className="hidden w-72 shrink-0 space-y-3 border-r border-border p-3 @min-[768px]/skeleton:block">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-1 w-full rounded-full" />
        <div className="space-y-3 pt-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <Skeleton className="size-[22px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5" style={{ width: `${80 - i * 7}%` }} />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center gap-2 border-b border-border px-3">
          <Skeleton className="h-4 w-48 max-w-[50%]" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
        <div className="flex-1 space-y-4 overflow-hidden p-4">
          {Array.from({ length: 3 }).map((_, f) => (
            <div key={f} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                <Icon name="File" className="size-3.5 text-muted-foreground" />
                <Skeleton className="h-3 w-48 max-w-[50%]" />
                <Skeleton className="ml-auto h-3 w-10" />
              </div>
              <div className="space-y-2 p-3">
                {Array.from({ length: 4 + f }).map((_, l) => (
                  <Skeleton key={l} className="h-3" style={{ width: `${88 - ((l * 13) % 45)}%` }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The review page before its guide shows. Opening, the workspace's shape in placeholders. While its guide is built
 * (`review`), the page bar with the review's menu, the agent at work, Stop when `onStop` is given, and the shape dimmed
 * under it.
 */
export const ReviewSkeleton = memo(function ReviewSkeleton({ review, onBack, onStop, stopping = false }: { review?: ReviewItem; onBack?: () => void; onStop?: () => void; stopping?: boolean }) {
  if (!review || !onBack) {
    // The shape is hidden from screen readers, so the status says it in words.
    return <div role="status" aria-label="Opening the review" className="@container/skeleton flex h-full min-w-0 flex-col bg-background"><span className="sr-only">Opening the review…</span><WorkspaceShape /></div>;
  }
  return <BuildingGuide review={review} onBack={onBack} onStop={onStop} stopping={stopping} />;
});
ReviewSkeleton.displayName = "ReviewSkeleton";

function BuildingGuide({ review, onBack, onStop, stopping }: { review: ReviewItem; onBack: () => void; onStop?: () => void; stopping: boolean }) {
  const navigate = useBbNavigate();
  const pinnable = useThreadListReviews() === true;
  return (
    <div className="@container/skeleton flex h-full min-h-0 min-w-0 flex-col bg-background">
      <PageBar onBack={onBack} title={<ReviewTitle review={review} />}>
        <ReviewActions review={review} pinnable={pinnable} trailing={[reviewSettingsItem(navigate, review.targetKey)]} onDeleted={onBack} className={TOUCH_CONTROL} />
      </PageBar>
      <div className="px-4 pt-6 @min-[640px]/skeleton:px-6">
        <section role="status" aria-label="Building the guide" className="mx-auto w-full max-w-xl rounded-xl border border-border bg-card p-5 shadow-xs">
          <div className="flex items-center gap-3">
            <IconTile tone="agent" icon="Sparkles" className="size-10 rounded-xl" iconClassName="size-5" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground">Building the guide</h2>
              <p className="text-sm text-muted-foreground">The guide writer is reading the PR and writing its chapters.</p>
            </div>
            <Icon name="Loading" className="size-4 shrink-0 animate-spin text-(--ansi-13) motion-reduce:animate-none" aria-hidden />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">It takes a few minutes. You can leave: All reviews shows when it’s ready.</p>
          {(review.url || onStop) && <div className="mt-4 flex flex-wrap gap-2">
            {review.url && <Button asChild variant="outline" size="sm" className={TOUCH_CONTROL}><UrlLink href={review.url}><Icon name="Github" aria-hidden />Open on GitHub</UrlLink></Button>}
            {onStop && <Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : "Stop"}</Button>}
          </div>}
        </section>
      </div>
      {/* What's coming, dimmed; a phone keeps its height for the card. */}
      <div className="mt-6 hidden min-h-0 flex-1 flex-col border-t border-border opacity-40 @min-[640px]/skeleton:flex"><WorkspaceShape /></div>
    </div>
  );
}

/**
 * A review page that failed: the page bar (with the review's menu, when there's a review), what failed, why a guide
 * failed when it's known, and the way on: Try again, or Back to your reviews when `primary` is "back", and the PR on GitHub.
 * A guide you stopped says "Guide stopped", with Build the guide; one waiting for its writer's machine says so.
 */
export const ReviewError = memo(function ReviewError({ review, title = "Couldn’t build the guide", message = "The guide writer stopped before it finished. Check your coding agent in BB’s Settings, then try again.", onRetry, onBack, busy = false, primary = "retry" }: {
  review?: ReviewItem;
  title?: string;
  message?: string;
  onRetry?: () => void;
  onBack: () => void;
  busy?: boolean;
  primary?: "retry" | "back";
}) {
  const navigate = useBbNavigate();
  const pinnable = useThreadListReviews() === true;
  // You stopped its guide: nothing went wrong, and building it is the way on.
  const stopped = review?.status === "error" && review.guideError?.text === GUIDE_STOPPED;
  // A reload interrupted it while its writer's machine was offline: it restarts on its own once that reconnects.
  const waiting = review?.status === "error" && !stopped && !!review.restartPending;
  // The writer's own words or the guide's last rejection: plain text, cut to a few lines.
  const reason = review?.status === "error" && !stopped && !waiting ? review.guideError?.text : undefined;
  const reasonId = useId();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageBar onBack={onBack} title={review && <ReviewTitle review={review} />}>
        {review && <ReviewActions review={review} pinnable={pinnable} trailing={[reviewSettingsItem(navigate, review.targetKey)]} onDeleted={onBack} className={TOUCH_CONTROL} />}
      </PageBar>
      {/* A guide you stopped, or one waiting for its writer's machine, didn't fail: it says so plainly, not as an alert. */}
      <div role={stopped || waiting ? "status" : "alert"} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center">
        <IconTile tone={stopped ? "neutral" : waiting ? "warning" : "danger"} icon={stopped ? "Route" : waiting ? "Clock" : "AlertTriangle"} className="size-10 rounded-xl" iconClassName="size-5" />
        <div className="max-w-lg space-y-2">
          <h2 className="text-base font-semibold text-foreground">{stopped ? "Guide stopped" : waiting ? "Waiting for the guide writer’s machine" : title}</h2>
          <p className="break-words text-sm leading-relaxed text-muted-foreground">{stopped ? "You stopped the guide writer before it finished. Build the guide when you’re ready."
            : waiting ? "The guide writer’s machine is offline. The guide restarts on its own when it reconnects." : message}</p>
        </div>
        {reason && (
          <section aria-labelledby={reasonId} className="w-full max-w-lg rounded-md border border-border p-3 text-left">
            <h3 id={reasonId} className="text-xs font-medium text-foreground">What went wrong</h3>
            <p className="mt-1 line-clamp-6 whitespace-pre-line break-words text-xs leading-5 text-muted-foreground">{reason}</p>
          </section>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {primary === "back" && <Button className={TOUCH_CONTROL} onClick={onBack}>Back to your reviews</Button>}
          {onRetry && <Button disabled={busy} variant={primary === "back" ? "outline" : "default"} className={TOUCH_CONTROL} onClick={onRetry}>{stopped ? busy ? "Building…" : "Build the guide" : busy ? "Trying again…" : "Try again"}</Button>}
          {review?.url && <Button asChild variant="outline" className={TOUCH_CONTROL}><UrlLink href={review.url}><Icon name="Github" aria-hidden />Open on GitHub</UrlLink></Button>}
        </div>
      </div>
    </div>
  );
});
ReviewError.displayName = "ReviewError";
