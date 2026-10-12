import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { sameLocation, VERDICT_LABEL } from "../../src/draft";
import { buildItems, checkTally, FILTER_LABEL, groups, needsYou, shownItems, toSend, type CommentFilter, type CommentGroup, type CommentItem, type CommentSources } from "../../lib/comments";
import { clearOpenComments, revealComment } from "../../lib/comments-fold";
import { registerCommentStepper, showCommentStep, useCommentStep } from "../../lib/comment-stops";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { setNeedsYou } from "../../lib/workspace-store";
import { useDraft } from "../DraftProvider";
import { ComposerFields } from "../InlineDraft";
import { PanelActionsContext } from "../shell/SidePanel";
import { timeAgo } from "../time-ago";
import { Hint } from "../ui/hint";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { TOUCH_CONTROL } from "../touch";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CheckStrip } from "./CheckStrip";
import { usePanelComposer } from "./CommentCard";
import { CommentRow } from "./CommentRow";
import { notSubmitted } from "./look";
import { updateComments, useComments } from "./store";

/** Where the workspace opens Comments: as you left it, on what needs you, or on GitHub's threads (as 0.5 left them). */
export type CommentsTab = "drafts" | "feedback" | "threads";
const TAB_FILTER: Record<Exclude<CommentsTab, "drafts">, CommentFilter> = { feedback: "needs-you", threads: "on-github" };
const FILTERS: CommentFilter[] = ["all", "needs-you", "not-submitted", "on-github"];

/**
 * Comments: every comment-like thing in the review in one list beside the code, in four groups (Needs you, Not
 * submitted, On GitHub, Private) behind chips, with the agent's check, and Finish review pinned at the bottom. It builds
 * the review's items once, for the list, the cards in the code, ] and [, and the title bar's "need you" badge. Hidden,
 * it stays mounted: they need it. Finish review is its own view (`finish`).
 */
