import { memo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { CheckItem } from "../src/threads";
import type { StackMember, StackPlace } from "../lib/stacks";
import { LINES_PER_HOUR, readingTime } from "../lib/review-size";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { defaultName, NAME_LIMIT, renamedFrom } from "../lib/review-name";
import { branchLabel, reviewIdentity } from "../lib/review-identity";
import { statusLine, type StatusKind, type StatusTone } from "../lib/status-line";
import { useKnob } from "../lib/settings";
import { canSnooze, canSnoozeUntil, type ReviewRound } from "../lib/turn";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { TONE_TEXT } from "./ui/badge";
import { Avatar } from "./ui/avatar";
import { InlineCode } from "./ui/inline-code";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { kindLook, STATUS_TEXT } from "./ReviewStatus";
import { SnoozeChoices } from "./SnoozeChoices";
import { useReviewActions } from "./ReviewActions";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
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

/** Once you've renamed the review, the PR's own title, which GitHub and the agents keep, under your name for it. */
export function PrTitle({ review, className }: { review: ReviewItem; className?: string }) {
  const title = review.kind === "pr" ? renamedFrom(review) : null;
  if (!title) return null;
  return <p className={cn("break-words text-xs text-muted-foreground", className)}><span className="text-subtle-foreground">PR title:</span> <InlineCode text={title} /></p>;
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
 * The hero's facts, "a · b · c", wrapping between facts. Each dot sits before its fact, and the left edge cuts off a
 * line's first, so no line starts or ends with one.
 */
function FactLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false && item !== "");
  return (
    <div className="overflow-hidden">
      <div className="-ml-3 flex flex-wrap items-center text-xs leading-6 text-muted-foreground">
        {shown.map((item, index) => <span key={index} className="flex min-w-0 max-w-full items-center whitespace-nowrap">
          {/* The space stays outside the hidden dot, so a screen reader hears each fact apart. */}
          {" "}<span aria-hidden className="w-3 shrink-0 text-center text-subtle-foreground">·</span>{item}
        </span>)}
      </div>
    </div>
  );
}

/**
 * The review's name, which links to its PR, with Rename review beside it (on hover or focus with a mouse, always on
 * touch, its 44px target drawn no bigger): it becomes a box, its name selected, that Enter, ✓ or leaving it saves and Esc
 * or ✕ cancels. Emptied, or given its PR's title or ref, the review goes back to that.
 */
function ReviewName({ review, shown }: { review: ReviewItem; shown: string }) {
  const actions = useReviewActions(review);
  const [draft, setDraft] = useState<string | null>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  // Enter saves, then the box goes: its blur mustn't save again.
  const closing = useRef(false);
  const close = () => {
    setDraft(null);
    requestAnimationFrame(() => pencil.current?.focus());
  };
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (closing.current || draft === null) return;
    closing.current = true;
    const name = draft.trim();
    if (name !== shown) await actions.rename(name === defaultName(review) ? "" : name);
    close();
  };
  const cancel = () => {
    closing.current = true;
    close();
  };
  const heading = "text-base font-semibold leading-snug text-foreground @min-[640px]/overview:text-xl";
  // Pressing ✓ or ✕ keeps the focus in the box, so leaving it doesn't save first.
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();
  if (draft !== null) return (
    // Leaving the box and its ✓ and ✕, by a click or by Tab, ends renaming as Enter does: a changed name saves.
    <form className="flex items-center gap-1" onSubmit={(event) => void save(event)}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) void save(); }}>
      <Input autoFocus aria-label="Review name" value={draft} maxLength={NAME_LIMIT} readOnly={actions.busy}
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // The workspace's own Esc leaves a key another took alone.
          event.preventDefault();
          cancel();
        }}
        className={cn("h-auto min-w-0 flex-1 px-2 py-1", heading)} />
      <Button type="submit" variant="ghost" size="icon" aria-label="Save name" onPointerDown={keepFocus} onMouseDown={keepFocus} className={cn("size-8 shrink-0 text-muted-foreground", TOUCH_CONTROL)}><Icon name="Check" aria-hidden /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Cancel renaming" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={cancel} className={cn("size-8 shrink-0 text-muted-foreground", TOUCH_CONTROL)}><Icon name="X" aria-hidden /></Button>
    </form>
  );
  return (
    // The pencil follows the title's last word, on its line.
    <div className={cn("group/name", heading)}>
      <h2 className="inline">
        <ReviewTitleLink url={review.url} text={shown} />
      </h2>
      <Button ref={pencil} variant="ghost" size="icon" aria-label="Rename review" onClick={() => { closing.current = false; setDraft(shown); }}
        className={cn("relative ml-1 size-7 align-middle text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-hover/name:opacity-100 pointer-fine:focus-visible:opacity-100", TOUCH_TARGET)}>
        <Icon name="Edit" className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/**
 * The top of a review's Overview: its title (your name for it, with the PR's title under it), who and what it is, a
 * status line (whose turn, your feedback, checks), your reviews and its stack, then `action`, the way into its chapters,
 * with Snooze beside it while it's your turn.
 */
export const ReviewHeader = memo(function ReviewHeader({ review, guideTitle, checks, readLines, onShowFeedback, onSnooze, snoozing = false, action }: {
  review: ReviewItem;
  /** Names a local review with no name of yours (lib/review-identity.ts). */
  guideTitle?: string;
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
  const identity = reviewIdentity(review, guideTitle);
  // A PR's branches; a local review's range, its head as the id has it: main ← snooze-checks. A single ref is in the id.
  const range = review.kind === "ref" ? review.gitRef?.split(/\.{2,3}/) : null;
  const [base, head] = range ? range.length === 2 && range[0] && range[1] ? [range[0], branchLabel(range[1])] : [null, null] : [review.base, review.head];
  return (
    <header className="space-y-2.5">
      <div>
        <ReviewName review={review} shown={identity.name} />
        <PrTitle review={review} className="mt-1" />
      </div>
      <FactLine items={[
        review.author && <span className="inline-flex items-center gap-1.5"><Avatar login={review.author} size={16} /><span className="text-foreground/90">{review.ownPr ? "Yours" : `@${review.author}`}</span></span>,
        // A local review is Local, on its machine, in its folder.
        review.kind === "ref" && <span className="text-foreground/90">{identity.whose}</span>,
        identity.where && <span title={review.place?.path ?? review.cwd} className="inline-flex min-w-0 max-w-full items-center gap-1"><Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="truncate">{identity.where}</span></span>,
        // Its id as the window's title has it; a PR's with its repository in full, as one word: flosports/api#4512.
        <span title={identity.repo ?? undefined} className="inline-flex min-w-0 max-w-full items-center gap-1"><Icon name={kind.icon} className={cn("size-3.5 shrink-0", TONE_TEXT[kind.tone])} aria-hidden /><span className="truncate font-mono text-[11px]">{review.kind === "ref" ? identity.id : `${identity.repo ?? ""}${identity.idTail}`}</span></span>,
        base && head
          // base ← head, which a screen reader hears in words, the way the PR merges: "fix-race into main".
          && <span className="inline-flex min-w-0 max-w-full items-center gap-1"><span className="sr-only">{head} into {base}</span><span aria-hidden className="contents"><BranchChip>{base}</BranchChip><Icon name="ArrowRight" className="size-3 shrink-0 rotate-180 text-subtle-foreground" /><BranchChip>{head}</BranchChip></span></span>,
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
