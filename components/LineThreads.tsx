import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewThread } from "../src/threads";
import { sameLocation, type CommentLocation } from "../src/draft";
import type { FeedbackView, ReplyDraft } from "../lib/feedback";
import type { ThreadItem } from "../lib/comments";
import { setCommentOpen, useCommentOpen, useRevealedComment } from "../lib/comments-fold";
import { holdReview } from "../lib/review-holds";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { InlineDraftContext } from "./InlineDraft";
import { CommentCard, whereOf } from "./comments/CommentCard";
import { CommentPill } from "./comments/CommentPill";
import { frameOf, itemWords, ReplyDraftBadge } from "./comments/look";
import { commentsOf, dropComments, updateComments, useComments, type CommentActions } from "./comments/store";

/** The PR's review threads on GitHub, everyone's, as the diff shows them. The workspace provides it while they're shown. */
export interface DiffThreads {
  targetKey: string;
  /** In reading order: by file, then line. */
  threads: ReviewThread[];
}
export const DiffThreadsContext = createContext<DiffThreads | null>(null);

/** A thread's line in the diff, unless GitHub says the code it was on has changed. */
export function threadLocation(thread: ReviewThread): CommentLocation | null {
  return thread.path && thread.line != null && !thread.isOutdated ? { file: thread.path, line: thread.line, side: thread.side } : null;
}

