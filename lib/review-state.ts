import type { ReviewMeta } from "../src/store";
import { baselineOf, computeTurn, type Turn, type TurnReason, type feedbackProgress } from "./turn";
import type { StackPlace } from "./stacks";
/** A review as the server returns it, with its `turn`, `progress`, and `stack` attached. */
export type ReviewItem = Pick<ReviewMeta, "targetKey"> & Partial<ReviewMeta> & { turn?: Turn; progress?: ReturnType<typeof feedbackProgress>; stack?: StackPlace | null };
/** A guide's error when the reviewer stopped it before it was written (src/generate.ts stopGuide). */
export const GUIDE_STOPPED = "Stopped";

/** The server's turn when it sent one; otherwise computed with the default options. */
export function reviewState(review: ReviewItem): Turn {
  return review.turn ?? computeTurn(review);
}

/** Needs review's parts: reviews you gave that came back to you, first reviews, and requests to a team you're on. */
export type NeedsGroup = "back" | "new" | "team";
const BACK_TO_YOU = new Set<TurnReason>(["re-requested", "question", "mentioned", "handled", "looks-ready", "dismissed"]);
const NEEDS_RANK: Record<NeedsGroup, number> = { back: 0, new: 1, team: 2 };

/** Which part of Needs review the review is in. A failed guide keeps the reason underneath, so a review you gave is back. */
export function needsGroup(review: ReviewItem): NeedsGroup {
  const { reason } = reviewState(review);
  if (reason === "team-requested") return "team";
  return BACK_TO_YOU.has(reason) || baselineOf(review).at !== null ? "back" : "new";
}

/** Needs review: Blocks merge first, then Back to you, New and Team requests, each longest waiting first. */
export function needsOrder(a: ReviewItem, b: ReviewItem): number {
  const ta = reviewState(a), tb = reviewState(b);
  return Number(tb.blocking) - Number(ta.blocking)
    || NEEDS_RANK[needsGroup(a)] - NEEDS_RANK[needsGroup(b)]
    || (ta.at ?? a.createdAt ?? 0) - (tb.at ?? b.createdAt ?? 0);
}
