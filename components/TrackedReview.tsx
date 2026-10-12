import { memo, useState } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewItem } from "../lib/review-state";
import { statusLine } from "../lib/status-line";
import { notRunReason } from "../lib/trust";
import { Button } from "./ui/button";
import { Avatar } from "./ui/avatar";
import { Icon } from "./ui/icon";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { PageBar, reviewSettingsItem } from "./PageBar";
import { ReviewActions } from "./ReviewActions";
import { StackLinks, UnreviewedParent } from "./ReviewHeader";
import { kindLook, StatusLine } from "./ReviewStatus";
import { useThreadListReviews } from "./NeedsReviewSidebar";
import { TOUCH_CONTROL } from "./touch";

/** A PR found on GitHub with no guide yet: the page bar with its menu, where the PR stands, and Build the guide. */
export const TrackedReview = memo(function TrackedReview({ review, onBack }: { review: ReviewItem; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pinnable = useThreadListReviews() === true;
  const [starting, setStarting] = useState(false);
  const kind = kindLook(review);
  // Its size, its stack and a run that didn't start have their own lines here.
  const parts = statusLine(review).filter((part) => part.kind !== "size" && part.kind !== "stack" && part.kind !== "stack-unreviewed" && part.kind !== "not-run");
  const size = review.prSize;

  async function build() {
    setStarting(true);
    try {
      const result = await rpc.call("startTrackedReview", { targetKey: review.targetKey });
      // On success the review's realtime update shows the guide being built.
      if (!result.ok) toast.error(result.error ?? "Couldn’t build the guide.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t build the guide.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageBar onBack={onBack} title={<InlineCode text={review.title ?? review.targetKey} />}>
        <ReviewActions review={review} pinnable={pinnable} trailing={[reviewSettingsItem(navigate, review.targetKey)]} onDeleted={onBack} className={TOUCH_CONTROL} />
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Tracked pull request" className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-5 py-8 text-center">
          <IconTile tone={kind.tone} icon={kind.icon} className="size-10 rounded-xl" iconClassName="size-5" />
          <div className="w-full space-y-1.5">
            <p className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              {review.repo && <span className="font-mono text-[11px]">{review.repo}{review.number ? <span className="text-subtle-foreground"> #{review.number}</span> : null}</span>}
              {review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={16} /><span className="text-foreground/90">@{review.author}</span></span>}
              {size && <span className="tabular-nums">+{size.additions.toLocaleString()} −{size.deletions.toLocaleString()} · {size.files} {size.files === 1 ? "file" : "files"}</span>}
            </p>
            {parts.length > 0 && <StatusLine parts={parts} className="text-xs text-muted-foreground" />}
            {review.stack && <p className="flex flex-wrap items-center justify-center text-xs text-muted-foreground"><StackLinks stack={review.stack} /></p>}
            <UnreviewedParent stack={review.stack} className="justify-center" />
          </div>
          {review.skippedRun && <p className="flex items-center gap-1.5 text-sm text-warning-text"><Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />{notRunReason(review)}.</p>}
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">No guide yet</h2>
            <p className="text-sm text-muted-foreground">Building one takes a few minutes. Nothing reaches GitHub until you submit.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button disabled={starting} className={TOUCH_CONTROL} onClick={() => void build()}>
              <Icon name={starting ? "Loading" : "Sparkles"} className={starting ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden />
              {starting ? "Starting…" : "Build the guide"}
            </Button>
            {review.url && <Button asChild variant="outline" className={TOUCH_CONTROL}><UrlLink href={review.url}><Icon name="Github" aria-hidden />Open on GitHub</UrlLink></Button>}
          </div>
        </section>
      </div>
    </div>
  );
});
TrackedReview.displayName = "TrackedReview";
