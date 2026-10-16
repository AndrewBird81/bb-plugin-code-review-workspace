import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { canSnooze, canSnoozeUntil, snoozeLabel } from "../lib/turn";
import { updateDraftRecovery } from "../lib/draft-recovery";
import { forgetReview } from "../lib/panel-state";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { MENU_ITEM, SnoozeChoices } from "./SnoozeChoices";
import { TOUCH_CONTROL } from "./touch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/** An item a page adds to a review's menu. `keys`: its key, shown at its right where there's a keyboard. */
export type ReviewMenuItem = { label: string; icon: IconName; onSelect: () => void; keys?: string };

/**
 * What can be done to a review from its menu or its row in the list, each said in a toast. Snooze, Pin and Archive can
 * be undone from theirs, since a row's quick actions take one click. `onChanged` follows each change.
 */
export function useReviewActions(review: ReviewItem, onChanged?: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const { targetKey } = review;
  const run = useCallback(async (call: () => Promise<{ ok: boolean; error?: string }>, success: string, { undo, changed = true }: { undo?: () => void; changed?: boolean } = {}) => {
    setBusy(true);
    try {
      const result = await call();
      if (!result.ok) toast.error(result.error ?? "Couldn’t update this review. Try again.");
      else {
        toast.success(success, undo ? { action: { label: "Undo", onClick: undo } } : undefined);
        if (changed) onChanged?.();
      }
      return result.ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update this review. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [onChanged]);
  const setArchived = useCallback((archived: boolean, undoable = true): Promise<boolean> => run(() => rpc.call("archiveReview", { targetKey, archived }),
    archived ? "Review archived" : "Review unarchived", { undo: archived && undoable ? () => void setArchived(false, false) : undefined }), [rpc, run, targetKey]);
  const setPinned = useCallback((pinned: boolean, undoable = true): Promise<boolean> => run(() => rpc.call("pinReview", { targetKey, pinned }),
    pinned ? "Pinned with your pinned threads" : "Unpinned", { undo: pinned && undoable ? () => void setPinned(false, false) : undefined }), [rpc, run, targetKey]);
  const unsnooze = useCallback(() => run(() => rpc.call("snoozeReview", { targetKey, snoozed: false }), "Moved to Needs review"), [rpc, run, targetKey]);
  /** Until the author responds, or with `until`, until then too. */
  const snooze = useCallback((until?: number) => run(() => rpc.call("snoozeReview", { targetKey, snoozed: true, ...(until ? { until } : {}) }),
    until ? snoozeLabel(until) : "Snoozed until the author responds", { undo: () => void unsnooze() }), [rpc, run, targetKey, unsnooze]);
  const buildGuide = useCallback(() => run(() => rpc.call("startTrackedReview", { targetKey }), "Building the guide"), [rpc, run, targetKey]);
  // The page that showed it goes, rather than reading it again.
  const remove = useCallback(() => run(() => rpc.call("deleteReview", { targetKey }), "Review deleted", { changed: false }), [rpc, run, targetKey]);
  return { busy, setArchived, setPinned, snooze, unsnooze, buildGuide, remove };
}

/**
 * Review actions (⋯): the page's own first (`items`, such as Update guide), then Build the guide, Snooze ›, Pin and
 * Archive, then Open on GitHub and the page's `trailing` items, then Delete…, which asks first. A tracked review builds
 * its guide; a review you gave can wait until its author responds, and any request until a time you pick.
 */
export function ReviewActions({ review, items, trailing, pinnable = false, onChanged, onDeleted, describedBy, className }: {
  review: ReviewItem;
  /** Offer Pin: Settings shows reviews in BB's thread list. */
  pinnable?: boolean;
  /** Listed first, such as the workspace's Update guide. */
  items?: ReviewMenuItem[];
  /** Listed after Open on GitHub, such as Keyboard shortcuts. */
  trailing?: ReviewMenuItem[];
  onChanged?: () => void;
  onDeleted?: () => void;
  /** Id of the element naming this review, for screen readers. */
  describedBy?: string;
  className?: string;
}) {
  const navigate = useBbNavigate();
  const actions = useReviewActions(review, onChanged);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu, or its Snooze choices in its place.
  const [view, setView] = useState<"actions" | "snooze">("actions");
  const [confirming, setConfirming] = useState(false);
  const title = review.title ?? review.gitRef ?? review.targetKey;
  // GitHub state archives merged and closed PRs; only the reviewer's own archive can be undone.
  const closed = review.prState === "MERGED" || review.prState === "CLOSED" || !!review.archivedAt;
  const turn = reviewState(review);
  // Only a review you've already given can wait for the author.
  const untilAuthor = canSnooze(review, turn);
  const untilTime = canSnoozeUntil(review, turn);
  const snoozed = turn.reason === "snoozed";
  // Archive takes a review out of Pinned, so it offers only Unpin there.
  const pin = pinnable && (!!review.pinnedAt || turn.group !== "archive");
  // The menu's first part (the page's items, guide, Snooze, Pin, Archive): a merged or closed review may have none of it.
  const top = !!items?.length || review.status === "tracked" || snoozed || untilAuthor || untilTime || pin || !closed;
  const open = (next: boolean) => {
    setMenuOpen(next);
    if (!next) setView("actions");
  };
  const pick = (action: () => unknown) => {
    open(false);
    void action();
  };
  // Switching between the menu and its Snooze choices keeps the focus in the menu: on the first choice, or back on Snooze.
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    menu.current?.querySelector<HTMLElement>(view === "snooze" ? "[role=group] button" : "[data-snooze-item]")?.focus();
  }, [view]);
  const show = (next: "actions" | "snooze") => {
    switched.current = true;
    setView(next);
  };
  const item = (entry: ReviewMenuItem) => <Button key={entry.label} variant="ghost" size="sm" aria-keyshortcuts={entry.keys} className={MENU_ITEM} onClick={() => pick(entry.onSelect)}>
    <Icon name={entry.icon} aria-hidden />{entry.label}{entry.keys && <kbd aria-hidden className="ml-auto hidden font-sans text-xs text-subtle-foreground pointer-fine:inline">{entry.keys}</kbd>}
  </Button>;

  async function remove() {
    if (!await actions.remove()) return;
    // This tab's unsaved-text recovery must not resurface if the PR is reviewed again.
    updateDraftRecovery(review.targetKey, { composer: undefined, summary: undefined });
    // Nor where it was left, nor its agent dock.
    forgetReview(review.targetKey);
    setConfirming(false);
    onDeleted?.();
  }

  return <>
    <Popover open={menuOpen} onOpenChange={open}>
      <PopoverTrigger asChild>
        <Button ref={trigger} variant="ghost" size="icon" aria-label="Review actions" aria-describedby={describedBy} disabled={actions.busy} className={cn("shrink-0 text-muted-foreground", className)}>
          <Icon name="MoreHorizontal" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent ref={menu} align="end" mobileTitle={view === "snooze" ? "Snooze" : "Review actions"} className="w-64 max-w-[calc(100vw-24px)] p-1">
        {view === "snooze" ? <>
          <Button variant="ghost" size="sm" aria-label="Back to review actions" className={cn(MENU_ITEM, "font-semibold text-foreground")} onClick={() => show("actions")}>
            <Icon name="ChevronLeft" aria-hidden />Snooze
          </Button>
          <div role="separator" className="my-1 h-px bg-border" />
          <SnoozeChoices disabled={actions.busy} onUntilAuthor={untilAuthor ? () => pick(() => actions.snooze()) : undefined} onPick={untilTime ? (until) => pick(() => actions.snooze(until)) : undefined} />
        </> : <>
          {items?.map(item)}
          {review.status === "tracked" && item({ label: "Build the guide", icon: "Sparkles", onSelect: () => void actions.buildGuide() })}
          {snoozed ? item({ label: "Back to Needs review", icon: "ArrowTurnBackward", onSelect: () => void actions.unsnooze() })
            : (untilAuthor || untilTime) && <Button data-snooze-item variant="ghost" size="sm" className={MENU_ITEM} onClick={() => show("snooze")}>
              <Icon name="Clock" aria-hidden />Snooze<Icon name="ChevronRight" className="ml-auto text-subtle-foreground" aria-hidden />
            </Button>}
          {pin && item({ label: review.pinnedAt ? "Unpin" : "Pin", icon: review.pinnedAt ? "PinOff" : "Pin", onSelect: () => void actions.setPinned(!review.pinnedAt) })}
          {!closed && item({ label: review.userArchivedAt ? "Unarchive" : "Archive", icon: review.userArchivedAt ? "ArchiveRestore" : "Archive", onSelect: () => void actions.setArchived(!review.userArchivedAt) })}
          {top && <div role="separator" className="my-1 h-px bg-border" />}
          {review.url && <Button variant="ghost" size="sm" className={MENU_ITEM} onClick={() => pick(() => navigate.openUrl(review.url!))}>
            <Icon name="Github" aria-hidden />Open on GitHub<Icon name="ArrowUpRight" className="ml-auto text-subtle-foreground" aria-hidden />
          </Button>}
          {trailing?.map(item)}
          {(review.url || !!trailing?.length) && <div role="separator" className="my-1 h-px bg-border" />}
          <Button variant="ghost" size="sm" className={cn(MENU_ITEM, "text-destructive-text hover:bg-destructive/10 hover:text-destructive-text")} disabled={review.status === "generating"} onClick={() => { open(false); setConfirming(true); }}>
            <Icon name="Trash2" aria-hidden />Delete…
          </Button>
          {review.status === "generating" && <p className="px-3 pb-2 text-xs text-muted-foreground">You can delete this review once its guide finishes generating.</p>}
        </>}
      </PopoverContent>
    </Popover>
    <Dialog open={confirming} onOpenChange={(next) => { if (!actions.busy) setConfirming(next); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>“{title}” will be permanently removed from Guided Review, with its guide, draft comments, private notes, and assistant conversation. Nothing changes on GitHub.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" className={TOUCH_CONTROL} disabled={actions.busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="destructive" className={TOUCH_CONTROL} disabled={actions.busy} onClick={() => void remove()}>{actions.busy ? "Deleting…" : "Delete review"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
