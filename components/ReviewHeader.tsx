import { memo, useState, type ReactNode } from "react";
import { Markdown, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { StackMember, StackPlace } from "../lib/stacks";
import { LINES_PER_HOUR, readingTime } from "../lib/review-size";
import { reviewState } from "../lib/review-state";
import { canSnooze, canSnoozeUntil, computeTurn, progressText, type feedbackProgress, type ReviewRound, type Turn } from "../lib/turn";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { StatusBadge, kindLook } from "./ReviewStatus";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { Button } from "./ui/button";
import { timeAgo } from "./time-ago";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { SnoozeChoices } from "./SnoozeChoices";

type ChecksSummary = { bucket: string; checks: any[] } | null | undefined;

/** CI status as a pill: green passing, red failing, amber pending. Hovering lists the checks. */
function CiBadge({ checks }: { checks: ChecksSummary }) {
  if (!checks || checks.bucket === "none") return null;
  const title = checks.checks.map((c: any) => `${c.name}: ${c.bucket}`).join("\n");
  if (checks.bucket === "fail") {
    const n = checks.checks.filter((c: any) => c.bucket === "fail").length;
    return <Badge tone="danger" title={title} icon={<Icon name="X" aria-hidden />}>{n} failing</Badge>;
  }
  if (checks.bucket === "pending") {
    const n = checks.checks.filter((c: any) => c.bucket === "pending").length;
    return <Badge tone="warning" title={title} dot pulse>{n} pending</Badge>;
  }
  return <Badge tone="success" title={title} icon={<Icon name="Check" aria-hidden />}>Checks passing</Badge>;
}

/** A branch name, GitHub-style. */
export function BranchChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("max-w-56 truncate rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-primary", className)}>{children}</span>;
}

/** Review title that opens its GitHub PR when one is known; place in a flex container. */
export function ReviewTitleLink({ url, children }: { url?: string; children: ReactNode }) {
  if (!url) return <span className="truncate">{children}</span>;
  return (
    <UrlLink href={url} title="Open on GitHub" className="group flex min-w-0 items-center gap-1.5 rounded-sm">
      <span className="truncate decoration-primary/50 underline-offset-4 group-hover:underline">{children}</span>
      <Icon name="ArrowUpRight" className="size-[1em] shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
    </UrlLink>
  );
}

const INTENT_TOGGLE_THRESHOLD = 160;

const ROUND_LABEL: Record<ReviewRound["state"], string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed" };