// The order they read in, so each line's cards come in the page's order to a keyboard too.
const byPlace = (a: ReviewThread, b: ReviewThread) => (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const REPLY_KEY = (targetKey: string) => `gr:thread-reply:${targetKey}:`;
const forgetTabReply = (targetKey: string, threadId: string) => {
  try { sessionStorage.removeItem(REPLY_KEY(targetKey) + threadId); } catch { /* best effort */ }
};

/**
 * The review's threads on GitHub, your feedback on them and their drafted replies: read once here for the code's
 * cards and the Comments list together, so a reply or resolve in either shows in both. Read again whenever `enabled`
 * turns on, when the server says they changed, and after each change made here.
 */
export function useDiffThreads(targetKey: string, enabled: boolean, account?: string): DiffThreads & { loadAll: () => Promise<unknown> } {
  const rpc = useRpc<typeof rpcContract>();
  // The GitHub account the page verified, which replies and resolves post as.
  const accountRef = useRef(account);
  accountRef.current = account;
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const requests = useRef({ threads: 0, feedback: 0, drafts: 0 });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const done = useRef({ threads: false, feedback: false, drafts: false });
  const answered = (source: keyof typeof done.current) => {
    done.current[source] = true;
    if (done.current.threads && done.current.feedback && done.current.drafts) updateComments(targetKey, { loaded: true });
  };

  const loadThreads = useCallback(async () => {
    const id = ++requests.current.threads;
    try {
      const result = await rpc.call("getReviewThreads", { targetKey });
      if (id !== requests.current.threads) return;
      const next = [...(result.threads as ReviewThread[])].sort(byPlace);
      setThreads((current) => same(current, next) ? current : next);
      updateComments(targetKey, { threads: same(commentsOf(targetKey).threads, next) ? commentsOf(targetKey).threads : next, threadsError: result.error ?? null });
    } catch (error) {
      if (id === requests.current.threads) updateComments(targetKey, { threadsError: error instanceof Error ? error.message : "" });
    } finally {
      if (id === requests.current.threads) answered("threads");
    }
  }, [rpc, targetKey]);
  const showFeedback = useCallback((feedback: FeedbackView) => {
    updateComments(targetKey, { feedback: same(commentsOf(targetKey).feedback, feedback) ? commentsOf(targetKey).feedback : feedback, feedbackError: false });
  }, [targetKey]);
  // Feedback a change here brought back is newer than a read still on its way.
  const showNewer = useCallback((feedback: FeedbackView) => {
    requests.current.feedback++;
    answered("feedback");
    showFeedback(feedback);
  }, [showFeedback]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadFeedback = useCallback(async () => {
    const id = ++requests.current.feedback;
    try {
      const { feedback } = await rpc.call("getFeedback", { targetKey });
      if (id === requests.current.feedback) showFeedback(feedback as FeedbackView);
    } catch {
      if (id === requests.current.feedback) updateComments(targetKey, { feedbackError: true });
    } finally {
      if (id === requests.current.feedback) answered("feedback");
    }
  }, [rpc, targetKey, showFeedback]);
  const loadDrafts = useCallback(async () => {
    const id = ++requests.current.drafts;
    try {
      const { drafts } = await rpc.call("getReplyDrafts", { targetKey });
      if (id !== requests.current.drafts) return;
      // Replies a 0.5 tab was writing in Threads, kept in the tab: to the server once, over the agent's draft but not
      // over one of yours. The tab keeps each until it's saved.
      const prefix = REPLY_KEY(targetKey);
      const kept: Array<[string, string]> = [];
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key?.startsWith(prefix)) kept.push([key.slice(prefix.length), sessionStorage.getItem(key) ?? ""]);
        }
      } catch { /* best effort */ }
      const moved = kept.flatMap(([threadId, body]) => {
        if (!body.trim() || drafts.some((draft) => draft.threadId === threadId && draft.author !== "agent")) {
          forgetTabReply(targetKey, threadId);
          return [];
        }
        rpc.call("saveReplyDraft", { targetKey, threadId, body }).then(({ ok }) => { if (ok) forgetTabReply(targetKey, threadId); }, () => {});
        return [{ threadId, body, author: "reviewer" as const, updatedAt: Date.now() }];
      });
      const next = [...drafts.filter((draft) => !moved.some((reply) => reply.threadId === draft.threadId)), ...moved];
      updateComments(targetKey, { replyDrafts: same(commentsOf(targetKey).replyDrafts, next) ? commentsOf(targetKey).replyDrafts : next });
    } catch {
      // Without them, your threads' drafted replies come with your feedback.
    } finally {
      if (id === requests.current.drafts) answered("drafts");
    }
  }, [rpc, targetKey]);
  const loadAll = useCallback(() => Promise.all([loadThreads(), loadFeedback(), loadDrafts()]), [loadThreads, loadFeedback, loadDrafts]);

  useEffect(() => { if (enabled) void loadAll(); }, [enabled, loadAll]);
  // A new workspace of the review may already show its comments: they go with the last one.
  useEffect(() => holdReview("threads", targetKey, () => dropComments(targetKey)), [targetKey]);
  useEffect(() => () => { done.current = { threads: false, feedback: false, drafts: false }; }, [targetKey]);
  // The sync read your threads again, a reply went out, or the agent checked them or drafted a reply.
  useRealtime(`feedback:${targetKey}`, () => { if (enabledRef.current) void loadAll(); });
  useRealtime(`review:${targetKey}`, () => { if (enabledRef.current) { void loadFeedback(); void loadDrafts(); } });
  // Whether the agent's suggested summary is the draft's.
  useRealtime(`draft:${targetKey}`, () => { if (enabledRef.current) void loadFeedback(); });

  const actions = useMemo((): CommentActions => {
    const mine = (threadId: string) => !!commentsOf(targetKey).feedback?.items.some((item) => item.kind === "thread" && item.id === threadId);
    const setDraft = (threadId: string, draft: ReplyDraft | null) => {
      // What you do with the reply now replaces what a 0.5 tab kept of it.
      forgetTabReply(targetKey, threadId);
      const current = commentsOf(targetKey).replyDrafts ?? [];
      updateComments(targetKey, { replyDrafts: [...current.filter((entry) => entry.threadId !== threadId), ...(draft ? [{ threadId, ...draft }] : [])] });
    };
    /** Whether it went: false when it failed, "already" when GitHub had the reply already, so it wasn't sent again. */
    async function send(threadId: string, request: (account: string) => Promise<{ ok: boolean; error?: string; alreadyPosted?: boolean }>, failed: string): Promise<boolean | "already"> {
      const account = accountRef.current;
      if (!account) {
        toast.error("Your GitHub account isn’t verified yet. Try again in a moment, or reload this review.");
        return false;
      }
      // One at a time on a thread; a reply on another thread waits for neither.
      if (commentsOf(targetKey).busy.includes(threadId)) return false;
      updateComments(targetKey, { busy: [...commentsOf(targetKey).busy, threadId] });
      try {
        const result = await request(account);
        if (!result.ok) toast.error(result.error ?? failed);
        else if (result.alreadyPosted) toast.info("GitHub already has this reply, so it wasn’t sent again. Change it to send another.");
        return result.ok && result.alreadyPosted ? "already" : result.ok;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : failed);
        return false;
      } finally {
        updateComments(targetKey, { busy: commentsOf(targetKey).busy.filter((id) => id !== threadId) });
      }
    }
    return {
      async reply(threadId, body) {
        const failed = "Couldn’t post the reply. It’s still here.";
        const sent = mine(threadId)
          // Your own threads: the server reads them again, so the thread waits on its author at once.
          ? await send(threadId, async (account) => {
            const result = await rpc.call("replyToFeedback", { targetKey, threadId, body, account });
            if (result.ok && result.feedback) showNewer(result.feedback as FeedbackView);
            return result;
          }, failed)
          : await send(threadId, (account) => {
            const inReplyTo = commentsOf(targetKey).threads.find((thread) => thread.id === threadId)?.comments[0]?.databaseId;
            return inReplyTo == null ? Promise.resolve({ ok: false }) : rpc.call("replyToThread", { targetKey, inReplyTo, body, threadId, account });
          }, failed);
        // One GitHub had already keeps its text here, to change and send.
        if (sent === true) {
          setDraft(threadId, null);
          await loadThreads();
        }
        return sent === true;
      },
      async setResolved(threadId, resolved) {
        const ok = await send(threadId, (account) => rpc.call(resolved ? "resolveThread" : "unresolveThread", { targetKey, threadId, account }), "Couldn’t update the thread.");
        if (!ok) return;
        await Promise.all([loadThreads(), mine(threadId) ? rpc.call("refreshFeedback", { targetKey }).then(({ feedback }) => showNewer(feedback as FeedbackView)).catch(() => {}) : null]);
      },
      saveReplyDraft(threadId, body) {
        setDraft(threadId, body.trim() ? { body, author: "reviewer", updatedAt: Date.now() } : null);
        void rpc.call("saveReplyDraft", { targetKey, threadId, body }).catch(() => toast.error("Couldn’t save your reply draft."));
      },
      async discardReplyDraft(threadId) {
        setDraft(threadId, null);
        await rpc.call("discardReplyDraft", { targetKey, threadId }).catch(() => {});
      },
      async refresh() {
        updateComments(targetKey, { refreshing: true });
        try {
          const [{ feedback }] = await Promise.all([rpc.call("refreshFeedback", { targetKey }), loadThreads(), loadDrafts()]);
          showNewer(feedback as FeedbackView);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn’t read GitHub.");
        } finally {
          updateComments(targetKey, { refreshing: false });
        }
      },
      async checkAgain() {
        updateComments(targetKey, { checking: true });
        try {
          const result = await rpc.call("checkFeedback", { targetKey });
          if (result.ok) toast.success("Checking your feedback against the PR.");
          else toast.error(result.error ?? "Couldn’t start the check.");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn’t start the check.");
        } finally {
          updateComments(targetKey, { checking: false });
        }
      },
    };
  }, [rpc, targetKey, loadThreads, loadDrafts, showNewer]);
  useEffect(() => { updateComments(targetKey, { actions }); }, [targetKey, actions]);

  return useMemo(() => ({ targetKey, threads, loadAll }), [targetKey, threads, loadAll]);
}

