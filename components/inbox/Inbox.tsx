import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import type { SyncHealth } from "../../src/review-lifecycle";
import { forgetReviews } from "../../lib/panel-state";
import { parsePrLink } from "../../lib/pr-link";
import { needsGroup, needsOrder, reviewState, type NeedsGroup, type ReviewItem } from "../../lib/review-state";
import { useKnob } from "../../lib/settings";
import { lastActivity } from "../../lib/status-line";
import { TITLE_BAR_WAIT_MS } from "../../lib/title-bar";
import type { TurnGroup } from "../../lib/turn";
import { cn } from "../../lib/utils";
import { useThreadListReviews } from "../NeedsReviewSidebar";
import { timeAgo } from "../time-ago";
import { Button } from "../ui/button";
import { CompactViewportOverrideProvider } from "../ui/hooks/use-compact-viewport";
import { Icon } from "../ui/icon";
import { Skeleton } from "../ui/skeleton";
import { FirstRun } from "./FirstRun";
import { InboxRow } from "./InboxRow";
import { InboxPart, InboxSection } from "./InboxSection";
import { ListTitleBar } from "./ListTitleBar";
import { Omnibox } from "./Omnibox";
import { TOUCH_CONTROL } from "../touch";
import { publishInboxBar, useListTitleBarMounted } from "./inbox-store";

const SECTIONS: Array<{ group: TurnGroup; title: string }> = [
  { group: "needs", title: "Needs review" },
  { group: "waiting", title: "Waiting on author" },
  { group: "reviewed", title: "Reviewed" },
  { group: "archive", title: "Archive" },
];
const NEEDS_PARTS: Array<{ part: NeedsGroup; title: string }> = [
  { part: "back", title: "Back to you" },
  { part: "new", title: "New" },
  { part: "team", title: "Team requests" },
];

/** The filter, kept for coming back to the list from a review. Before 0.6 it kept the list's tab too. */
const VIEW_KEY = "gr:review-list";
/** The sections you collapsed or expanded, in this browser. */
const SECTIONS_KEY = "gr:inbox-sections";
type Collapsed = Partial<Record<TurnGroup, boolean>>;
const COLLAPSED: Record<TurnGroup, boolean> = { needs: false, waiting: true, reviewed: true, archive: true };

function savedQuery(): string {
  try { return (JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "{}") as { query?: string }).query ?? ""; } catch { return ""; }
}

/** The sections you collapsed or expanded. The tab the list was left on before 0.6 expands its section, once. */
function savedSections(): Collapsed {
  let collapsed: Collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Collapsed; } catch { /* the defaults */ }
  try {
    const { tab, ...view } = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "{}") as { tab?: string; query?: string };
    if (tab === undefined) return collapsed;
    if (SECTIONS.some((section) => section.group === tab)) {
      collapsed = { ...collapsed, [tab]: false };
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(collapsed));
    }
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch { /* best-effort */ }
  return collapsed;
}

