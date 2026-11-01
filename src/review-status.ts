// reviews.v1.status (src/public-contract.ts): where each review stands, for other plugins, from the turn All reviews,
// the alerts and bb review list say (lib/review-status.ts), with what places it: its PR, branch, folder and threads. It
// reads no diff or guide. When each came to stand as it does is kept on the review (`standing`), here and on the
// sync's pass over every review (src/review-lifecycle.ts).
import type { ReviewMeta } from "./store";
import type { AsyncStore } from "./store-queue";
import type { PublicHandlers, ServeDeps } from "./server-modules";
import type { Turn } from "../lib/turn";
import { sinceOf, standingKey, standingOf, type Since } from "../lib/review-status";
import { reviewIdentity } from "../lib/review-identity";
import { parsePrLink } from "../lib/pr-link";
import { placeFacts, reviewPlaces } from "./review-places";
import { mergedSurvivor } from "./targets";
import { ownPrOf, ownPrUnread, turnOptions } from "./turn-signals";
import { REVIEW_STATUS } from "./public-contract";

/** When `review` came to stand as `turn` says, as it's to be kept, and whether that's other than what's kept. */
function sinceFor(review: ReviewMeta, turn: Turn, now: number): { since: Since; changed: boolean } {
  const since = sinceOf(review.standing, standingKey(standingOf(review, turn)), turn.at, now);
  return { since, changed: since.key !== review.standing?.key || since.at !== review.standing?.at };
}

/** Keep, in the caller's block, when the review came to stand as its turn says, once that's changed. */
export async function noteStanding(tx: AsyncStore, review: ReviewMeta, turn: Turn, now: number): Promise<void> {
  const { since, changed } = sinceFor(review, turn, now);
  if (changed) await tx.setLifecycle(review.targetKey, { standing: since });
}

/** The threads the review is linked to: its main thread, the ones before it, its Sends' threads, and the thread bb review ran in. */
function linkedThreads(review: ReviewMeta): string[] {
  const ids = [review.mainThread?.threadId, ...(review.implementers ?? []).map((thread) => thread.threadId), ...(review.sends ?? []).map((send) => send.threadId), review.sourceThreadId];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

export function register(deps: ServeDeps) {
  const { bb, store, sync } = deps;
  const published = {
    async [REVIEW_STATUS]() {
      const now = Date.now();
      const { all, options } = await store.exclusive(async (tx) => ({ all: await tx.listReviews(), options: turnOptions((await tx.getPreferences()).preferences) }));
      // As the list reads them: the sync's cached login says whose a PR it hasn't read yet is.
      const login = all.some(ownPrUnread) ? sync.cachedLogin() : null;
      const reviews = all.map((review) => ownPrOf(review, login));
      const places = reviewPlaces(await placeFacts(bb, reviews), reviews);
      const noted: Array<{ review: ReviewMeta; since: Since }> = [];
      const rows = await Promise.all(reviews.map(async (review) => {
        const turn = await sync.turnOf(review, now, options);
        const standing = standingOf(review, turn);
        const { since, changed } = sinceFor(review, turn, now);
        if (changed) noted.push({ review, since });
        const repo = review.kind === "pr" ? review.repo ?? (review.url ? parsePrLink(review.url)?.repo : undefined) : undefined;
        const survivor = review.mergedInto ? mergedSurvivor(review, reviews) : null;
        const folder = review.feature && !review.feature.folderGone ? { environmentId: review.feature.environmentId } : null;
        return {
          targetKey: review.targetKey,
          id: reviewIdentity({ ...review, place: places.get(review.targetKey) }).id,
          createdAt: review.createdAt,
          pr: repo && review.number && review.url ? { repo, number: review.number, url: review.url, author: review.author ?? review.signals?.author ?? null } : null,
          branch: (review.kind === "pr" ? review.head : review.feature?.branch) ?? null,
          folder,
          mainThreadId: review.mainThread?.threadId ?? review.sourceThreadId ?? null,
          threadIds: linkedThreads(review),
          waitsOn: standing.waitsOn,
          waitsOnThreadId: standing.thread,
          approved: standing.approved,
          since: since.at,
          label: turn.label,
          archived: standing.archived,
          // The review that stays of its merges; none when the one it went into was deleted since.
          mergedInto: survivor && survivor !== review && !survivor.mergedInto ? survivor.targetKey : null,
        };
      }));
      // Kept unless the review changed meanwhile, as when the sync's pass kept it first.
      if (noted.length) {
        await store.exclusive(async (tx) => {
          for (const { review, since } of noted) {
            const now = await tx.getReview(review.targetKey);
            if (now && JSON.stringify(now.standing ?? null) === JSON.stringify(review.standing ?? null)) await tx.setLifecycle(review.targetKey, { standing: since });
          }
        });
      }
      return { reviews: rows };
    },
  } satisfies Partial<PublicHandlers>;
  return { published };
}
