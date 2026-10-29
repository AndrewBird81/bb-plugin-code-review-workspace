// What BB's thread pages show of the reviews (app.tsx): Review changes in the row above a thread's message box, beside
// BB's own Changed files, and the Review tab beside a thread linked to a review: its id and name, its comments with where
// each stands, the review agent's chat, and Open review.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { experimental_Icon as HostIcon, experimental_usePluginId, ThreadChat, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadContextSegmentInput, ExperimentalThreadContextSegmentProps, ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { CommentLocation, Discussion, Draft } from "../src/draft";
import { buildItems } from "../lib/comments";
import { useReviewLinks } from "../lib/review-links";
import type { ReviewItem } from "../lib/review-state";
import { patchReviewState } from "../lib/panel-state";
import { SettingsProvider } from "../lib/settings";
import { folderReview, threadReviewLink, useFolderStatus, useThreadLinks } from "../lib/thread-links";
import { cn } from "../lib/utils";
import { CommentRow } from "./comments/CommentRow";
import { ReviewTitle } from "./ReviewIdChip";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

const comments = (n: number) => `${n} comment${n === 1 ? "" : "s"}`;

/** A review as a thread page shows it, and how many of its comments are open; null until read, and once it's gone. */
function useThreadReview(targetKey: string): { review: ReviewItem; open: number } | null {
  const rpc = useRpc<typeof rpcContract>();
  const [read, setRead] = useState<{ targetKey: string; review: ReviewItem; open: number } | null>(null);
  const load = useCallback(() => {
    rpc.call("threadReview", { targetKey }).then(({ review, open }) => setRead(review ? { targetKey, review: review as ReviewItem, open } : null), () => {});
  }, [rpc, targetKey]);
  useEffect(load, [load]);
  useRealtime(`draft:${targetKey}`, load);
  useRealtime(`review:${targetKey}`, load);
  return read && read.targetKey === targetKey ? read : null;
}

/**
 * Review changes shows for a thread with a folder, while Settings has it on, and the folder has changes or a review;
 * never on the plugin's own agents' and guide writers' pages.
 */
export function useReviewChangesVisible({ threadId, environment }: ExperimentalThreadContextSegmentInput): boolean {
  const links = useThreadLinks();
  const on = !!links?.reviewChangesLine && environment !== null && !links.agents.includes(threadId);
  const folder = useFolderStatus(on ? environment.id : null);
  return on && (!!folder?.changes || !!folderReview(links, environment.id, folder?.branch));
}

const SEGMENT = "flex min-h-6 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The segment's button: the review's icon, or a spinner while it acts, and its words. */
function SegmentButton({ label, name, title, busy, onClick }: { label: string; name?: string; title: string; busy: boolean; onClick: () => void }) {
  const pluginId = experimental_usePluginId();
  return (
    // Its words lead its name, for voice control too; the tooltip says what it does.
    <button type="button" onClick={onClick} aria-busy={busy || undefined} aria-label={name} title={title} className={SEGMENT}>
      {busy ? <Icon name="Loading" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        : <HostIcon name={`${pluginId}/review`} fallback="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** The folder's review, by how many of its comments are open: "Review · 2 open", or "Review" with none. */
function OpenReviewButton({ targetKey, busy, onClick }: { targetKey: string; busy: boolean; onClick: () => void }) {
  const open = useThreadReview(targetKey)?.open;
  return <SegmentButton label={open ? `Review · ${open} open` : "Review"} name={open === undefined ? undefined : open ? `Review, ${comments(open)} open` : "Review, no comments open"}
    title="Open this folder’s review" busy={busy} onClick={onClick} />;
}

/**
 * Review changes: "Review changes" while the folder has no review at its branch, "Review · 2 open" once it has. Either
 * does what bb review with no arguments does in the thread: starts the review, or opens it as it is, a live thread
 * there taking over from an archived main thread. No file count: Changed files beside it has one.
 */
export function ReviewChangesSegment({ threadId, environment }: ExperimentalThreadContextSegmentProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const links = useThreadLinks();
  const folder = useFolderStatus(environment?.id ?? null);
  const link = links && environment ? folderReview(links, environment.id, folder?.branch) : null;
  const [busy, setBusy] = useState(false);
  const show = (targetKey: string) => navigate.toPluginPanel("review", { subPath: targetKey });
  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const started = await rpc.call("reviewThreadChanges", { threadId });
      if (started.ok && started.targetKey) show(started.targetKey);
      // The folder's review still opens as it is, as when its machine is offline.
      else if (link) show(link.targetKey);
      else toast.error(started.error ?? "Couldn’t start the review. Try again.");
    } catch {
      if (link) show(link.targetKey);
      else toast.error("Couldn’t reach Code Review Workspace to start the review. Try again.");
    } finally { setBusy(false); }
  }
  if (link) return <OpenReviewButton targetKey={link.targetKey} busy={busy} onClick={() => void go()} />;
  return <SegmentButton label={busy ? "Starting review…" : "Review changes"} title="Review this folder’s changes" busy={busy} onClick={() => void go()} />;
}

/** The Review tab shows beside a thread linked to a review: its main thread, a fixer it sent to, or a thread in its folder. */
export function useReviewTabVisible({ threadId, environment }: ExperimentalThreadTabProps): boolean {
  const links = useThreadLinks();
  return !!links && !links.agents.includes(threadId) && !!threadReviewLink(links, threadId, environment?.id ?? null);
}

function Notice({ children }: { children: string }) {
  return <p role="status" className="m-3 rounded-lg border border-border bg-muted/25 p-3 text-sm text-muted-foreground">{children}</p>;
}

/** The Review tab: which review, from what links it to this thread. */
export function ReviewTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const links = useThreadLinks();
  const link = links && threadReviewLink(links, threadId, environment?.id ?? null);
  if (!links) return <Notice>Loading the review…</Notice>;
  if (!link) return <Notice>This thread’s review is gone. Use Review changes below to start a new one.</Notice>;
  return <SettingsProvider><ReviewPane key={link.targetKey} targetKey={link.targetKey} /></SettingsProvider>;
}

