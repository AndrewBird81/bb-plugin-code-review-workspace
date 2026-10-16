// The reviewer's asks on the review summary or a draft comment. An ask opens what the reviewer wrote
// there to the assistant's turn that carries it, on that conversation, and only that turn. Dig deeper on
// a chapter is an ask too, whose turn's end ends it, though it opens nothing.
import type { Ask, ReviewMeta, Store } from "./store";
import { isSummary, sameLocation, SUMMARY_AT, type CommentLocation } from "./draft";

/** An ask whose turn's end bb never reported gives way after this. */
export const ASK_LIFETIME = 30 * 60_000;

/** Dig deeper's ask, on the chapter `deepDive`: one at a time per review. */
export type DeepDiveAt = { deepDive: string };
/** Where an ask is: the summary, a draft comment's line, or a chapter Dig deeper is on. */
export type AskAt = CommentLocation | DeepDiveAt;
const isDeepDive = (at: AskAt): at is DeepDiveAt => "deepDive" in at;

export function askAt(review: ReviewMeta | null, at: AskAt): Ask | null {
  if (isDeepDive(at)) return review?.deepDive?.chapterId === at.deepDive ? review.deepDive.ask : null;
  if (isSummary(at)) return review?.summaryAsk ?? null;
  return review?.commentAsks?.find((entry) => sameLocation(entry, at))?.ask ?? null;
}

/** Record or (with null) withdraw the ask at a location. */
export function setAsk(store: Store, targetKey: string, at: AskAt, ask: Ask | null) {
  if (isDeepDive(at)) {
    // Withdrawing one chapter's leaves another's be.
    if (!ask && store.getReview(targetKey)?.deepDive?.chapterId !== at.deepDive) return;
    return store.setLifecycle(targetKey, { deepDive: ask && { chapterId: at.deepDive, ask } });
  }
  if (isSummary(at)) return store.setLifecycle(targetKey, { summaryAsk: ask });
  const others = (store.getReview(targetKey)?.commentAsks ?? []).filter((entry) => !sameLocation(entry, at));
  store.setLifecycle(targetKey, { commentAsks: ask ? [...others, { file: at.file, line: at.line, side: at.side, ask }] : others });
}

export function listAsks(review: ReviewMeta): Array<{ at: AskAt; ask: Ask }> {
  return [
    ...(review.summaryAsk ? [{ at: SUMMARY_AT, ask: review.summaryAsk }] : []),
    ...(review.commentAsks ?? []).map(({ ask, ...at }) => ({ at, ask })),
    ...(review.deepDive ? [{ at: { deepDive: review.deepDive.chapterId }, ask: review.deepDive.ask }] : []),
  ];
}

export function clearAsks(store: Store, targetKey: string) {
  store.setLifecycle(targetKey, { summaryAsk: null, commentAsks: [], deepDive: null });
}

/** Whether the turn running on `threadId` carries the reviewer's ask at this location. */
export function asked(store: Store, targetKey: string, at: AskAt, threadId?: string): boolean {
  const ask = askAt(store.getReview(targetKey), at);
  return !!threadId && ask?.state === "running" && ask.threadId === threadId && Date.now() - ask.at < ASK_LIFETIME;
}
