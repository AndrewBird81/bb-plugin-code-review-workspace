import type { ReviewMeta } from "../src/store";
import { computeTurn, type Turn, type feedbackProgress } from "./turn";
import type { StackPlace } from "./stacks";
/** A review as the server returns it, with its `turn`, `progress`, and `stack` attached. */
export type ReviewItem = Pick<ReviewMeta, "targetKey"> & Partial<ReviewMeta> & { turn?: Turn; progress?: ReturnType<typeof feedbackProgress>; stack?: StackPlace | null };
/** The server's turn when it sent one; otherwise computed with the default options. */
export function reviewState(review: ReviewItem): Turn {
  return review.turn ?? computeTurn(review);
}
/** Needs review: blocking first, then direct requests before team requests, then longest waiting. */
export function needsOrder(a: ReviewItem, b: ReviewItem): number {
  const ta = reviewState(a), tb = reviewState(b);
  return Number(tb.blocking) - Number(ta.blocking)
    || Number(ta.reason === "team-requested") - Number(tb.reason === "team-requested")
    || (ta.at ?? a.createdAt ?? 0) - (tb.at ?? b.createdAt ?? 0);
}
