import { useId, useRef, useState } from "react";
import { reviewState, type ReviewItem } from "../../lib/review-state";
import { renamedFrom, reviewName } from "../../lib/review-name";
import { lastActivity, statusLine } from "../../lib/status-line";
import { useKnob } from "../../lib/settings";
import { canSnooze, canSnoozeUntil } from "../../lib/turn";
import { cn } from "../../lib/utils";
import { ReviewActions, useReviewActions } from "../ReviewActions";
import { StatusLine } from "../ReviewStatus";
import { SnoozeChoices } from "../SnoozeChoices";
import { age } from "../time-ago";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** The PR's labels a row shows after its title; the rest are counted. */
const MAX_LABELS = 3;

/**
 * A review in the inbox, on two lines: its title (your name for it, with the PR's title on hover), repository and
 * number, and age (in Needs review, how long it's been your turn; elsewhere, its last activity), then its status line.
 * The whole row opens it. Where there's a fine pointer, hovering shows Snooze, Pin and Archive with Review actions; on
 * touch, Review actions is always there.
 */
export function InboxRow({ review, pinnable, short = false, onOpen, onChanged }: {
  review: ReviewItem;
  pinnable: boolean;
  /** A short page, such as a phone held sideways: rows keep to 44px targets, with less air. */
  short?: boolean;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const turn = reviewState(review);
  const titleId = useId();
  const actions = useReviewActions(review, onChanged);
  const unattendedAgents = useKnob("unattendedAgents");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * Once an action moves the review to another section, the focus that was on the row goes to the next row in its
   * section, or the previous one if it was the last, or else the section's header, rather than to the page. `from` is
   * where the action was pressed: a choice in the row's Snooze or ⋯ menu is portaled out of the row, and keeps the focus
   * while the menu closes, or drops it to the page once the menu is gone.
   */
  function keepFocus(from: Element | null) {
    const row = rowRef.current;
    const active = document.activeElement;
    const dropped = !active || active === document.body;
    if (!row || !(row.contains(active) || (from && (active === from || (dropped && !from.isConnected))))) return;
    const section = row.closest("section");
    const rows = Array.from(section?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const at = rows.findIndex((candidate) => row.contains(candidate));
    (rows[at + 1] ?? rows[at - 1] ?? section?.querySelector<HTMLElement>("h2 button"))?.focus();
  }
  const moving = async (action: Promise<boolean>) => { const from = document.activeElement; if (await action) keepFocus(from); };
  const title = reviewName(review);
  const labels = review.prLabels ?? [];
  const where = review.repo ? `${review.repo}${review.number ? ` #${review.number}` : ""}` : review.gitRef && title !== review.gitRef ? review.gitRef : null;
  const when = age(turn.group === "needs" ? turn.at ?? review.createdAt : lastActivity(review));
  // Only the reviewer's own archive can be undone, and a review already in Archive can't be archived.
  const archivable = review.userArchivedAt ? !(review.prState === "MERGED" || review.prState === "CLOSED" || review.archivedAt) : turn.group !== "archive";
  const untilAuthor = canSnooze(review, turn), untilTime = canSnoozeUntil(review, turn);
  const snoozable = (untilAuthor || untilTime) && turn.reason !== "snoozed";
  // Busy, a quick action stays focusable, unavailable and drawn as disabled, and ignores the click.
  const quick = "size-6 px-0 text-muted-foreground hover:text-foreground aria-disabled:opacity-50";
  return (
    <div ref={rowRef} className="group/row relative flex min-w-0 items-center hover:bg-state-hover has-[[data-row]:focus-visible]:bg-state-hover">
      <button type="button" data-row onClick={onOpen} className={cn("min-w-0 flex-1 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", short ? "py-1.5" : "py-2.5 pointer-coarse:py-3")}>
        <span className="flex min-w-0 items-baseline gap-3">
          <span id={titleId} title={renamedFrom(review) ?? undefined} className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-foreground">
            <InlineCode text={title} />
            {pinnable && review.pinnedAt && <Icon name="Pin" className="ml-1.5 inline size-3.5 align-[-2px] text-muted-foreground" aria-label="Pinned" />}
          </span>
          {where && <span className="hidden shrink-0 font-mono text-[11px] text-subtle-foreground @min-[720px]/inbox:inline">{where}</span>}
          {when && <span className="w-7 shrink-0 text-right text-xs tabular-nums text-subtle-foreground">{when}</span>}
        </span>
        {/* Narrow, where the PR is follows its status, which comes first when there's no room for both. The labels end the
            line, under where the PR is and clear of the age's column. */}
        <span className="mt-0.5 flex min-w-0 items-center gap-3">
          <StatusLine parts={statusLine(review, { knobs: { unattendedAgents } })} after={where ? { content: <span className="font-mono text-[11px] text-subtle-foreground">{where}</span>, className: "@min-[720px]/inbox:hidden" } : undefined}
            className="min-w-0 flex-1 text-xs leading-4 text-muted-foreground" />
          {labels.length > 0 && <span className={cn("hidden max-w-[45%] shrink-0 items-center gap-1 overflow-hidden @min-[560px]/inbox:flex", when && "mr-10")}>
            <span className="sr-only">Labels: </span>
            {labels.slice(0, MAX_LABELS).map((label) => <span key={label.name} title={label.name} className="inline-flex min-w-0 max-w-40 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-4 text-muted-foreground">
              {/^[0-9a-f]{6}$/i.test(label.color) && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `#${label.color}` }} />}
              <span className="truncate">{label.name}</span>
            </span>)}
            {labels.length > MAX_LABELS && <span title={labels.slice(MAX_LABELS).map((label) => label.name).join(", ")} className="shrink-0 text-[11px] text-subtle-foreground">+{labels.length - MAX_LABELS}</span>}
          </span>}
        </span>
      </button>
      {/* A fine pointer's quick actions show over the end of the status line, clear of the line above, while the row is
          hovered or focused, and stay while one's menu is open; a touch screen keeps Review actions, 44px, beside the
          row. The strip hides the status line under it, with the row's tint layered over, as the row has it. */}
      <div className={cn("flex shrink-0 items-center gap-0.5 pr-1.5 pointer-fine:absolute pointer-fine:right-1.5 pointer-fine:rounded-md pointer-fine:bg-card pointer-fine:pr-0 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:has-[[aria-expanded=true]]:opacity-100",
        "pointer-fine:group-hover/row:bg-[linear-gradient(var(--state-hover),var(--state-hover))] pointer-fine:group-has-[[data-row]:focus-visible]/row:bg-[linear-gradient(var(--state-hover),var(--state-hover))]",
        short ? "pointer-fine:bottom-0" : "pointer-fine:bottom-1")}>
        <div className="flex items-center gap-0.5 pointer-coarse:hidden">
          {snoozable && <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
            <Hint label="Snooze">
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Snooze" aria-describedby={titleId} aria-disabled={actions.busy} className={quick} onClick={(event) => { if (actions.busy) event.preventDefault(); }}><Icon name="Clock" aria-hidden /></Button>
              </PopoverTrigger>
            </Hint>
            <PopoverContent align="end" mobileTitle="Snooze" className="w-60 max-w-[calc(100vw-24px)] p-1">
              <SnoozeChoices disabled={actions.busy}
                onUntilAuthor={untilAuthor ? () => { setSnoozeOpen(false); void moving(actions.snooze()); } : undefined}
                onPick={untilTime ? (until) => { setSnoozeOpen(false); void moving(actions.snooze(until)); } : undefined} />
            </PopoverContent>
          </Popover>}
          {pinnable && (review.pinnedAt || turn.group !== "archive") && <Hint label={review.pinnedAt ? "Unpin" : "Pin"}>
            <Button variant="ghost" size="sm" aria-label={review.pinnedAt ? "Unpin" : "Pin"} aria-describedby={titleId} aria-disabled={actions.busy} className={quick} onClick={() => { if (!actions.busy) void actions.setPinned(!review.pinnedAt); }}>
              <Icon name={review.pinnedAt ? "PinOff" : "Pin"} aria-hidden />
            </Button>
          </Hint>}
          {archivable && <Hint label={review.userArchivedAt ? "Unarchive" : "Archive"}>
            <Button variant="ghost" size="sm" aria-label={review.userArchivedAt ? "Unarchive" : "Archive"} aria-describedby={titleId} aria-disabled={actions.busy} className={quick} onClick={() => { if (!actions.busy) void moving(actions.setArchived(!review.userArchivedAt)); }}>
              <Icon name={review.userArchivedAt ? "ArchiveRestore" : "Archive"} aria-hidden />
            </Button>
          </Hint>}
        </div>
        <ReviewActions review={review} pinnable={pinnable} onChanged={onChanged} onMoved={keepFocus} onDeleted={onChanged} describedBy={titleId} className={cn(quick, "pointer-coarse:size-11")} />
      </div>
    </div>
  );
}
