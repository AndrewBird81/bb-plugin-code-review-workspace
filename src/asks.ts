// The reviewer's asks on the review summary or a draft comment. An ask opens what the reviewer wrote
// there to the assistant's turn that carries it, on that conversation, and only that turn.
import type { Ask, ReviewMeta, Store } from "./store";
import { isSummary, sameLocation, SUMMARY_AT, type CommentLocation } from "./draft";

/** An ask whose turn's end bb never reported gives way after this. */
export const ASK_LIFETIME = 30 * 60_000;

export function askAt(review: ReviewMeta | null, at: CommentLocation): Ask | null {
  if (isSummary(at)) return review?.summaryAsk ?? null;
  return review?.commentAsks?.find((entry) => sameLocation(entry, at))?.ask ?? null;
}

/** Record or (with null) withdraw the ask at a location. */
export function setAsk(store: Store, targetKey: string, at: CommentLocation, ask: Ask | null) {
  if (isSummary(at)) return store.setLifecycle(targetKey, { summaryAsk: ask });
  const others = (store.getReview(targetKey)?.commentAsks ?? []).filter((entry) => !sameLocation(entry, at));
  store.setLifecycle(targetKey, { commentAsks: ask ? [...others, { file: at.file, line: at.line, side: at.side, ask }] : others });
}

export function listAsks(review: ReviewMeta): Array<{ at: CommentLocation; ask: Ask }> {
  return [
    ...(review.summaryAsk ? [{ at: SUMMARY_AT, ask: review.summaryAsk }] : []),
    ...(review.commentAsks ?? []).map(({ ask, ...at }) => ({ at, ask })),
  ];
}

export function clearAsks(store: Store, targetKey: string) {
  store.setLifecycle(targetKey, { summaryAsk: null, commentAsks: [] });
}

/** Whether the turn running on `threadId` carries the reviewer's ask at this location. */
export function asked(store: Store, targetKey: string, at: CommentLocation, threadId?: string): boolean {
  const ask = askAt(store.getReview(targetKey), at);
  return !!threadId && ask?.state === "running" && ask.threadId === threadId && Date.now() - ask.at < ASK_LIFETIME;
}
