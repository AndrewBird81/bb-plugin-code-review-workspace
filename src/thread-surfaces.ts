// What BB's thread pages show of the reviews (app.tsx): Review changes above a thread's message box, and the Review tab
// beside a thread linked to a review. Both read the plugin's own records here, and BB's git status of the folder in the
// page, as BB's own Changed files does: never a diff, so a thread page costs no git call of the plugin's.
import { placeFacts, reviewPlaces } from "./review-places";
import { folderBranchOf } from "./feature-review";
import { formerWorkers } from "./former-workers";
import type { ReviewMeta } from "./store";
import type { RpcHandlers, ServeDeps } from "./server-modules";

/** The threads a review is linked to: its main thread, the ones before it, and the threads its Sends went to, fixers among them. */
function linkedThreads(review: ReviewMeta): string[] {
  const ids = [review.mainThread?.threadId, ...(review.implementers ?? []).map((thread) => thread.threadId), ...(review.sends ?? []).map((send) => send.threadId)];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** A comment that's still yours to send or post: not sent, resolved or dismissed (src/draft.ts DraftComment state). */
const isOpen = (comment: { state?: string }) => !comment.state || comment.state === "open";

export function register(deps: ServeDeps) {
  const { bb, store } = deps;
  const handlers = {
    // Every review a thread page could show, by the threads and the folder it's linked to, and the switch for Review
    // changes. Archived ones aren't: Review changes opens one again, as bb review does.
    async threadLinks() {
      const { reviews, knobs, agents } = await store.exclusive(async (tx) => ({
        reviews: await tx.listReviews(), knobs: (await tx.getPreferences()).preferences.knobs,
        agents: [...(await tx.listAssistantThreads()).map((agent) => agent.threadId), ...(await tx.listGenerationWorkers()).map((writer) => writer.workerId)],
      }));
      const links = reviews.filter((review) => !review.archivedAt && !review.userArchivedAt).map((review) => {
        const feature = review.feature && !review.feature.folderGone ? review.feature : null;
        return {
          targetKey: review.targetKey, createdAt: review.createdAt, main: review.mainThread?.threadId ?? null, threads: linkedThreads(review),
          // The branch the review reads in its folder, as reviewThreadChanges finds it (src/feature-review.ts).
          folder: feature ? { environmentId: feature.environmentId, branch: folderBranchOf(feature), paused: !!feature.pausedOn } : null,
        };
      }).filter((link) => link.threads.length || link.folder);
      // The plugin's own agents and guide writers, and those that were, the Suggest instructions worker among them: their
      // pages offer no Review changes.
      return { reviewChangesLine: knobs.reviewChangesLine, reviews: links, agents: [...new Set([...agents, ...await formerWorkers(bb)])] };
    },
    // One review as a thread page shows it: its id and name, what its comments' status lines say of it, and how many
    // comments are open.
    async threadReview({ targetKey }) {
      const read = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        if (!review) return null;
        const guideTitle = review.kind === "ref" && !review.title ? (await tx.getGuide(targetKey))?.title ?? null : null;
        return { review, all: await tx.listReviews(), comments: (await tx.getDraft(targetKey)).comments, guideTitle };
      });
      if (!read) return { review: null, open: 0 };
      const { review: { reviewBodies: _bodies, agentReads: _reads, ...review }, all, comments, guideTitle } = read;
      const place = reviewPlaces(await placeFacts(bb, all), all).get(targetKey) ?? null;
      // JSON drops the literal undefined fields rowToMeta leaves.
      return { review: JSON.parse(JSON.stringify({ ...review, place, guideTitle })), open: comments.filter(isOpen).length };
    },
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
