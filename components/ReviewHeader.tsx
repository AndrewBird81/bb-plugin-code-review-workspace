import { memo, useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { CheckItem } from "../src/threads";
import type { StackMember, StackPlace } from "../lib/stacks";
import { LINES_PER_HOUR, readingTime } from "../lib/review-size";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { statusLine, type StatusKind, type StatusTone } from "../lib/status-line";
import { useKnob } from "../lib/settings";
import { canSnooze, canSnoozeUntil, type ReviewRound } from "../lib/turn";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { TONE_TEXT } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { InlineCode } from "./ui/inline-code";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { kindLook, STATUS_TEXT } from "./ReviewStatus";
import { MetaLine } from "./MetaLine";
import { SnoozeChoices } from "./SnoozeChoices";
import { TOUCH_CONTROL } from "./touch";
import { timeAgo } from "./time-ago";

/** A text button in a line of text is 44px tall on a coarse pointer, its words centred in it. */
const TOUCH_TEXT = "pointer-coarse:min-h-11";

/** A branch name, GitHub-style. */
export function BranchChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("max-w-56 truncate rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-primary", className)}>{children}</span>;
}

/** Review title that opens its GitHub PR when one is known. Its ↗ stays on the line with its last word. */
export function ReviewTitleLink({ url, text }: { url?: string; text: string }) {
  if (!url) return <InlineCode text={text} />;
  const icon = <Icon name="ArrowUpRight" className="ml-1 inline size-[1em] align-[-0.125em] text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />;
  // Not inside `code`: an odd count of the parts before the last space means its backticks pair up.
  const at = text.lastIndexOf(" ");
  const split = at > 0 && text.slice(0, at).split("`").length % 2 === 1;
  return (
    // Inline, so its padding makes a 44px target on a coarse pointer without moving the lines.
    <UrlLink href={url} title="Open on GitHub" className="group rounded-sm decoration-primary/50 underline-offset-4 hover:underline pointer-coarse:py-2.5">
      {split ? <><InlineCode text={text.slice(0, at + 1)} /><span className="whitespace-nowrap"><InlineCode text={text.slice(at + 1)} />{icon}</span></> : <><InlineCode text={text} />{icon}</>}
    </UrlLink>
  );
}

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
    <button key={label} type="button" disabled={busy} title={member.title ?? undefined} onClick={() => void open(member)} className={cn("rounded-sm text-foreground/90 underline decoration-border underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_TEXT)}>{label}</button>
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

/** The PR's CI checks, as getChecks reads them. */
export type Checks = { bucket: string; checks: CheckItem[] };

/** One fact of the status line: its icon in its tone, then its words. */
function Fact({ icon, tone, title, children }: { icon?: ReactNode; tone: StatusTone; title?: string; children: ReactNode }) {
  return <span title={title} className="inline-flex items-center gap-1.5">{icon && <span className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5", STATUS_TEXT[tone])}>{icon}</span>}{children}</span>;
}

/** The status line's facts the hero shows (lib/status-line.ts): the size, the stack and a run that didn't start have their own places on the page. */
const HERO_FACTS: ReadonlySet<StatusKind> = new Set(["blocking", "why", "unreachable", "progress", "checks"]);

/** Snooze while it's your turn: until the author responds, or until a time. A snoozed review offers to come back. */
function Snooze({ review, snoozing, onSnooze }: { review: ReviewItem; snoozing: boolean; onSnooze: (snoozed: boolean, until?: number) => void }) {
  const [open, setOpen] = useState(false);
  const turn = reviewState(review);
  const button = cn("text-muted-foreground", TOUCH_CONTROL);
  if (turn.reason === "snoozed") return <Button variant="ghost" size="sm" className={button} disabled={snoozing} onClick={() => onSnooze(false)}><Icon name="ArrowTurnBackward" aria-hidden />Back to Needs review</Button>;
  const responds = canSnooze(review, turn);
  const timed = canSnoozeUntil(review, turn);
  if (!responds && !timed) return null;
  const pick = (until?: number) => { setOpen(false); onSnooze(true, until); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={button} disabled={snoozing}><Icon name="Clock" aria-hidden />Snooze<Icon name="ChevronDown" className="text-subtle-foreground" aria-hidden /></Button>
      </PopoverTrigger>
      <PopoverContent align="start" mobileTitle="Snooze" className="w-64 max-w-[calc(100vw-24px)] p-1">
        <SnoozeChoices disabled={snoozing} onUntilAuthor={responds ? () => pick() : undefined} onPick={timed ? pick : undefined} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The top of a review's Overview: its title, who and what it is, a status line (whose turn, your feedback, checks), your
 * reviews and its stack, then `action`, the way into its chapters, with Snooze beside it while it's your turn.
 */
export const ReviewHeader = memo(function ReviewHeader({ review, checks, readLines, onShowFeedback, onSnooze, snoozing = false, action }: {
  review: ReviewItem;
  checks?: Checks | null;
  /** The changed lines worth reading (lib/review-size.ts readingLines). */
  readLines?: number;
  /** Your feedback's progress opens it in Comments. */
  onShowFeedback?: () => void;
  /** Snooze until the author responds (true), until a time (true, until), or back to Needs review (false). */
  onSnooze?: (snoozed: boolean, until?: number) => void;
  snoozing?: boolean;
  action?: ReactNode;
}) {
  const kind = kindLook(review);
  const turn = reviewState(review);
  const rounds: ReviewRound[] = review.signals?.rounds ?? [];
  const progress = review.progress ?? null;
  const stack = review.stack ?? null;
  // The checks as just read, once they are; until then, as the last sync saw them.
  const ci = checks ? (checks.bucket === "fail" || checks.bucket === "pending" || checks.bucket === "pass" ? checks.bucket : "none") : undefined;
  const unattendedAgents = useKnob("unattendedAgents");
  const facts = statusLine(review, { passingChecks: true, ci, knobs: { unattendedAgents } })
    // A review that's simply ready has nothing to say about whose turn it is.
    .filter((part) => HERO_FACTS.has(part.kind) && !(part.kind === "why" && turn.label === "Ready"))
    .map((part) => part.kind === "progress" && progress ? (
      <button key={part.kind} type="button" onClick={onShowFeedback} title={part.detail ? `${part.detail}. Show your feedback in Comments` : "Show your feedback in Comments"} className={cn("rounded-sm underline decoration-border underline-offset-4 hover:decoration-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_TEXT)}>
        <Fact icon={<Icon name={progress.source === "assistant" ? "Sparkles" : "MessageSquare"} aria-hidden />} tone={progress.done === progress.total ? "success" : "primary"}>{part.text}</Fact>
      </button>
    ) : (
      // Hovering the checks lists them.
      <Fact key={part.kind} icon={part.icon && <Icon name={part.icon} className={cn(part.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />} tone={part.tone} title={part.kind === "checks" && checks ? checks.checks.map((check) => `${check.name}: ${check.bucket}`).join("\n") : part.detail}>{part.text}</Fact>
    ));
  const snooze = onSnooze && <Snooze review={review} snoozing={snoozing} onSnooze={onSnooze} />;
  return (
    <header className="space-y-2.5">
      <h2 className="text-base font-semibold leading-snug text-foreground @min-[640px]/overview:text-xl">
        <ReviewTitleLink url={review.url} text={review.title ?? review.gitRef ?? review.targetKey} />
      </h2>
      <MetaLine className="leading-6" items={[
        review.author && <span className="inline-flex items-center gap-1.5 align-top"><Avatar login={review.author} size={16} /><span className="text-foreground/90">@{review.author}</span></span>,
        review.repo && <span className="inline-flex items-center gap-1 align-top"><Icon name={kind.icon} className={cn("size-3.5 shrink-0", TONE_TEXT[kind.tone])} aria-hidden /><span className="font-mono text-[11px]">{review.repo}</span>{review.number ? <span className="text-subtle-foreground">#{review.number}</span> : null}</span>,
        review.base && review.head
          // base ← head, which a screen reader hears in words, the way the PR merges: "fix-race into main".
          ? <span className="inline-flex min-w-0 max-w-full items-center gap-1 align-top"><span className="sr-only">{review.head} into {review.base}</span><span aria-hidden className="contents"><BranchChip>{review.base}</BranchChip><Icon name="ArrowRight" className="size-3 shrink-0 rotate-180 text-subtle-foreground" /><BranchChip>{review.head}</BranchChip></span></span>
          : review.gitRef && <BranchChip className="align-top">{review.gitRef}</BranchChip>,
        !!readLines && <span className="tabular-nums" title={`Without lockfiles and generated files. Reading time at about ${LINES_PER_HOUR} changed lines an hour.`}>{readLines.toLocaleString()} changed {readLines === 1 ? "line" : "lines"} · {readingTime(readLines)}</span>,
      ]} />
      {facts.length > 0 && <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-foreground/90">{facts}</p>}
      {(rounds.length > 0 || stack) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {rounds.length > 0 && <RoundTimeline rounds={rounds} />}
          {stack && <StackLinks stack={stack} />}
        </div>
      )}
      <UnreviewedParent stack={stack} />
      {(action || snooze) && <div className="flex flex-wrap items-center gap-2 pt-1.5">{action}{snooze}</div>}
    </header>
  );
});
ReviewHeader.displayName = "ReviewHeader";