/** Your latest reviews on the PR, oldest first: "Changes requested 3d ago → Commented 1d ago". */
function RoundTimeline({ rounds }: { rounds: ReviewRound[] }) {
  return (
    <ol aria-label="Your reviews" className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {rounds.slice(-4).map((round, index) => (
        <li key={`${round.at}:${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className="text-subtle-foreground">→</span>}
          <span><span className="text-foreground/90">{ROUND_LABEL[round.state]}</span>{timeAgo(round.at) ? ` ${timeAgo(round.at)}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

/** "Stack · 2 of 3", "Stacked on #2645", and "#2648 builds on this": each opens that review, starting a tracked one's guide, or a review of a PR not in your list. */
export function StackLinks({ stack }: { stack: StackPlace }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  async function open(member: StackMember) {
    setBusy(true);
    try {
      let targetKey = member.targetKey;
      if (targetKey && member.status === "tracked") {
        const result = await rpc.call("startTrackedReview", { targetKey });
        if (!result.ok) { toast.error(result.error ?? "Couldn’t start the review."); return; }
      } else if (!targetKey && member.url) {
        const result = await rpc.call("startReview", { input: member.url });
        if (!result.ok || !result.targetKey) { toast.error(result.error ?? "Couldn’t start the review."); return; }
        targetKey = result.targetKey;
      }
      if (targetKey) navigate.toPluginPanel("review", { subPath: targetKey });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start the review.");
    } finally { setBusy(false); }
  }
  const link = (member: StackMember, label: string) => (
    <button key={label} type="button" disabled={busy} title={member.title ?? undefined} onClick={() => void open(member)} className="rounded-sm text-foreground/90 underline decoration-border underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{label}</button>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1 tabular-nums"><Icon name="Layers" className="size-3" aria-hidden />Stack · {stack.index + 1} of {stack.members.length}</span>
      {stack.parent && link(stack.parent, `Stacked on #${stack.parent.number}`)}
      {stack.children.map((child) => link(child, `#${child.number} builds on this`))}
    </span>
  );
}

/** Says when the PR this one builds on hasn't had your review. */
export function UnreviewedParent({ stack, className }: { stack: StackPlace | null | undefined; className?: string }) {
  if (!stack?.parent || stack.parent.reviewed) return null;
  return <p className={cn("flex items-center gap-1.5 text-xs text-warning-text", className)}><Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />You haven’t reviewed #{stack.parent.number}, which this builds on.</p>;
}

export const ReviewHeader = memo(function ReviewHeader({
  review,
  checks,
  intent,
  sinceReview,
  trailing,
  onShowFeedback,
  onSnooze,
  snoozing = false,
  readLines,
}: {
  review: any;
  checks?: ChecksSummary;
  intent?: string;
  /** The guide's summary of what changed since your last review. */
  sinceReview?: string;
  /** Actions at the end of the title row, such as Re-review. */
  trailing?: ReactNode;
  /** The progress pill opens the Feedback view. */
  onShowFeedback?: () => void;
  /** "Not yet" (true), "Snooze until" (true, until), or "Back to Needs review" (false). */
  onSnooze?: (snoozed: boolean, until?: number) => void;
  snoozing?: boolean;
  /** The changed lines worth reading (lib/review-size.ts readingLines). */
  readLines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  if (!review) return null;
  const showIntentToggle = !!intent && intent.length > INTENT_TOGGLE_THRESHOLD;
  const kind = kindLook(review);
  const state = reviewState(review);
  const turn: Turn = review.turn ?? computeTurn(review);
  const rounds: ReviewRound[] = review.signals?.rounds ?? [];
  const progress: ReturnType<typeof feedbackProgress> = review.progress ?? null;
  const stack: StackPlace | null = review.stack ?? null;

  return (
    <header className="flex items-start gap-3">
      <IconTile tone={kind.tone} icon={kind.icon} className="mt-0.5 hidden size-9 @min-[640px]/review:flex" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="flex min-w-0 flex-1 basis-80 text-base font-semibold leading-snug text-foreground @min-[640px]/review:text-lg">
            <ReviewTitleLink url={review.url}><InlineCode text={review.title ?? review.gitRef ?? review.targetKey} /></ReviewTitleLink>
          </h2>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <CiBadge checks={checks} />
            {state.label !== "Ready" && <StatusBadge review={review} />}
            {turn.blocking && <Badge tone="warning" icon={<Icon name="Lock" aria-hidden />} title="Everyone else approved; only your changes requested is left.">Blocks merge</Badge>}
            {progress && progress.total > 0 && (
              <button type="button" onClick={onShowFeedback} title={progress.source === "assistant" ? "Show your feedback" : "Resolved or answered. Show your feedback"} className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <Badge tone={progress.done === progress.total ? "success" : "primary"} className="cursor-pointer tabular-nums" icon={progress.source === "assistant" ? <Icon name="Sparkles" aria-hidden /> : <Icon name="MessageSquare" aria-hidden />}>
                  {progressText(progress)}
                </Badge>
              </button>
            )}
            {onSnooze && turn.reason === "snoozed" ? (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={snoozing} onClick={() => onSnooze(false)}>Back to Needs review</Button>
            ) : onSnooze && canSnooze(review, turn) && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={snoozing} onClick={() => onSnooze(true)}>
                <Icon name="Clock" className="size-3.5" aria-hidden />Not yet
              </Button>
            )}
            {onSnooze && turn.reason !== "snoozed" && canSnoozeUntil(review, turn) && (
              <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={snoozing}><Icon name="Calendar" className="size-3.5" aria-hidden />Snooze</Button>
                </PopoverTrigger>
                <PopoverContent align="end" mobileTitle="Snooze until" className="w-64 max-w-[calc(100vw-24px)] p-1">
                  <SnoozeChoices disabled={snoozing} onPick={(until) => { setSnoozeOpen(false); onSnooze(true, until); }} />
                </PopoverContent>
              </Popover>
            )}
            {trailing}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={18} /><span className="text-foreground/90">@{review.author}</span></span>}
          {review.repo && <span className="font-mono text-[11px]">{review.repo}{review.number ? <span className="text-subtle-foreground"> #{review.number}</span> : null}</span>}
          {review.base && review.head
            ? <span className="inline-flex min-w-0 items-center gap-1"><BranchChip>{review.base}</BranchChip><Icon name="ArrowRight" className="size-3 shrink-0 rotate-180 text-subtle-foreground" aria-hidden /><BranchChip>{review.head}</BranchChip></span>
            : review.gitRef && <BranchChip>{review.gitRef}</BranchChip>}
          {!!readLines && <span className="tabular-nums" title={`Without lockfiles and generated files. Reading time at about ${LINES_PER_HOUR} changed lines an hour.`}>{readLines.toLocaleString()} changed {readLines === 1 ? "line" : "lines"} · {readingTime(readLines)}</span>}
          {rounds.length > 0 && <RoundTimeline rounds={rounds} />}
          {stack && <StackLinks stack={stack} />}
        </div>
        <UnreviewedParent stack={stack} />
        {intent && (
          <div className="max-w-[80ch] border-l-2 border-primary/40 pl-3">
            <div className={cn("relative text-foreground/90", !expanded && showIntentToggle && "max-h-[3.4rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_2.85rem,transparent)]")}>
              <Markdown content={intent} className="text-sm leading-relaxed" />
            </div>
            {showIntentToggle && (
              <button
                type="button"
                className="mt-0.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? "less" : "more"}
                <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
              </button>
            )}
          </div>
        )}
        {sinceReview && (
          <div className="flex max-w-[80ch] gap-2 border-l-2 border-(--ansi-13)/50 pl-3 text-sm text-foreground/90">
            <span className="shrink-0 font-medium text-(--ansi-13)">Since your review</span>
            <Markdown content={sinceReview} className="min-w-0 text-sm leading-relaxed" />
          </div>
        )}
      </div>
    </header>
  );
});
ReviewHeader.displayName = "ReviewHeader";
