// A review's comments, for the cards in the code and the Comments list, which show at once: one copy of what GitHub
// and your feedback say (useDiffThreads reads it), the items the list builds from it and the draft, and what the list
// shows. Module state keyed by review, since the cards sit inside the diff, apart from the list's tree.
import { useMemo, useSyncExternalStore } from "react";
import type { ReviewThread } from "../../src/threads";
import type { FeedbackView, ReplyDraft } from "../../lib/feedback";
import { fileCounts, type CommentFilter, type CommentItem } from "../../lib/comments";

/** What changes the review's threads on GitHub and their drafted replies; each reads them again after. */
export interface CommentActions {
  /** Post a reply now; false when it didn't go, keeping it. */
  reply(threadId: string, body: string): Promise<boolean>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  /** Keep a reply as the thread's draft on the server; empty text drops it. */
  saveReplyDraft(threadId: string, body: string): void;
  discardReplyDraft(threadId: string): Promise<void>;
  /** Read your threads from GitHub again, and everyone's. */
  refresh(): Promise<void>;
  /** Ask the agent to check your feedback against the PR again. */
  checkAgain(): Promise<void>;
}

export interface CommentsEntry {
  /** Everyone's threads, as getReviewThreads last read them, in reading order. */
  threads: ReviewThread[];
  /** Why GitHub's threads couldn't be read, or all of them: shown in the list, which still shows what it has. */
  threadsError: string | null;
  feedback: FeedbackView | null;
  feedbackError: boolean;
  replyDrafts: Array<ReplyDraft & { threadId: string }> | null;
  /** Every source has answered once. */
  loaded: boolean;
  /** The thread a reply or resolve is being sent on. */
  busy: string | null;
  /** Reading GitHub again, or starting the agent's check. */
  refreshing: boolean;
  checking: boolean;
  actions: CommentActions | null;
  /** Every item, as the list builds them; the cards in the code read theirs. */
  items: CommentItem[];
  /** Comments in the code show as one-line pills. */
  folded: boolean;
  /** The list's chip, which ] and [ follow too. */
  filter: CommentFilter;
  /** The row the list shows as its full card. */
  expanded: string | null;
}

const EMPTY: CommentsEntry = {
  threads: [], threadsError: null, feedback: null, feedbackError: false, replyDrafts: null, loaded: false, busy: null,
  refreshing: false, checking: false, actions: null, items: [], folded: false, filter: "all", expanded: null,
};

const entries = new Map<string, CommentsEntry>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function commentsOf(targetKey: string): CommentsEntry {
  return entries.get(targetKey) ?? EMPTY;
}

/** Change what's kept for a review; unchanged values keep their objects, so nothing redraws for them. */
export function updateComments(targetKey: string, patch: Partial<CommentsEntry>) {
  const current = commentsOf(targetKey);
  if ((Object.keys(patch) as Array<keyof CommentsEntry>).every((key) => current[key] === patch[key])) return;
  entries.set(targetKey, { ...current, ...patch });
  for (const listener of listeners) listener();
}

/** Forget a review's comments, when its workspace goes. */
export function dropComments(targetKey: string) {
  if (!entries.delete(targetKey)) return;
  for (const listener of listeners) listener();
}

/** One of a review's kept values, re-rendering only when it changes. Without a review, the empty one's. */
export function useComments<K extends keyof CommentsEntry>(targetKey: string | null | undefined, key: K): CommentsEntry[K] {
  return useSyncExternalStore(subscribe, () => (targetKey ? commentsOf(targetKey) : EMPTY)[key]);
}

/** Each file's ▤ n, for its header in the diff: its draft comments, and its threads on GitHub that aren't resolved. */
export function useFileCounts(targetKey: string | null | undefined): Map<string, { notSubmitted: number; onGitHub: number }> {
  const items = useComments(targetKey, "items");
  return useMemo(() => fileCounts(items), [items]);
}
