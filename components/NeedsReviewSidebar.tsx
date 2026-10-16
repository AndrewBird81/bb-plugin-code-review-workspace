import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { experimental_usePluginId, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { needsOrder, reviewState, type ReviewItem } from "../lib/review-state";
import { statusWhy } from "../lib/status-line";
import { usePortalScopeProps } from "../lib/portal-scope";
import { setPaletteCommands, usePaletteCommands } from "../lib/commands";
import { withDefaults } from "../lib/settings";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { kindLook } from "./ReviewStatus";
import { age } from "./time-ago";

// BB's thread list has no slot for more rows, so Guided Review puts its own in by hand: the reviews you pinned at the end of
// BB's Pinned group, and the rest of Needs review in a group of its own, last. It finds the list by BB's own data attributes
// and goes back in whenever the list redraws; without the list it shows nowhere.

const NEEDS_COLLAPSED_KEY = "gr:needs-review-collapsed";
const PINNED_COLLAPSED_KEY = "gr:pinned-reviews-collapsed";

/** Holds the thread list's groups: the parent of each group's wrapper. Null when the list isn't drawn. */
function groupsContainer(): Element | null {
  const label = document.querySelector('[data-bb-plugin="thread-list"] [data-sidebar="group-label"]');
  return label?.closest("[data-sidebar-sticky-group]")?.parentElement?.parentElement ?? null;
}

/** The rows of BB's Pinned group, the one group whose header doesn't stick. Null when Pinned is collapsed or not shown. */
function bbPinnedRows(): Element | null {
  return document.querySelector('[data-bb-plugin="thread-list"] [data-sidebar-sticky-group][data-sidebar-sticky-header="false"] [data-sidebar-sticky-section]');
}

/** A node kept first or last in `find()`'s element while `active`, and out of the page otherwise. */
function useSlot(active: boolean, at: "first" | "last", find: () => Element | null): HTMLElement {
  const scope = usePortalScopeProps();
  const [node] = useState(() => {
    const div = document.createElement("div");
    // The plugin's stylesheet reaches it as it does a portaled popover.
    for (const [name, value] of Object.entries(scope)) div.setAttribute(name, value);
    return div;
  });
  useEffect(() => {
    if (!active) return;
    const placed = () => node.isConnected && (at === "first" ? node.parentElement?.firstElementChild : node.parentElement?.lastElementChild) === node;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (placed()) return;
      const parent = find();
      if (at === "first") parent?.prepend(node);
      else parent?.append(node);
    };
    place();
    // Once a frame at most: the page changes constantly while an agent streams.
    const observer = new MutationObserver(() => { if (!frame && !placed()) frame = requestAnimationFrame(place); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); node.remove(); };
  }, [node, active, at, find]);
  return node;
}

/** Whether Settings shows reviews in BB's thread list; null until the settings load. */
export function useThreadListReviews(): boolean | null {
  const rpc = useRpc<typeof rpcContract>();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const load = useCallback(() => {
    rpc.call("getPreferences", null).then((record) => {
      setEnabled(record.preferences.threadListReviews);
      // BB asks whether the palette's commands are available synchronously, so this always-mounted load keeps their switch.
      setPaletteCommands(withDefaults(record.preferences).knobs.paletteCommands);
    }).catch(() => {});
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("preferences", load);
  return enabled;
}

/**
 * Reviews waiting on you, in the Needs review tab's order, and the ones you pinned, in the order you pinned them. Listed
 * only while `enabled`, as every BB window runs this.
 */
function useSidebarReviews(enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const load = useCallback(() => {
    if (!enabled) return;
    rpc.call("listReviews", null).then((result) => setReviews(result.reviews)).catch(() => {});
  }, [rpc, enabled]);
  // A sync pass can change many reviews at once: re-list once it settles.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useRealtime("reviews", () => {
    if (!enabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  });
  // Also on reconnecting, as after a phone sleeps, for what changed meanwhile, and on turning it on.
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === "connected") load(); }, [connection, load]);
  const setPinned = useCallback((targetKey: string, pinned: boolean) => {
    setReviews((list) => list.map((review) => review.targetKey === targetKey ? { ...review, pinnedAt: pinned ? Date.now() : null } : review));
    const failed = (error?: string) => { toast.error(error ?? "Couldn’t update this review. Try again."); load(); };
    rpc.call("pinReview", { targetKey, pinned }).then((result) => { if (!result.ok) failed(result.error); }, () => failed());
  }, [rpc, load]);
  return useMemo(() => ({
    // Archive takes a review out of Pinned; unarchiving puts it back.
    pinned: reviews.filter((review) => review.pinnedAt && reviewState(review).group !== "archive").sort((a, b) => a.pinnedAt! - b.pinnedAt!),
    needs: reviews.filter((review) => !review.pinnedAt && reviewState(review).group === "needs").sort(needsOrder),
    setPinned,
  }), [reviews, setPinned]);
}

/** BB closes its phone drawer when you open a thread from it, but has no call for plugins: press its toggle, as you would. */
function closePhoneSidebar() {
  const drawer = document.querySelector('[data-sidebar="panel"][role="dialog"][data-state="open"]');
  if (!drawer) return;
  const toggle = drawer.querySelector<HTMLElement>('[data-sidebar="trigger"]') ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
  toggle?.click();
}