/** Whether the review matches every word of the filter, in its title, repository, @author, or #number. */
function matchesFilter(review: ReviewItem, query: string): boolean {
  const text = [review.title, review.repo, review.gitRef, review.author && `@${review.author}`, review.number && `#${review.number}`].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

/** The rows in order, with each stack's rows together where its first one was, bottom first. */
function withStacks(rows: ReviewItem[]): ReviewItem[][] {
  const placed = new Set<string>();
  const groups: ReviewItem[][] = [];
  for (const row of rows) {
    if (placed.has(row.targetKey)) continue;
    const order = row.stack?.members.map((member) => member.targetKey) ?? [];
    const group = row.stack ? rows.filter((r) => order.includes(r.targetKey)).sort((a, b) => order.indexOf(a.targetKey) - order.indexOf(b.targetKey)) : [row];
    for (const r of group) placed.add(r.targetKey);
    groups.push(group);
  }
  return groups;
}

/** Why GitHub can't be read now, and when it last was. Null when reading is fine. */
function syncProblem(health: SyncHealth | undefined): string | null {
  const error = health?.error;
  if (!error) return null;
  const detail = error.kind === "auth" ? "GitHub CLI isn’t signed in. Run gh auth login on the BB server."
    : error.kind === "rate-limit" ? `GitHub’s rate limit was reached. Reading again ${error.retryAt && error.retryAt > Date.now() ? `in ${Math.ceil((error.retryAt - Date.now()) / 60_000)}m` : "soon"}.`
    : error.kind === "partial" ? `Couldn’t read ${error.count === 1 ? "1 pull request" : `${error.count} pull requests`}.`
    : error.kind === "teams" ? "Couldn’t read your teams, so team requests may be missing. Run gh auth refresh -s read:org on the BB server."
    : "Couldn’t reach GitHub.";
  const read = timeAgo(health?.lastReadAt);
  return `${read ? `GitHub last read ${read}` : "GitHub hasn’t been read yet"}: ${detail}`;
}

/** The page's size, which decides where its find box goes; null until measured, or where it can't be. */
function useSize(element: HTMLElement | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((was) => was?.width === width && was.height === height ? was : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * All reviews: one find-or-paste box, then the queue in sections instead of tabs, in the order you'll work it. Needs
 * review is open, in three parts (Back to you, New, Team requests); Waiting on author, Reviewed and Archive start
 * closed. Where the page is short of room (a phone), the box opens from BB's title bar. With no reviews yet, a first-run
 * panel takes the sections' place.
 */
export function Inbox() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pinnable = useThreadListReviews() === true;
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState(savedQuery);
  const [collapsed, setCollapsed] = useState(savedSections);
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [health, setHealth] = useState<SyncHealth>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [boxFocused, setBoxFocused] = useState(false);
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const size = useSize(pageEl);
  useEffect(() => {
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ query })); } catch { /* best-effort */ }
  }, [query]);

  const refresh = useCallback(async (force = true) => {
    setRefreshing(true); setSyncError(false);
    try { const result = await rpc.call("refreshReviews", { force }); setReviews(result.reviews); setHealth(result.sync); }
    catch { setSyncError(true); }
    finally { setRefreshing(false); }
  }, [rpc]);
  const relist = useCallback(() => {
    void rpc.call("listReviews", null).then((result) => { setReviews(result.reviews); setHealth(result.sync); }).catch(() => {});
  }, [rpc]);
  // A sync pass can change many reviews at once: re-list once it settles.
  const relistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(relistTimer.current), []);
  useRealtime("reviews", () => {
    clearTimeout(relistTimer.current);
    relistTimer.current = setTimeout(relist, 250);
  });
  useRealtime("gh-account", () => { void refresh(); });
  useEffect(() => {
    // Coming back to the window reads only what's due; Refresh reads everything.
    const onFocus = () => { void refresh(false); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    rpc.call("listReviews", null)
      .then((result) => {
        // Every review there is: what was kept of a deleted one goes with it.
        forgetReviews(new Set((result.reviews as ReviewItem[]).map((review) => review.targetKey)));
        if (!cancelled) { setReviews(result.reviews as ReviewItem[]); setHealth(result.sync); }
      })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rpc, reload]);

  const firstRun = !loading && !loadError && reviews.length === 0;
  // GitHub's last read says nothing here: with no reviews there's nothing to read. The first run looks once itself.
  useEffect(() => { if (firstRun) void refresh(false); }, [firstRun, refresh]);
  // The box sits on the page where there's room for it beside the list; a phone opens it from the title bar.
  const searchInline = firstRun || !size || (size.width >= 560 && size.height >= 500);
  const compact = !!size && (size.width < 640 || size.height < 500);
  // A phone held sideways: rows and headers with less air, so four rows or more show.
  const short = !!size && size.height < 500;
  const openSearch = useCallback(() => {
    // Synchronously, so the box is there to focus inside the tap: iOS shows its keyboard only for that.
    flushSync(() => setSearchOpen(true));
    findBox.current?.focus();
  }, []);
  const closeSearch = useCallback(() => {
    findBox.current?.blur();
    setSearchOpen(false);
    setBoxFocused(false);
    setQuery("");
  }, []);
  // A phone's box sticks above the sections' headers while it's open; folding a Duo with the focus in it keeps it open.
  const phoneBox = !searchInline && (searchOpen || !!query || boxFocused);
  useEffect(() => publishInboxBar({ refreshing, health, searchInline, searchOpen: phoneBox, refresh: () => void refresh(), openSearch }),
    [refreshing, health, searchInline, phoneBox, refresh, openSearch]);
  // Without BB's title bar (an older BB), the page shows the list's controls itself.
  const titleBar = useListTitleBarMounted();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), TITLE_BAR_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const ownControls = waited && !titleBar;
  // / finds a review, from anywhere on the page but a text box, while single-key shortcuts are on.
  const shortcuts = useKnob("singleKeyShortcuts");
  useEffect(() => {
    if (!shortcuts) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target !== document.body && !pageEl?.contains(target)) return;
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      event.preventDefault();
      if (searchInline) findBox.current?.focus();
      else openSearch();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pageEl, searchInline, openSearch, shortcuts]);

  const link = parsePrLink(query);
  const searching = !!query.trim();
  const sections = useMemo(() => {
    const found = link ? reviews.filter((review) => review.repo?.toLowerCase() === link.repo && review.number === link.number)
      : searching ? reviews.filter((review) => matchesFilter(review, query)) : reviews;
    const groups: Record<TurnGroup, ReviewItem[]> = { needs: [], waiting: [], reviewed: [], archive: [] };
    for (const review of found) groups[reviewState(review).group].push(review);
    groups.needs.sort(needsOrder);
    // The rest: the latest activity first.
    for (const group of ["waiting", "reviewed", "archive"] as const) groups[group].sort((a, b) => (lastActivity(b) ?? 0) - (lastActivity(a) ?? 0));
    return groups;
  }, [reviews, query, link?.url, searching]);
  const isCollapsed = (group: TurnGroup) => !searching && (collapsed[group] ?? COLLAPSED[group]);
  function toggle(group: TurnGroup) {
    const next = { ...collapsed, [group]: !isCollapsed(group) };
    setCollapsed(next);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  }
  const open = (targetKey: string) => navigate.toPluginPanel("review", { subPath: targetKey });
  const row = (review: ReviewItem) => <li key={review.targetKey}><InboxRow review={review} pinnable={pinnable} short={short} onOpen={() => open(review.targetKey)} onChanged={relist} /></li>;
  // A list per section or part, so a screen reader says how many rows it holds; a stack is one item, its own list.
  const rows = (list: ReviewItem[]) => <ul>{withStacks(list).map((group) => group.length === 1 ? row(group[0]!)
    : <li key={group[0]!.targetKey}><div role="group" aria-label={`Stack of ${group[0]!.stack!.members.length} in ${group[0]!.repo}`} className="ml-3 border-l border-border"><ul>{group.map(row)}</ul></div></li>)}</ul>;
  const omnibox = <Omnibox query={query} onQuery={setQuery} reviews={reviews} onOpen={open} inputRef={findBox} onFocusChange={setBoxFocused}
    placeholder={firstRun ? "Paste a GitHub PR link to review it" : compact ? "Find or paste a PR link" : "Find a review, or paste a PR link"}
    onCancel={phoneBox ? closeSearch : undefined} trailing={searchInline && ownControls ? <ListTitleBar placement="page" /> : undefined} />;
  const problem = syncProblem(health);
  const waiting = sections.waiting.length;

  return (
    <CompactViewportOverrideProvider isCompactViewport={compact}>
    {/* BB clips a plugin page to the window, so the page scrolls itself. */}
    <div ref={setPageEl} className="@container/inbox h-full min-h-0 overflow-y-auto" style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col px-1.5 pb-8 @min-[640px]/inbox:px-6">
        {/* One element whether it's on the page or opened over it, so folding or unfolding a Duo keeps the box, its
            text and its focus. */}
        {!firstRun && (searchInline || phoneBox) && <div className={searchInline ? "px-1.5 pb-2 pt-4" : "sticky top-0 z-20 bg-background px-1.5 py-2"}>{omnibox}</div>}
        {!firstRun && !searchInline && !phoneBox && ownControls && <div className="flex justify-end py-1"><ListTitleBar placement="page" /></div>}
        {!syncError && problem && <p role="status" className={cn("mx-1.5 mb-2 flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning-text", firstRun && "mt-4")}><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{problem}</p>}
        {syncError && <p role="alert" className={cn("mx-1.5 mb-2 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text", firstRun && "mt-4")}><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />Couldn’t refresh GitHub status. Saved reviews are still available; try Refresh again.</p>}
        {firstRun ? <div className="px-2.5 pt-6"><FirstRun omnibox={omnibox} syncing={refreshing} /></div> : <>
          {loading ? <div role="status" aria-busy="true" className="space-y-1 pt-2"><span className="sr-only">Loading reviews…</span>
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="space-y-2 px-3 py-3"><Skeleton className="h-3.5" style={{ width: `${62 - i * 6}%` }} /><Skeleton className="h-3 w-48" /></div>)}
          </div>
            : loadError ? <div role="alert" className="px-4 py-10 text-center"><h2 className="font-medium">Couldn’t load your reviews</h2><p className="mt-2 text-sm text-muted-foreground">Your saved reviews haven’t been removed. Check the connection and try again.</p><Button variant="outline" className={cn("mt-4", TOUCH_CONTROL)} onClick={() => setReload((n) => n + 1)}>Try again</Button></div>
            : searching && SECTIONS.every(({ group }) => !sections[group].length) ? (link ? null : <div className="px-4 py-10 text-center">
              <h2 className="text-sm font-medium text-foreground">No reviews match “{query.trim()}”</h2>
              <p className="mt-1 text-sm text-muted-foreground">Try fewer words, or paste a PR link to review it.</p>
            </div>)
            : <div className="space-y-2 pt-1">
              {SECTIONS.map(({ group, title }) => {
                const list = sections[group];
                if (!list.length && (group !== "needs" || searching)) return null;
                return <InboxSection key={group} title={title} count={list.length} collapsed={isCollapsed(group)} onToggle={() => toggle(group)} short={short} stickyTop={phoneBox ? "top-14 pointer-coarse:top-[60px]" : undefined}>
                  {group !== "needs" ? rows(list)
                    : list.length ? NEEDS_PARTS.map(({ part, title: partTitle }) => {
                      const partRows = list.filter((review) => needsGroup(review) === part);
                      return partRows.length > 0 && <InboxPart key={part} title={partTitle} count={partRows.length} short={short}>{rows(partRows)}</InboxPart>;
                    })
                    : <p className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground"><Icon name="CircleCheck" className="size-4 shrink-0 text-diff-added" aria-hidden />
                      Nothing needs you right now{waiting > 0 && ` · ${waiting} waiting on ${waiting === 1 ? "an author" : "authors"}`}
                    </p>}
                </InboxSection>;
              })}
            </div>}
        </>}
      </div>
    </div>
    </CompactViewportOverrideProvider>
  );
}