/** Outlines a card a moment, once it's what you went to. */
function useFlash(targetKey: string, id: string) {
  const revealed = useRevealedComment(targetKey);
  const ref = useRef<HTMLDivElement>(null);
  const flashed = useRef(0);
  useEffect(() => {
    if (!revealed || revealed.id !== id || revealed.nonce === flashed.current) return;
    flashed.current = revealed.nonce;
    ref.current?.firstElementChild?.animate?.([{ outline: "2px solid var(--primary)", outlineOffset: "1px" }, { outline: "2px solid transparent", outlineOffset: "1px" }], { duration: 1600, easing: "ease-in" });
  }, [revealed, id]);
  return ref;
}

/** One GitHub thread in the code: its card, or with comments folded, or once resolved, its pill. */
function ThreadInCode({ targetKey, item, className }: { targetKey: string; item: ThreadItem; className?: string }) {
  const folded = useComments(targetKey, "folded");
  const opened = useCommentOpen(targetKey, item.id);
  const ref = useFlash(targetKey, item.id);
  const replies = item.messages.length - 1;
  if ((folded || item.state === "resolved") && !opened) {
    return <div ref={ref} data-comment-id={item.id}>
      <CommentPill frame={frameOf(item)} icon={<Icon name="Github" className="size-3.5 shrink-0" aria-hidden />} who={item.who} words={itemWords(item)} text={item.messages[0]?.body ?? ""}
        badge={item.replyDraft && <ReplyDraftBadge reply={item.replyDraft} />} briefBadge={item.replyDraft && <ReplyDraftBadge reply={item.replyDraft} brief />}
        more={[replies > 0 ? `${replies} repl${replies === 1 ? "y" : "ies"}` : null, item.check ? `✦ ${item.check.label}` : null].filter(Boolean).join(" · ") || null}
        name={`GitHub thread on ${whereOf(item)}`} onShow={() => setCommentOpen(targetKey, item.id, true)} className={className} />
    </div>;
  }
  return <div ref={ref} data-comment-id={item.id} className={cn("rounded-lg", className)}><CommentCard targetKey={targetKey} item={item} variant="inline" /></div>;
}

