// What a review is called: the name you gave it with Rename… in its menu, else its PR's title, or a local review's ref.
// Your name stays in BB: GitHub, and the agents, keep the PR's title.
import type { ReviewMeta } from "../src/store";

type Named = Pick<ReviewMeta, "targetKey"> & Partial<Pick<ReviewMeta, "name" | "title" | "gitRef">>;

/** The longest name a review takes, as long as a guide's title. */
export const NAME_LIMIT = 120;

/** What the review is called without a name of yours: its PR's title, or a local review's ref. */
export function defaultName(review: Named): string {
  return review.title ?? review.gitRef ?? review.targetKey;
}

/** What the review is called in your lists: the name you gave it, else its PR's title or ref. */
export function reviewName(review: Named): string {
  return review.name ?? defaultName(review);
}

/** The PR's title, or a local review's ref, while you call the review something else; null otherwise. */
export function renamedFrom(review: Named): string | null {
  return review.name && review.name !== defaultName(review) ? defaultName(review) : null;
}