export function CommentsView({ shown, finish, tab, onTab, onShowThread }: {
  shown: boolean;
  finish: boolean;
  tab: CommentsTab;
  onTab: (tab: CommentsTab) => void;
  /** The review revision the page shows. */
  revision: string;
  /** Show a GitHub thread's line, with the threads showing in the code. */
  onShowThread: (file: string, line: number | null, side: "LEFT" | "RIGHT", url?: string | null) => void;
}) {
  const api = useWorkspace();
  const { targetKey, review, sections, display } = api;
  const draft = useDraft();
  const navigate = useBbNavigate();
  const coarse = useMediaQuery("(pointer: coarse)");
  const isPr = review.kind === "pr";
  const visible = shown && !finish;
  const closed = review.prState === "MERGED" || review.prState === "CLOSED";
  const threads = useComments(targetKey, "threads");
  const feedback = useComments(targetKey, "feedback");
  const replyDrafts = useComments(targetKey, "replyDrafts");
  const githubRead = useComments(targetKey, "loaded");
  const threadsError = useComments(targetKey, "threadsError");
  const feedbackError = useComments(targetKey, "feedbackError");
  const actions = useComments(targetKey, "actions");
  const refreshing = useComments(targetKey, "refreshing");
  const checking = useComments(targetKey, "checking");
  const filter = useComments(targetKey, "filter");
  const expanded = useComments(targetKey, "expanded");
  const step = useCommentStep(targetKey);
  const [showFolded, setShowFolded] = useState(false);

  const sources = useMemo((): CommentSources => ({
    draft: draft.loaded ? { draft: draft.draft, stale: draft.stale, discussions: draft.discussions } : null,
    threads: isPr ? threads : [], feedback: isPr ? feedback : null, replyDrafts: isPr ? replyDrafts : [],
    sections, patch: draft.patch, viewer: draft.account ?? null, prUrl: review.url ?? null, closed,
  }), [draft.loaded, draft.draft, draft.stale, draft.discussions, isPr, threads, feedback, replyDrafts, sections, draft.patch, draft.account, review.url, closed]);
  const items = useMemo(() => buildItems(sources), [sources]);
  const sending = useMemo(() => toSend(sources), [sources]);
  // Hidden nits leave the list and the code, not what Submit sends.
  const listItems = useMemo(() => draft.hideNits ? items.filter((item) => !(item.kind === "draft" && item.comment.severity === "nit")) : items, [items, draft.hideNits]);
  const counted = useMemo(() => groups(items), [items]);
  const listed = useMemo(() => groups(listItems), [listItems]);
  const stops = useMemo(() => shownItems(listItems, filter, showFolded), [listItems, filter, showFolded]);
  const needing = counted[0].count;

  useEffect(() => { updateComments(targetKey, { items }); }, [targetKey, items]);
  useEffect(() => {
    updateComments(targetKey, { folded: display.commentsFolded });
    clearOpenComments(targetKey);
  }, [targetKey, display.commentsFolded]);
  useEffect(() => { setNeedsYou(targetKey, needing); }, [targetKey, needing]);
  useEffect(() => () => setNeedsYou(targetKey, 0), [targetKey]);
  // Opened on what needs you, or on GitHub's threads: the chip, once. Then the workspace's tab is back to the list.
  useEffect(() => {
    if (tab === "drafts") return;
    updateComments(targetKey, { filter: TAB_FILTER[tab], expanded: null });
    onTab("drafts");
  }, [tab, targetKey, onTab]);
  // The list is on screen: the step bar's job is done.
  useEffect(() => { if (visible) showCommentStep(targetKey, null); }, [visible, targetKey]);

  // The side panel's comment box, on an item in the list or a new one.
  const box = draft.showComposer && !draft.inline && !draft.onSummary ? { file: draft.file, line: Number(draft.line), side: draft.side } : null;
  const boxItem = box && (draft.editing || draft.asking)
    ? items.find((item) => (item.kind === "draft" && sameLocation(item.comment, box)) || (item.kind === "private" && sameLocation(item.discussion, box)))
    : undefined;
  useEffect(() => {
    if (!boxItem) return;
    updateComments(targetKey, { expanded: boxItem.id, ...(stops.some((item) => item.id === boxItem.id) ? {} : { filter: "all" as const }) });
  }, [boxItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Going to an item: its card in the code opens and flashes; from an overlay or sheet on touch, the step bar shows.
  const [current, setCurrent] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  const live = useRef({ api, stops, filter, coarse, step, onShowThread, visible });
  live.current = { api, stops, filter, coarse, step, onShowThread, visible };
  const goTo = useCallback((item: CommentItem, from: "row" | "step") => {
    const { api, stops, filter, coarse, step, onShowThread } = live.current;
    revealComment(targetKey, item.id);
    last.current = item.id;
    setCurrent(item.id);
    const over = api.layout.panel === "overlay";
    if (!item.at) {
      api.panel.open("comments");
      updateComments(targetKey, { expanded: item.id });
      return;
    }
    if (item.kind === "thread") onShowThread(item.at.file, item.at.line, item.at.side, item.url);
    else if (item.chapterId === null) api.showLocation(item.at.file, item.at.line, item.at.side);
    else api.reveal({ file: item.at.file, line: item.at.line ?? 0, side: item.at.side });
    const index = stops.findIndex((stop) => stop.id === item.id);
    if (index < 0) return;
    const at = { id: item.id, index, total: stops.length, filter: FILTER_LABEL[filter], nonce: Date.now() };
    if (step?.via === "bar" || (from === "row" && over && coarse)) showCommentStep(targetKey, { ...at, via: "bar" });
    else if (from === "step" && api.panel.view !== "comments") showCommentStep(targetKey, { ...at, via: "hint" });
  }, [targetKey]);
  // ] and [, and the step bar's arrows: the list's order and filter, from the item last gone to, or the file you're on.
  useEffect(() => registerCommentStepper(targetKey, (direction, file) => {
    const { stops } = live.current;
    if (!stops.length) return;
    let index = last.current ? stops.findIndex((stop) => stop.id === last.current) : -1;
    if (index >= 0) index = (index + direction + stops.length) % stops.length;
    else {
      const here = file ? stops.findIndex((stop) => stop.at?.file === file) : -1;
      index = here >= 0 ? here : direction === 1 ? 0 : stops.length - 1;
    }
    goTo(stops[index], "step");
  }), [targetKey, goTo]);
  const show = useCallback((item: CommentItem) => goTo(item, "row"), [goTo]);
  const expand = useCallback((id: string | null) => updateComments(targetKey, { expanded: id }), [targetKey]);
  const setFilter = (next: CommentFilter) => updateComments(targetKey, { filter: next });
  // A step taken with the list on screen shows in it; so does Show in list, from the step bar, with the item open.
  const scroller = useRef<HTMLElement | null>(null);
  const rowOf = (id: string) => Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-comment-row]") ?? []).find((el) => el.dataset.commentRow === id);
  useEffect(() => { if (current && visible) rowOf(current)?.scrollIntoView?.({ block: "nearest" }); }, [current, visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!expanded || !visible) return;
    requestAnimationFrame(() => rowOf(expanded)?.scrollIntoView?.({ block: "nearest" }));
  }, [expanded, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const composer = usePanelComposer();
  const slot = useContext(PanelActionsContext);
  const container = useFullscreenPortalContainer();
  const mine = items.some((item) => item.kind === "ask" || (item.kind === "thread" && item.mine));
  const folded = counted[2].folded;
  const ready = draft.loaded && (!isPr || githubRead);
  const row = (item: CommentItem) => <CommentRow key={item.id} targetKey={targetKey} item={item} expanded={expanded === item.id} current={current === item.id} onShow={item.at ? show : null} onExpand={expand} />;
  const groupBody = (group: CommentGroup, rows: CommentItem[], countedGroup: CommentGroup) => (
    <section key={group.id} aria-labelledby={`gr-group-${group.id}`} className="space-y-1.5">
      <GroupHead id={`gr-group-${group.id}`} title={group.title} count={countedGroup.count} summary={[countedGroup.summary, group.id === "not-submitted" && draft.hideNits && draft.nitCount ? `${draft.nitCount} hidden` : null].filter(Boolean).join(" · ") || null} />
      {rows.length > 0 && <ul className="space-y-1.5">{rows.map(row)}</ul>}
      {filter === "all" && group.id === "not-submitted" && countedGroup.elsewhere > 0 && (
        <p className="px-1 text-xs text-muted-foreground">+{countedGroup.elsewhere} on an older diff, in Needs you</p>
      )}
      {group.id === "on-github" && group.folded && <>
        <button type="button" aria-expanded={showFolded} onClick={() => setShowFolded(!showFolded)} className={cn("flex min-h-8 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL, "pointer-coarse:min-h-11")}>
          <Icon name="ChevronRight" className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", showFolded && "rotate-90")} aria-hidden />{group.folded.label}
        </button>
        {(showFolded || group.folded.items.some((item) => item.id === expanded)) && <ul className="space-y-1.5">{group.folded.items.filter((item) => showFolded || item.id === expanded).map(row)}</ul>}
      </>}
    </section>
  );
  const shownGroups = filter === "all" ? listed.filter((group) => group.items.length || group.folded || (group.id === "not-submitted" && counted[1].elsewhere)) : listed.filter((group) => group.id === filter);
  // ↻ and ⋯, in the panel's header; in the list's own top row where there's none.
  const headerActions = <>
    {isPr && actions && <Hint label={feedback?.fetchedAt ? `Refresh comments · GitHub read ${timeAgo(feedback.fetchedAt)}` : "Refresh comments"} container={container}>
      <Button variant="ghost" size="sm" aria-label="Refresh comments" disabled={refreshing} className={cn("size-8 px-0 text-muted-foreground", TOUCH_CONTROL)} onClick={() => void actions.refresh()}>
        <Icon name="ArrowReloadHorizontal" className={cn(refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden />
      </Button>
    </Hint>}
    <CommentOptions isPr={isPr} url={review.url ?? null} folded={!!folded} showFolded={showFolded} onShowFolded={setShowFolded} onOpenUrl={(url) => navigate.openUrl(url)} />
  </>;
  const empty = ready && !items.length;
  const filterEmpty = ready && !empty && filter !== "all" && !stops.length && !(filter === "on-github" && folded);

  return (
    <div hidden={!visible} className={cn("flex min-h-0 flex-1 flex-col", !visible && "hidden")}>
      {visible && (slot ? createPortal(headerActions, slot) : <div className="flex shrink-0 justify-end gap-1 border-b border-border px-2 py-1">{headerActions}</div>)}
      <section aria-label="Comments" ref={(el) => { scroller.current = el as HTMLDivElement | null; (draft.listRef as { current: HTMLElement | null }).current = el; }} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {draft.showComposer && draft.inline && !draft.onSummary && (
          <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/40 py-1 pl-3 pr-1 text-xs text-muted-foreground">
            <Icon name="Edit" className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 break-words">{draft.asking ? `Writing to the agent about ${draft.file}:${draft.boxLines}` : `Writing a comment on ${draft.file}:${draft.boxLines}`}</span>
            <Button variant="ghost" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} onClick={() => api.reveal({ file: draft.file, line: Number(draft.line), side: draft.side })}>Show in diff</Button>
          </div>
        )}
        {isPr && <Chips groups={counted} total={items.length} filter={filter} onFilter={setFilter} />}
        {!isPr && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />Comments on a local review stay in BB.</p>}
        {isPr && mine && !closed && <CheckStrip run={feedback?.run ?? null} tally={checkTally(items)} running={!!review.verifyingSince} starting={checking} onCheck={() => void actions?.checkAgain()} />}
        {isPr && threadsError !== null && <Notice tone="danger" action={actions && <Button variant="outline" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} disabled={refreshing} onClick={() => void actions.refresh()}>Try again</Button>}>
          {threads.length ? `Couldn’t load every thread: ${threadsError}` : <>Couldn’t load review threads.{threadsError && <span className="mt-0.5 block break-words text-xs">{threadsError}</span>}</>}
        </Notice>}
        {isPr && feedbackError && <Notice tone="danger" action={actions && <Button variant="outline" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} onClick={() => void actions.refresh()}>Try again</Button>}>Couldn’t load your feedback.</Notice>}
        {draft.loadError ? <div role="alert" className="space-y-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" onClick={() => void draft.load()}>Retry draft</Button></div>
          : !draft.loaded ? <p role="status" className="text-sm text-muted-foreground">Loading comments…</p> : <>
          {box && !boxItem && draft.editable && <NewComment composer={composer} />}
          {isPr && !githubRead && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Reading GitHub…</p>}
          {empty ? <Empty text={closed ? "No comments on this review." : "No comments yet. Select a line, or tap + beside one, to comment."} />
            : filterEmpty ? <Empty text={filter === "needs-you" ? "Nothing needs you." : filter === "not-submitted" ? "No comments to submit yet." : "Nothing on GitHub yet."} onAll={() => setFilter("all")} />
            : shownGroups.map((group) => groupBody(group, filter === "not-submitted" ? stops : group.items, counted.find((entry) => entry.id === group.id)!))}
        </>}
      </section>
      {!closed && draft.loaded && !draft.loadError && (
        <div className="flex min-h-14 shrink-0 items-center gap-2 border-t border-border py-2 pl-3 pr-2">
          <p role="status" className={cn("min-w-0 flex-1 truncate text-xs", draft.status.error ? "text-destructive-text" : "text-muted-foreground")}>
            {draft.status.error ?? (draft.status.saving ? "Saving…" : draft.completed ? "Review submitted"
              : !isPr ? `${sending.comments} comment${sending.comments === 1 ? "" : "s"} · stay in BB`
              : <><span className="font-medium text-foreground">{VERDICT_LABEL[sending.verdict]}</span> · {sending.comments} to send</>)}
          </p>
          <Button size="sm" className={cn("shrink-0 gap-1.5", TOUCH_CONTROL)} onClick={() => api.openFinish()}>Finish review<Icon name="ArrowRight" className="size-3.5" aria-hidden /></Button>
        </div>
      )}
    </div>
  );
}

/** A group's heading: its title, how many its chip shows, and its summary ("1 blocking · 2 nits", "Yours: 2 of 2 handled"). */
function GroupHead({ id, title, count, summary }: { id: string; title: string; count: number; summary: string | null }) {
  const [main, rest] = title.split(" · ");
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 px-1 pt-1">
      <h3 id={id} className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">
        {main}{rest && <span className="font-normal normal-case tracking-normal"> · {rest}</span>}<span className="tabular-nums"> · {count}</span>
      </h3>
      {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
    </div>
  );
}

/** The chips: All, Needs you, Not submitted, On GitHub, each with its count, as a radio group. */
function Chips({ groups, total, filter, onFilter }: { groups: CommentGroup[]; total: number; filter: CommentFilter; onFilter: (filter: CommentFilter) => void }) {
  const count = (id: CommentFilter) => id === "all" ? total : groups.find((group) => group.id === id)!.count;
  return (
    <div role="radiogroup" aria-label="Show" className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
      {FILTERS.map((id) => {
        const on = filter === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} aria-label={`${FILTER_LABEL[id]}, ${count(id)}`} onClick={() => onFilter(id)}
            className={cn("flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:px-3.5", TOUCH_CONTROL,
              on ? "border-primary/40 bg-primary/12 text-foreground" : "border-border text-muted-foreground hover:border-input hover:text-foreground")}>
            {FILTER_LABEL[id]}
            <span className={cn("tabular-nums", on ? "text-primary" : "text-subtle-foreground", id === "needs-you" && count(id) > 0 && !on && "text-primary")}>{count(id)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** ⋯ Comment options: hide or remove nits, show resolved threads, add a comment by file and line, and the PR on GitHub. */
function CommentOptions({ isPr, url, folded, showFolded, onShowFolded, onOpenUrl }: {
  isPr: boolean; url: string | null; folded: boolean; showFolded: boolean; onShowFolded: (show: boolean) => void; onOpenUrl: (url: string) => void;
}) {
  const draft = useDraft();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = cn("w-full justify-start text-muted-foreground hover:text-foreground", TOUCH_CONTROL);
  // What a choice opens gives the focus back to ⋯, not to the menu that's gone.
  const close = (then: () => void) => () => { trigger.current?.focus(); setOpen(false); then(); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button ref={trigger} variant="ghost" size="sm" aria-label="Comment options" className={cn("size-8 px-0 text-muted-foreground", TOUCH_CONTROL)}><Icon name="MoreHorizontal" aria-hidden /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileTitle="Comment options" className="w-60 max-w-[calc(100vw-24px)] p-1">
        <Button variant="ghost" size="sm" role="switch" aria-checked={draft.hideNits} className={item} onClick={draft.toggleNits}>
          <Icon name={draft.hideNits ? "EyeOff" : "Eye"} aria-hidden />Hide nits{draft.hideNits && <Icon name="Check" className="ml-auto text-primary" aria-hidden />}
        </Button>
        <Button variant="ghost" size="sm" className={item} disabled={!draft.nitCount || draft.busy || !draft.editable} onClick={close(() => void draft.removeNits())}>
          <Icon name="Trash2" aria-hidden />Remove nits
        </Button>
        {isPr && <Button variant="ghost" size="sm" role="switch" aria-checked={showFolded} disabled={!folded} className={item} onClick={() => onShowFolded(!showFolded)}>
          <Icon name="CircleCheck" aria-hidden />Show resolved threads{showFolded && <Icon name="Check" className="ml-auto text-primary" aria-hidden />}
        </Button>}
        <Button variant="ghost" size="sm" className={item} disabled={!draft.editable} onClick={close(() => draft.openComposer(null, false))}>
          <Icon name="MessageSquarePlus" aria-hidden />Add comment by line…
        </Button>
        {isPr && url && <Button variant="ghost" size="sm" className={item} onClick={close(() => onOpenUrl(url))}>
          <Icon name="Github" aria-hidden />Open PR on GitHub
        </Button>}
      </PopoverContent>
    </Popover>
  );
}

/** A comment written in the panel by file and line, rather than at its line in the code. */
function NewComment({ composer }: { composer: ReturnType<typeof usePanelComposer> }) {
  const draft = useDraft();
  const field = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground pointer-coarse:h-11";
  return (
    <section aria-label="New comment" className={cn("overflow-hidden rounded-lg bg-card", notSubmitted("yours"))}>
      <p className="flex items-center gap-1.5 px-3 pt-2 text-xs font-medium text-muted-foreground"><Icon name="CircleDashed" className="size-3.5 text-primary" aria-hidden />{draft.asking ? "Message to the agent" : "New comment · not submitted"}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_76px_104px] gap-2 px-2.5 pt-2">
        <label className="space-y-1 text-xs text-muted-foreground">File<select aria-label="Comment file" disabled={draft.busy || !!draft.editing} className={field} value={draft.file} onChange={(event) => draft.setFile(event.target.value)}>
          {(draft.file && !draft.files.includes(draft.file) ? [draft.file, ...draft.files] : draft.files).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select></label>
        {draft.startLine ? <p className="space-y-1 text-xs text-muted-foreground">Lines<span className="flex h-9 items-center text-sm text-foreground tabular-nums">{draft.boxLines}</span></p>
          : <label className="space-y-1 text-xs text-muted-foreground">Line<Input aria-label="Comment line" disabled={draft.busy || !!draft.editing} type="number" min={1} value={draft.line} className="pointer-coarse:h-11" onChange={(event) => draft.setLine(event.target.value)} /></label>}
        <label className="space-y-1 text-xs text-muted-foreground">Side<select aria-label="Comment side" disabled={draft.busy || !!draft.editing} className={field} value={draft.side} onChange={(event) => draft.setSide(event.target.value as "LEFT" | "RIGHT")}><option value="RIGHT">New line</option><option value="LEFT">Old line</option></select></label>
      </div>
      <ComposerFields mode={draft.asking ? "ask" : "new"} busy={draft.busy} composer={composer} controlsRef={draft.composerControls} />
    </section>
  );
}

function Notice({ tone, action, children }: { tone: "danger" | "warning"; action?: ReactNode; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm", tone === "danger" ? "border-destructive/20 bg-destructive/10 text-destructive-text" : "border-warning/20 bg-warning/10 text-warning-text")}>
      <Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

function Empty({ text, onAll }: { text: string; onAll?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border"><Icon name="MessageSquare" className="size-5" /></span>
      <p className="text-sm text-muted-foreground">{text}</p>
      {onAll && <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={onAll}>Show all</Button>}
    </div>
  );
}
