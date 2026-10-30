// Two reviews of one PR become one (1.9.0): a folder's review that becomes its branch's PR's, and the review the PR had
// already. The one that goes is merged into the one that stays (store.mergeReview): on its own when the one that goes
// has nothing of yours, else on your click, which the review offers (src/feature-review.ts becomePr). What's left of it
// is archived and points at the one that stays, whose page it opens.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MergeNote, ReviewMeta, Store } from "./store";
import type { AsyncStore } from "./store-queue";
import type { ServeDeps } from "./server-modules";
import { localIdOf } from "../lib/review-identity";
import { retitleAssistant } from "./agent";
import { stopGuide } from "./generate";
import { settleFixes } from "./fix-tally";

type Deps = { bb: BbPluginApi; store: AsyncStore; changed(targetKey: string): void; sync?: Pick<ServeDeps["sync"], "one"> };

/**
 * Whether the review has anything of yours, which merging it away would move: comments, a summary or a chosen verdict,
 * notes or context, Sends or reply drafts, a review you submitted or an approve waiting, your name for it, a pin or a
 * snooze, viewed files, or a conversation with its agent.
 */
export async function hasUserContent(tx: AsyncStore, review: ReviewMeta): Promise<boolean> {
  const k = review.targetKey;
  const draft = await tx.getDraft(k);
  return !!draft.comments.length || !!draft.body.trim() || !!draft.verdictChosen
    || !!(await tx.getReviewerNotes(k)).body.trim() || !!(await tx.getReviewContext(k))?.trim()
    || !!review.sends?.length || !!Object.keys(review.threadSends ?? {}).length || !!(await tx.listReplyDrafts(k)).size
    || !!review.submittedAt || !!review.readyToApprove || !!review.name || !!review.pinnedAt || !!review.snoozedAt || !!review.snoozedUntil
    || !!(await tx.getFileViews(k)).length || !!await tx.getAssistantThread(k) || !!(await tx.listAgentMessages(k)).length;
}

/** What merging the review away would move, as its offer says it. */
export async function movesOf(tx: AsyncStore, review: ReviewMeta): Promise<MergeNote> {
  const draft = await tx.getDraft(review.targetKey);
  return { comments: draft.comments.length, summary: !!draft.body.trim(), sends: review.sends?.length ?? 0 };
}

/** How a review's agent knows the other review: a folder's by its id then, the PR's own as that. */
const known = (review: ReviewMeta) => review.feature ? `the local review ${localIdOf({ ...review, feature: review.feature })}` : "the PR's other review";

/**
 * In the caller's block, `from` merged into `into`: what the review that stays says of it, once it became the PR's in
 * the same step, and what its agent is told, once, of the review it didn't know. Returns whether it merged: not when
 * either was merged already.
 */
export async function mergeIn(tx: Store, from: string, into: string): Promise<boolean> {
  const [source, target] = [(await tx.getReview(from))!, (await tx.getReview(into))!];
  const merged = await tx.mergeReview(from, into);
  if (!merged) return false;
  const { moved, adopted } = merged;
  const review = (await tx.getReview(into))!;
  const note = review.number && review.url && await tx.getAssistantThread(into)
    ? { number: review.number, url: review.url, from: adopted ? "" : review.agentPrNote?.from ?? "", merged: adopted ? known(target) : known(source) } : null;
  await tx.setLifecycle(into, { ...review.became ? { became: { ...review.became, merged: moved } } : {}, ...note ? { agentPrNote: note } : {} });
  // The other's sent comments are out with the thread too.
  await settleFixes(tx, into);
  return true;
}

/** After a merge: the review that stays is read from GitHub, its agent's thread named for it, and both pages told. */
export async function afterMerge(deps: Deps, from: string, into: string): Promise<void> {
  await deps.sync?.one(into, true).catch(() => {});
  await retitleAssistant(deps.bb, deps.store, into).catch(() => {});
  deps.changed(into);
  deps.changed(from);
}

/** Merge `from` into `into` now, a guide still being written for `from` stopped first. Returns whether it merged (mergeIn). */
export async function mergeReviews(deps: Deps, from: string, into: string): Promise<boolean> {
  if ((await deps.store.getReview(from))?.status === "generating") await stopGuide(deps.bb, deps.store, from);
  const merged = await deps.store.exclusive((tx) => mergeIn(tx, from, into));
  if (merged) await afterMerge(deps, from, into);
  return merged;
}