/** A group in BB's look: its label collapses it, remembered in this browser. */
function Group({ label, count, collapsedKey, children }: { label: string; count?: number; collapsedKey: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(collapsedKey) === "1"; } catch { return false; }
  });
  const toggle = () => setCollapsed((value) => {
    try { localStorage.setItem(collapsedKey, value ? "0" : "1"); } catch { /* best-effort */ }
    return !value;
  });
  return (
    <section aria-label={label} className="min-w-0">
      <button type="button" aria-expanded={!collapsed} onClick={toggle} className="group/label flex h-7 w-full min-w-0 items-center gap-1 rounded-md pl-2 pr-2 text-left text-xs font-normal leading-5 text-muted-foreground outline-none ring-sidebar-ring hover:bg-state-hover focus-visible:ring-2 max-md:pointer-coarse:h-9">
        <span className="min-w-0 truncate">{label}</span>
        {/* As on BB's groups: open, the chevron waits for the pointer where there is one. */}
        <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-subtle-foreground transition-transform duration-150", !collapsed && "rotate-90 [@media(hover:hover)]:opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100")} aria-hidden />
        {count !== undefined && <span className="ml-auto tabular-nums text-subtle-foreground">{count}</span>}
      </button>
      {!collapsed && <div className="mt-1">{children}</div>}
    </section>
  );
}

export function NeedsReviewSidebar() {
  // BB's command palette's commands run here, the one place always mounted.
  usePaletteCommands();
  // Off in Settings, nothing goes into BB's list.
  const enabled = useThreadListReviews() === true;
  const sidebarReviews = useSidebarReviews(enabled);
  const needs = enabled ? sidebarReviews.needs : [], pinned = enabled ? sidebarReviews.pinned : [];
  const { setPinned } = sidebarReviews;
  // Whether BB draws its Pinned group: it does while you have a pinned thread. Until it says, pinned reviews wait.
  const sidebar = experimental_useSidebarThreads();
  const known = sidebar.status === "ready";
  const bbPinned = sidebar.threads.some((thread) => thread.isPinned && !thread.isArchived && !thread.isHidden);
  const needsSlot = useSlot(needs.length > 0, "last", groupsContainer);
  const inBbPinned = useSlot(known && pinned.length > 0 && bbPinned, "last", bbPinnedRows);
  const ownPinned = useSlot(known && pinned.length > 0 && !bbPinned, "first", groupsContainer);
  // Keeps "2h" true while the page stays open.
  const [, tick] = useState(0);
  useEffect(() => {
    const minute = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(minute);
  }, []);
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const open = (event: MouseEvent, targetKey: string) => {
    // Modified clicks keep the link's own behavior.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate.toPluginPanel("review", { subPath: targetKey });
    closePhoneSidebar();
  };
  const rows = (list: ReviewItem[], isPinned: boolean) => <ul className="space-y-0.5">
    {list.map((review) => {
      const title = review.title ?? review.gitRef ?? review.targetKey;
      const turn = reviewState(review);
      const waited = turn.group === "needs" ? age(turn.at) : null;
      // Where the PR is, why it's yours, and for how long, in the inbox's words.
      const where = review.repo ? `${review.repo}${review.number ? ` #${review.number}` : ""}` : null;
      const why = statusWhy(review)?.text;
      const tooltip = [where, why, waited].filter(Boolean).join(" · ") || undefined;
      // The tooltip reaches neither touch nor a screen reader: the row also says where and why in words.
      const describedBy = where || why ? `gr-row-why-${isPinned ? "pinned" : "needs"}-${review.targetKey}` : undefined;
      return <li key={review.targetKey} className="group/row flex h-[var(--bb-sidebar-row-height)] min-w-0 items-center rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:pointer-coarse:h-[var(--bb-sidebar-row-height-coarse)]">
        <a href={`/plugins/${pluginId}/review/${review.targetKey}`} title={tooltip} aria-describedby={describedBy} onClick={(event) => open(event, review.targetKey)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-1 outline-none ring-sidebar-ring focus-visible:ring-2">
          <Icon name={kindLook(review).icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {waited && <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">{waited}</span>}
        </a>
        {describedBy && <span id={describedBy} className="sr-only">{[where, why].filter(Boolean).join(", ")}</span>}
        {/* Shows on hover where there's a pointer, as BB's row actions do. A touch screen, which can't hover, keeps
            its rows clear, as BB's own are: the review's menu pins it there. */}
        <button type="button" aria-label={`${isPinned ? "Unpin" : "Pin"} ${title}`} onClick={() => setPinned(review.targetKey, !isPinned)}
          className="mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none ring-sidebar-ring hover:bg-state-hover hover:text-muted-foreground focus-visible:opacity-100 focus-visible:ring-2 group-hover/row:opacity-100 max-md:pointer-coarse:size-9 [@media(hover:hover)]:opacity-0 [@media(hover:none)]:hidden">
          <Icon name={isPinned ? "PinOff" : "Pin"} className="size-4" aria-hidden />
        </button>
      </li>;
    })}
  </ul>;
  return <>
    {needs.length > 0 && createPortal(<Group label="Needs review" count={needs.length} collapsedKey={NEEDS_COLLAPSED_KEY}>{rows(needs, false)}</Group>, needsSlot)}
    {known && pinned.length > 0 && (bbPinned
      // Inside BB's Pinned, after its threads; collapsing Pinned hides them with the rest.
      ? createPortal(rows(pinned, true), inBbPinned)
      // With no pinned thread BB draws no Pinned, so the reviews get one of the same look.
      : createPortal(<Group label="Pinned" collapsedKey={PINNED_COLLAPSED_KEY}>{rows(pinned, true)}</Group>, ownPinned))}
  </>;
}
NeedsReviewSidebar.displayName = "NeedsReviewSidebar";