const PART = "text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground";

/**
 * The review in a thread's tab: its id and name with Open review; its comments, each with where it stands (Open, Sent
 * to the main thread, Done, Resolved…), which open the review; and the review agent's chat, BB's own.
 */
function ReviewPane({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const read = useThreadReview(targetKey);
  const { status } = useReviewLinks(read?.review ?? null);
  const [draft, setDraft] = useState<{ draft: Draft; stale: CommentLocation[]; discussions?: Discussion[] } | null>(null);
  const loadDraft = useCallback(() => { rpc.call("getDraft", { targetKey }).then((next) => setDraft(next as typeof draft), () => {}); }, [rpc, targetKey]);
  useEffect(loadDraft, [loadDraft]);
  useRealtime(`draft:${targetKey}`, loadDraft);
  // The review agent's thread, null before it's started, "failed" when it couldn't be read; undefined until read.
  const [agent, setAgent] = useState<string | null | "failed" | undefined>(undefined);
  const loadAgent = useCallback(() => { rpc.call("getConversation", { targetKey }).then(({ threadId }) => setAgent(threadId), () => setAgent((was) => was ?? "failed")); }, [rpc, targetKey]);
  useEffect(loadAgent, [loadAgent]);
  useRealtime(`conversation:${targetKey}`, loadAgent);
  const items = useMemo(() => buildItems({ draft, threads: [], feedback: null, sections: [], patch: "", status }).filter((item) => item.kind === "draft"), [draft, status]);
  const open = () => navigate.toPluginPanel("review", { subPath: targetKey });
  // The review opens with its agent's panel, as a docked panel opens where it was left; its first message chooses the agent.
  const ask = () => { patchReviewState(targetKey, { panel: "agent" }); open(); };
  // Two panes can show the same review.
  const commentsId = useId();
  return (
    <section aria-label="Review" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-border py-2 pl-3 pr-1.5">
        <h2 className="flex min-w-0 flex-1 items-start gap-1.5 pt-1 text-sm font-medium">{read ? <ReviewTitle review={read.review} /> : "Review"}</h2>
        <Button variant="ghost" size="sm" className={cn("h-7 shrink-0 px-2 text-xs text-muted-foreground", TOUCH_CONTROL)} onClick={open}>Open review<Icon name="ArrowUpRight" className="size-3.5" aria-hidden /></Button>
      </div>
      <section aria-labelledby={commentsId} className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-b border-border px-3 py-2.5">
        <h3 id={commentsId} className={PART}>Comments{!!read?.open && <span className="font-normal normal-case tracking-normal"> · {read.open} open</span>}</h3>
        {!draft ? <p role="status" className="text-sm text-muted-foreground">Loading the comments…</p>
          : items.length ? <ul className="space-y-1.5">{items.map((item) => <CommentRow key={item.id} targetKey={targetKey} item={item} expanded={false} current={false} onShow={open} showTitle="Open it in the review" />)}</ul>
          : <p className="text-sm text-muted-foreground">No comments yet. Open the review to read the code and comment.</p>}
      </section>
      <section aria-label="Review agent" className="flex min-h-0 flex-1 flex-col">
        <h3 className={cn(PART, "flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-2.5")}><Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />Review agent</h3>
        {agent === undefined ? <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Loading the review agent…</p>
          : agent === "failed" ? <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm text-muted-foreground">Couldn’t load the review agent’s chat.<Button variant="ghost" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_CONTROL)} onClick={() => { setAgent(undefined); loadAgent(); }}>Try again</Button></div>
          : agent === null ? <div className="space-y-2 px-3 py-2">
            <p className="text-sm text-muted-foreground">No questions yet.</p>
            <Button variant="outline" size="sm" className={cn("text-(--ansi-13)", TOUCH_CONTROL)} onClick={ask}><Icon name="Sparkles" className="size-3.5" aria-hidden />Ask the review agent</Button>
          </div>
          : <ThreadChat key={agent} threadId={agent} variant="compact" layout="contained" className="min-h-0 flex-1" />}
      </section>
    </section>
  );
}