/** The threads in the list's items, by id, for the cards in the code. */
function useThreadItems(targetKey: string | undefined): Map<string, ThreadItem> {
  const items = useComments(targetKey, "items");
  return useMemo(() => new Map(items.flatMap((item) => item.kind === "thread" ? [[item.id, item] as const] : [])), [items]);
}

/** The GitHub threads on a line of the diff, above its draft comment. */
export const LineThreads = memo(function LineThreads({ at }: { at: CommentLocation }) {
  const github = useContext(DiffThreadsContext);
  const byId = useThreadItems(github?.targetKey);
  if (!github) return null;
  const here = github.threads.filter((thread) => { const on = threadLocation(thread); return on && sameLocation(on, at); });
  return <>{here.map((thread) => {
    const item = byId.get(thread.id);
    return item ? <ThreadInCode key={thread.id} targetKey={github.targetKey} item={item} /> : null;
  })}</>;
});
LineThreads.displayName = "LineThreads";

/**
 * A file's threads with no line in this diff: on code that changed since (Outdated), or on the whole file (File
 * comments). Folded until asked for, or until one of them is what you went to.
 */
export function OutdatedThreads({ threads }: { threads: ReviewThread[] }) {
  const github = useContext(DiffThreadsContext);
  const draft = useContext(InlineDraftContext);
  const targetKey = github?.targetKey ?? draft?.targetKey;
  const byId = useThreadItems(targetKey);
  const revealed = useRevealedComment(targetKey);
  const [open, setOpen] = useState(false);
  const shown = threads.some((thread) => thread.id === revealed?.id);
  useEffect(() => { if (shown) setOpen(true); }, [shown, revealed?.nonce]);
  if (!github || !targetKey || !threads.length) return null;
  const files = threads.filter((thread) => thread.subjectType === "FILE").length;
  const label = [threads.length - files ? `Outdated (${threads.length - files})` : null, files ? `File comments (${files})` : null].filter(Boolean).join(" · ");
  return (
    <div className="border-b border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-8 w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground pointer-coarse:min-h-11">
        <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
        {label}
      </button>
      {open && threads.map((thread) => {
        const item = byId.get(thread.id);
        return item ? <ThreadInCode key={thread.id} targetKey={targetKey} item={item} /> : null;
      })}
    </div>
  );
}
