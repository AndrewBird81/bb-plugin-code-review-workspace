// The Main thread tab in BB's side panel (components/PanelTabs.tsx): the review's main thread, the thread that writes the
// code and gets your Sends, as BB's own chat beside the diff, its permissions the thread's own; which thread that is, on
// which machine, Change main thread, and Go to thread.
import { useEffect, useState, type KeyboardEvent } from "react";
import { experimental_useSidebarThreads, ThreadChat, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { MainThreadLink } from "../src/loop";
import { hasNotPushed, useChangeThreadAsked, useMainThread, useNotPushedAsked } from "../lib/main-thread";
import { usesFixer } from "../lib/fixer";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { ThreadName } from "./FixHandoff";
import { TabTitle } from "./TabTitle";
import { switchHint } from "../lib/commands";
import { NotPushed } from "./NotPushed";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const BUSY = new Set(["starting", "active", "stopping"]);

/** Moves focus between the picker's threads. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.closest("[role=menu]")?.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitem]") ?? []);
  items[items.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

/**
 * Change main thread: the threads you can send to instead, BB's own in the review's folder, or for a review of no
 * folder, in its project; not this plugin's agents, nor archived ones. Choosing one sends there from now on; Start a
 * fresh thread here starts one, which does.
 */
function ChangeMainThread({ current, onChanged }: { current: string | null; onChanged: () => void }) {
  const { targetKey, review } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  // Asked for from Finish review's Change main thread: the menu opens with the tab.
  const takeAsk = useChangeThreadAsked(targetKey);
  useEffect(() => { if (takeAsk()) setOpen(true); }, [takeAsk]);
  const [busy, setBusy] = useState<string | null>(null);
  const { threads } = experimental_useSidebarThreads();
  // A PR that sends to fixers has no folder of its own to start one in: a fresh one is a fixer at its head.
  const folder = review.feature && !review.feature.folderGone && !usesFixer(review) ? review.feature.environmentId : null;
  const choices = threads.filter((thread) => !thread.isHidden && !thread.isArchived
    && (folder ? thread.environment?.id === folder : !!review.projectId && thread.projectId === review.projectId));
  async function choose(threadId: string | null, title: string | null) {
    if (threadId === current) { setOpen(false); return; }
    setBusy(threadId ?? "fresh");
    try {
      const result = await rpc.call("setMainThread", threadId ? { targetKey, threadId } : { targetKey, fresh: true });
      if (!result.ok) throw new Error(result.error);
      setOpen(false);
      toast.success(title ? `Your Sends go to ${title} now.` : "Started a fresh thread: your Sends go there now.");
      onChanged();
    } catch (failure) {
      toast.error(failure instanceof Error && failure.message ? failure.message : "Couldn’t change the main thread. Try again.");
    } finally { setBusy(null); }
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" aria-label="Change main thread" className={cn("h-7 shrink-0 px-2 text-xs text-muted-foreground", TOUCH_CONTROL)}>Change thread</Button>
    </PopoverTrigger>
    <PopoverContent align="end" mobileTitle="Change main thread" className="w-72 p-1">
      <div role="menu" aria-label="Change main thread" className="flex flex-col">
        <p aria-hidden className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Send to</p>
        {!choices.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">{folder ? "No other thread works in this folder." : "No other thread works in this project."}</p>}
        <div className="max-h-72 overflow-y-auto">
          {choices.map((thread) => <button key={thread.id} type="button" role="menuitemradio" aria-checked={thread.id === current} aria-busy={busy === thread.id || undefined} onKeyDown={moveFocus} onClick={() => void choose(thread.id, thread.displayTitle)}
            className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none", TOUCH_CONTROL, "pointer-coarse:items-center")}>
            <Icon name={busy === thread.id ? "Loading" : "Check"} className={cn("mt-0.5 size-3.5 shrink-0 text-primary pointer-coarse:mt-0", busy === thread.id ? "animate-spin motion-reduce:animate-none" : thread.id !== current && "invisible")} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{thread.displayTitle}</span>
              {BUSY.has(thread.status) && <span className="block truncate text-[11px] text-subtle-foreground">Working now</span>}
            </span>
          </button>)}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <button type="button" role="menuitem" aria-busy={busy === "fresh" || undefined} onKeyDown={moveFocus} onClick={() => void choose(null, null)}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none", TOUCH_CONTROL)}>
            <Icon name={busy === "fresh" ? "Loading" : "Plus"} className={cn("size-3.5 shrink-0 text-muted-foreground", busy === "fresh" && "animate-spin motion-reduce:animate-none")} aria-hidden />
            {folder ? "Start a fresh thread here" : "Start a fresh thread"}
          </button>
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}

/** Which thread it is, on which machine, and whether it's working now, so a Send waits for its turn; Change and Go to thread. */
function ThreadLine({ thread, onChanged }: { thread: MainThreadLink; onChanged: () => void }) {
  const navigate = useBbNavigate();
  const listed = experimental_useSidebarThreads().threads.find((item) => item.id === thread.threadId);
  const working = thread.state === "open" && !!listed && BUSY.has(listed.status);
  return <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-border py-1 pl-3 pr-1.5 text-xs text-muted-foreground">
    <span className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
      {/* A fixer's title names its review: two lines rather than cut. */}
      <span className="min-w-0"><ThreadName threadId={thread.threadId} title={thread.title} wrap /></span>
      {thread.machine && <span className="flex shrink-0 items-center gap-1"><span aria-hidden>·</span><Icon name="Laptop" className="size-3.5" aria-hidden /><span>{thread.machine}</span></span>}
      {working && <span className="shrink-0">· Working: a Send waits for its turn</span>}
    </span>
    <ChangeMainThread current={thread.threadId} onChanged={onChanged} />
    {thread.state !== "gone" && <Hint label={switchHint("Go to the main thread")}><Button variant="ghost" size="sm" className={cn("h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground", TOUCH_CONTROL)} onClick={() => navigate.toThread(thread.threadId)}>Main thread<Icon name="ArrowUpRight" className="size-3.5" aria-hidden /></Button></Hint>}
  </div>;
}

/** Chat and Not pushed yet, the Main thread tab's two views on a PR, as tabs: the arrow keys move between them. */
function ViewTabs({ targetKey, view, onView }: { targetKey: string; view: "chat" | "not-pushed"; onView: (view: "chat" | "not-pushed") => void }) {
  const views = [["chat", "Chat"], ["not-pushed", "Not pushed yet"]] as const;
  const arrow = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = view === "chat" ? "not-pushed" : "chat";
    onView(next);
    requestAnimationFrame(() => event.currentTarget?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus());
  };
  return <div role="tablist" aria-label="Main thread" onKeyDown={arrow} className="flex shrink-0 gap-1 border-b border-border px-2 py-1">
    {views.map(([id, label]) => <button key={id} type="button" role="tab" data-view={id} aria-selected={view === id} tabIndex={view === id ? 0 : -1}
      aria-controls={id === "not-pushed" ? `${targetKey}-main-not-pushed` : undefined} onClick={() => onView(id)}
      className={cn("h-7 rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50", TOUCH_CONTROL,
        view === id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}>{label}</button>)}
  </div>;
}

/**
 * The Main thread tab: its header names it and the review, `Main thread · api:snooze-checks`; a line says which thread
 * it is, on which machine, and whether it's working now, with Change and Go to thread; then the thread's chat, which
 * can't widen its permissions. An archived thread shows its conversation without a box to write in. `active`: the tab
 * shows, so it reads the main thread and BB's thread list.
 */
export function MainThreadPanel({ active, reviewId, reviewName }: { active: boolean; reviewId?: string; reviewName?: string }) {
  const { targetKey, review } = useWorkspace();
  const { thread, reload } = useMainThread(targetKey, review, active);
  // On a PR whose main thread works in a folder, what it hasn't pushed yet, beside its chat; the compare menu opens it.
  const unpushed = hasNotPushed(review);
  const take = useNotPushedAsked(targetKey);
  const [view, setView] = useState<"chat" | "not-pushed">("chat");
  useEffect(() => { if (take()) setView("not-pushed"); }, [take]);
  const showing = unpushed ? view : "chat";
  const notice = (text: string) => <p role="status" className="m-3 rounded-lg border border-border bg-muted/25 p-3 text-sm text-muted-foreground">{text}</p>;
  return <section aria-label="Main thread" className="flex h-full min-h-0 flex-1 flex-col">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
      <Icon name="Code" className="size-4 shrink-0 text-primary" aria-hidden />
      <TabTitle title="Main thread" reviewId={reviewId} reviewName={reviewName} />
    </div>
    {/* BB's thread list is read only while the tab shows. */}
    {thread && active && <ThreadLine thread={thread} onChanged={reload} />}
    {unpushed && <ViewTabs targetKey={targetKey} view={showing} onView={setView} />}
    {showing === "not-pushed" ? <div id={`${targetKey}-main-not-pushed`} role="tabpanel" aria-label="Not pushed yet" className="flex min-h-0 flex-1 flex-col"><NotPushed targetKey={targetKey} active={active} /></div>
      : thread === undefined ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading the main thread…</p>
      : thread === null ? notice("This review has no main thread yet. Run bb review in the thread working on the change, and your Sends go there.")
      : thread.state === "gone" ? notice("The main thread was deleted. Your next Send starts a fresh thread, or choose another with Change.")
      : <>
        {thread.state === "archived" && <p role="status" className="shrink-0 border-b border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning-text">This thread is archived. Your next Send offers to unarchive it or start a fresh thread, or choose another with Change.</p>}
        <ThreadChat key={thread.threadId} threadId={thread.threadId} variant={thread.state === "archived" ? "timeline" : "compact"} permissionPolicy="inherit" className="min-h-0 flex-1" />
      </>}
  </section>;
}
