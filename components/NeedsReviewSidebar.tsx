import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_usePluginId, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { needsOrder, reviewState, type ReviewItem } from "../lib/review-state";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { kindLook } from "./ReviewStatus";
import { age } from "./time-ago";

// BB's thread list has no slot for another group, so Needs review goes in by hand: first, above Pinned and Threads.
// It finds the list by BB's own data attributes and goes back in whenever the list redraws; without the list it shows nowhere.

const COLLAPSED_KEY = "gr:needs-review-collapsed";

/** Holds the thread list's groups: the parent of each group's wrapper. Null when the list isn't drawn. */
function groupsContainer(): Element | null {
  const label = document.querySelector('[data-bb-plugin="thread-list"] [data-sidebar="group-label"]');
  return label?.closest("[data-sidebar-sticky-group]")?.parentElement?.parentElement ?? null;
}

/** A node kept first among the thread list's groups, for as long as the caller is mounted. */
function useGroupsSlot(): HTMLElement {
  const scope = usePortalScopeProps();
  const [node] = useState(() => {
    const div = document.createElement("div");
    div.hidden = true;
    // The plugin's stylesheet reaches it as it does a portaled popover.
    for (const [name, value] of Object.entries(scope)) div.setAttribute(name, value);
    return div;
  });
  useEffect(() => {
    const place = () => {
      if (node.isConnected && node.parentElement?.firstElementChild === node) return;
      const container = groupsContainer();
      if (container) container.prepend(node);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); node.remove(); };
  }, [node]);
  return node;
}

/** Reviews waiting on you, in the Needs review tab's order. */
function useNeedsReview(): ReviewItem[] {
  const rpc = useRpc<typeof rpcContract>();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const load = useCallback(() => {
    rpc.call("listReviews", null)
      .then((result) => setReviews(result.reviews.filter((review: ReviewItem) => reviewState(review).group === "needs").sort(needsOrder)))
      .catch(() => {});
  }, [rpc]);
  // A sync pass can change many reviews at once: re-list once it settles.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useRealtime("reviews", () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  });
  // Also on reconnecting, as after a phone sleeps, for what changed meanwhile.
  const connection = useRealtimeConnectionState();
  useEffect(() => { if (connection === "connected") load(); }, [connection, load]);
  return reviews;
}

/** BB closes its phone drawer when you open a thread from it, but has no call for plugins: press its toggle, as you would. */
function closePhoneSidebar() {
  const drawer = document.querySelector('[data-sidebar="panel"][role="dialog"][data-state="open"]');
  if (!drawer) return;
  const toggle = drawer.querySelector<HTMLElement>('[data-sidebar="trigger"]') ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
  toggle?.click();
}

export function NeedsReviewSidebar() {
  const slot = useGroupsSlot();
  const reviews = useNeedsReview();
  // Hidden, not just empty, so the list's spacing skips it.
  useEffect(() => { slot.hidden = !reviews.length; }, [slot, reviews.length]);
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggle = () => setCollapsed((value) => {
    try { localStorage.setItem(COLLAPSED_KEY, value ? "0" : "1"); } catch { /* best-effort */ }
    return !value;
  });
  const open = (event: MouseEvent, targetKey: string) => {
    // Modified clicks keep the link's own behavior.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate.toPluginPanel("review", { subPath: targetKey });
    closePhoneSidebar();
  };
  if (!reviews.length) return null;
  return createPortal(
    <section aria-label="Needs review" className="min-w-0">
      <button type="button" aria-expanded={!collapsed} onClick={toggle} className="group/needs flex h-7 w-full min-w-0 items-center gap-1 rounded-md pl-2 pr-2 text-left text-xs font-normal leading-5 text-muted-foreground outline-none ring-sidebar-ring hover:bg-state-hover focus-visible:ring-2 max-md:pointer-coarse:h-9">
        <span className="min-w-0 truncate">Needs review</span>
        {/* As on Pinned and Threads: open, the chevron waits for the pointer where there is one. */}
        <Icon name="ChevronRight" className={cn("size-3 shrink-0 text-subtle-foreground transition-transform duration-150", !collapsed && "rotate-90 [@media(hover:hover)]:opacity-0 group-hover/needs:opacity-100 group-focus-visible/needs:opacity-100")} aria-hidden />
        <span className="ml-auto tabular-nums text-subtle-foreground">{reviews.length}</span>
      </button>
      {!collapsed && <ul className="mt-1 space-y-0.5">
        {reviews.map((review) => {
          const title = review.title ?? review.gitRef ?? review.targetKey;
          const waited = age(reviewState(review).at);
          return <li key={review.targetKey}>
            <a href={`/plugins/${pluginId}/review/${review.targetKey}`} title={review.repo ? `${review.repo}${review.number ? ` #${review.number}` : ""}` : undefined} onClick={(event) => open(event, review.targetKey)}
              className="flex h-[var(--bb-sidebar-row-height)] w-full min-w-0 items-center gap-2 rounded-md pl-2 pr-2 text-sm text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 max-md:pointer-coarse:h-[var(--bb-sidebar-row-height-coarse)]">
              <Icon name={kindLook(review).icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {waited && <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">{waited}</span>}
            </a>
          </li>;
        })}
      </ul>}
    </section>,
    slot,
  );
}
NeedsReviewSidebar.displayName = "NeedsReviewSidebar";
