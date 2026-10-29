import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { reviewState, type ReviewItem } from "../lib/review-state";
import { defaultName, NAME_LIMIT } from "../lib/review-name";
import { reviewIdentity } from "../lib/review-identity";
import { canSnooze, canSnoozeUntil, snoozeLabel } from "../lib/turn";
import { updateDraftRecovery } from "../lib/draft-recovery";
import { forgetReview } from "../lib/panel-state";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { MENU_ITEM, SnoozeChoices } from "./SnoozeChoices";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * An item a page adds to a review's menu. `keys`: its key, shown at its right where there's a keyboard. `description`:
 * what it does beyond its label, for screen readers. `agent`: it starts an agent, so its icon takes the agent's tone.
 */
export type ReviewMenuItem = { label: string; icon: IconName; onSelect: () => void; keys?: string; description?: string; agent?: boolean };

/**
 * What can be done to a review from its menu or its row in the list, each said in a toast. Snooze, Pin, Rename and
 * Archive can be undone from theirs, since a row's quick actions take one click. `onChanged` follows each change.
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
  /** Your name for the review; "" puts its PR's title or ref back. Undo puts back the name it had. */
  const rename = useCallback((name: string, undoable = true): Promise<boolean> => {
    const previous = review.name ?? "";
    return run(() => rpc.call("renameReview", { targetKey, name }), name ? `Renamed to “${name}”` : review.kind === "pr" ? "Back to the PR’s title" : "Back to the ref",
      { undo: undoable ? () => void rename(previous, false) : undefined });
  }, [rpc, run, targetKey, review.name, review.kind]);
  const unsnooze = useCallback(() => run(() => rpc.call("snoozeReview", { targetKey, snoozed: false }), "Moved to Needs review"), [rpc, run, targetKey]);
  /** Until the author responds, or with `until`, until then too. */
  const snooze = useCallback((until?: number) => run(() => rpc.call("snoozeReview", { targetKey, snoozed: true, ...(until ? { until } : {}) }),
    until ? snoozeLabel(until) : "Snoozed until the author responds", { undo: () => void unsnooze() }), [rpc, run, targetKey, unsnooze]);
  const buildGuide = useCallback(() => run(() => rpc.call("startTrackedReview", { targetKey }), "Building the guide"), [rpc, run, targetKey]);
  // The page that showed it goes, rather than reading it again.
  const remove = useCallback(() => run(() => rpc.call("deleteReview", { targetKey }), "Review deleted", { changed: false }), [rpc, run, targetKey]);
  return { busy, setArchived, setPinned, rename, snooze, unsnooze, buildGuide, remove };
}

/**
 * Review actions (⋯): the page's own first (`items`, such as Update guide), then Build the guide, Snooze ›, Pin, Rename…,
 * the page's `afterRename` items, and Archive, then Open on GitHub and the page's `trailing` items, then Delete…, which asks first. A tracked review
 * builds its guide; a review you gave can wait until its author responds, and any request until a time you pick.
 */
