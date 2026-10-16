// What links a review's comments to the BB thread that made the change: the comments sent to it. The workspace provides
// it, so each card in the code reads it without the whole draft.
import { createContext, useContext } from "react";
import { sameLocation, type CommentLocation } from "../src/draft";
import type { ReviewLifecycle } from "../src/store";

export interface ReviewLinks {
  /** The comments sent to the review's source thread; null when none were, or Send to thread is off. */
  sent: NonNullable<ReviewLifecycle["sent"]> | null;
}

export const ReviewLinksContext = createContext<ReviewLinks>({ sent: null });

/** Where and when the comment at `at` was sent, or null. */
export function useSentTo(at: CommentLocation): { threadId: string; title: string | null; at: number } | null {
  const { sent } = useContext(ReviewLinksContext);
  const comment = sent?.comments.find((entry) => sameLocation(entry, at));
  return sent && comment ? { threadId: sent.threadId, title: sent.title, at: comment.at } : null;
}