export function ReviewActions({ review, items, afterRename, trailing, pinnable = false, onChanged, onMoved, onDeleted, describedBy, className }: {
  review: ReviewItem;
  /** Offer Pin: Settings shows reviews in BB's thread list. */
  pinnable?: boolean;
  /** Listed first, such as the workspace's Update guide. */
  items?: ReviewMenuItem[];
  /** Listed after Rename…, such as a local review's Rewrite guide: what starts an agent isn't where the menu opens. */
  afterRename?: ReviewMenuItem[];
  /** Listed after Open on GitHub, such as Keyboard shortcuts. */
  trailing?: ReviewMenuItem[];
  onChanged?: () => void;
  /** After Snooze, Back to Needs review, Archive or Unarchive, which move the review to another section; `from` had the focus. */
  onMoved?: (from: Element | null) => void;
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
  // Rename…'s dialog, and the name in its box.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const originalId = useId();
  // As every page and list calls it: a local review with no name goes by its guide's title.
  const title = reviewIdentity(review).name;
  const original = defaultName(review);
  const turn = reviewState(review);
  // GitHub state archives merged and closed PRs, and those you can no longer read or are no longer asked to review: only
  // the reviewer's own archive can be undone, and a review already in Archive can't be archived.
  const archivable = review.userArchivedAt ? !(review.prState === "MERGED" || review.prState === "CLOSED" || review.archivedAt) : turn.group !== "archive";
  // Only a review you've already given can wait for the author.
  const untilAuthor = canSnooze(review, turn);
  const untilTime = canSnoozeUntil(review, turn);
  const snoozed = turn.reason === "snoozed";
  // Archive takes a review out of Pinned, so it offers only Unpin there.
  const pin = pinnable && (!!review.pinnedAt || turn.group !== "archive");
  const open = (next: boolean) => {
    setMenuOpen(next);
    if (!next) setView("actions");
  };
  const pick = (action: () => unknown) => {
    open(false);
    void action();
  };
  const moving = async (action: Promise<boolean>) => { const from = document.activeElement; if (await action) onMoved?.(from); };
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
  const item = (entry: ReviewMenuItem) => <Button key={entry.label} variant="ghost" size="sm" aria-keyshortcuts={entry.keys} aria-description={entry.description} className={MENU_ITEM} onClick={() => pick(entry.onSelect)}>
    <Icon name={entry.icon} className={cn(entry.agent && "text-(--ansi-13)")} aria-hidden />{entry.label}{entry.keys && <kbd aria-hidden className="ml-auto hidden font-sans text-xs text-subtle-foreground pointer-fine:inline">{entry.keys}</kbd>}
  </Button>;

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (actions.busy) return;
    // Empty, or what it's called anyway, puts the PR's title or ref back; a local review's guide title, unchanged, stays its guide's.
    const name = draft.trim() === original || (!review.name && draft.trim() === title) ? "" : draft.trim();
    if (name === (review.name ?? "")) { setRenaming(false); return; }
    if (await actions.rename(name)) setRenaming(false);
  }

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
        <Button ref={trigger} variant="ghost" size="icon" aria-label="Review actions" aria-describedby={describedBy} aria-disabled={actions.busy} className={cn("shrink-0 text-muted-foreground aria-disabled:opacity-50", className)}
          onClick={(event) => { if (actions.busy) event.preventDefault(); }}>
          <Icon name="MoreHorizontal" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent ref={menu} align="end" mobileTitle={view === "snooze" ? "Snooze" : "Review actions"} className="w-64 max-w-[calc(100vw-24px)] p-1">
        {view === "snooze" ? <>
          <Button variant="ghost" size="sm" aria-label="Back to review actions" className={cn(MENU_ITEM, "font-semibold text-foreground")} onClick={() => show("actions")}>
            <Icon name="ChevronLeft" aria-hidden />Snooze
          </Button>
          <div role="separator" className="my-1 h-px bg-border" />
          <SnoozeChoices disabled={actions.busy} onUntilAuthor={untilAuthor ? () => pick(() => moving(actions.snooze())) : undefined} onPick={untilTime ? (until) => pick(() => moving(actions.snooze(until))) : undefined} />
        </> : <>
          {items?.map(item)}
          {review.status === "tracked" && item({ label: "Build the guide", icon: "Sparkles", onSelect: () => void actions.buildGuide() })}
          {snoozed ? item({ label: "Back to Needs review", icon: "ArrowTurnBackward", onSelect: () => void moving(actions.unsnooze()) })
            : (untilAuthor || untilTime) && <Button data-snooze-item variant="ghost" size="sm" className={MENU_ITEM} onClick={() => show("snooze")}>
              <Icon name="Clock" aria-hidden />Snooze<Icon name="ChevronRight" className="ml-auto text-subtle-foreground" aria-hidden />
            </Button>}
          {pin && item({ label: review.pinnedAt ? "Unpin" : "Pin", icon: review.pinnedAt ? "PinOff" : "Pin", onSelect: () => void actions.setPinned(!review.pinnedAt) })}
          {item({ label: "Rename…", icon: "Edit", onSelect: () => { setDraft(title); setRenaming(true); } })}
          {afterRename?.map(item)}
          {archivable && item({ label: review.userArchivedAt ? "Unarchive" : "Archive", icon: review.userArchivedAt ? "ArchiveRestore" : "Archive", onSelect: () => void moving(actions.setArchived(!review.userArchivedAt)) })}
          <div role="separator" className="my-1 h-px bg-border" />
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
    {/* Opened, the dialog focuses its box with the name selected, so typing replaces it; a phone's drawer waits for a tap. */}
    <Dialog open={renaming} onOpenChange={(next) => { if (!actions.busy) setRenaming(next); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <form className="grid gap-4" onSubmit={(event) => void saveName(event)}>
          <DialogHeader>
            <DialogTitle>Rename review</DialogTitle>
            <DialogDescription>{review.kind === "pr" ? "Shown in your lists instead of the PR’s title. Nothing changes on GitHub." : "Shown in your lists instead of the ref."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input ref={nameInput} aria-label="Review name" aria-describedby={originalId} value={draft} maxLength={NAME_LIMIT} readOnly={actions.busy} onChange={(event) => setDraft(event.target.value)} />
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span id={originalId} className="min-w-0 break-words">{review.kind === "pr"
                ? <><span className="text-subtle-foreground">PR title:</span> <InlineCode text={original} /></>
                : <><span className="text-subtle-foreground">Ref:</span> <span className="font-mono">{original}</span></>}</span>
              {draft.trim() !== original && <button type="button" className={cn("relative inline-flex items-center gap-1 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", TOUCH_TARGET)}
                onClick={() => { setDraft(original); nameInput.current?.focus(); }}>
                <Icon name="RotateCcw" className="size-3" aria-hidden />{review.kind === "pr" ? "Use PR title" : "Use ref"}
              </button>}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className={TOUCH_CONTROL} onClick={() => { if (!actions.busy) setRenaming(false); }}>Cancel</Button>
            {/* Busy, it stays focusable rather than drop the focus, and a press does nothing. */}
            <Button type="submit" className={cn("aria-disabled:opacity-50", TOUCH_CONTROL)} aria-disabled={actions.busy}>{actions.busy ? "Renaming…" : "Rename review"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={confirming} onOpenChange={(next) => { if (!actions.busy) setConfirming(next); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>“{title}” will be permanently removed from Code Review Workspace, with its guide, draft comments, private notes, and assistant conversation. Nothing changes on GitHub.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" className={TOUCH_CONTROL} disabled={actions.busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="destructive" className={TOUCH_CONTROL} disabled={actions.busy} onClick={() => void remove()}>{actions.busy ? "Deleting…" : "Delete review"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
