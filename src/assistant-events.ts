// What BB's thread and queue events settle: a turn's end ends the asks, discussions and feedback check that waited for
// it, a queued message leaving the queue starts or withdraws them, and a guide writer that fails fails its guide.
import type { PluginThreadEventHandler } from "@get-bb/plugin-sdk";
import { assistantReview } from "./draft-comments";
import { discussionsWaitingOn, settleDiscussions } from "./discussions";
import { listAsks, setAsk } from "./asks";
import { guideWorkerFailed } from "./generate";
import { noteLeftQueue } from "./verification";
import type { AsyncStore } from "./store-queue";
import type { EventListeners, ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, sync } = deps;
  // A discussion the assistant didn't answer by the end of its turn stops waiting for it.
  const settle = async ({ thread }: { thread: { id: string } }) => {
    // A turn ended; an ask on the summary or a comment ends with the turn that carried it. In one turn of the queue,
    // taken as the event arrives, so a turn after it can't find the ask open, nor an event after it see half of this.
    const { reviewKey, checkQueued, waiting } = await store.exclusive(async (tx) => {
      const reviewKey = await assistantReview(tx, thread.id);
      const asking = reviewKey ? await tx.getReview(reviewKey) : null;
      for (const { at, ask } of asking ? listAsks(asking) : []) if (ask.state === "running" && ask.threadId === thread.id) {
        await setAsk(tx, reviewKey!, at, null);
        // Its chapter stops saying the agent is digging into it.
        if ("deepDive" in at) bb.realtime.publish(`review:${reviewKey}`, { ts: Date.now() });
      }
      return { reviewKey, checkQueued: !!asking?.verifyingMessageId, waiting: await discussionsWaitingOn(tx, thread.id) };
    });
    const targetKey = await settleDiscussions(bb, store, thread.id, waiting);
    if (targetKey) bb.realtime.publish(`draft:${targetKey}`, {});
    const review = reviewKey ? await store.getReview(reviewKey) : null;
    if (!reviewKey || !review) return;
    // A feedback check ends with the assistant's turn; an alert waiting for it can go now. A check still
    // queued behind another message hasn't run yet.
    if (review.verifyingSince && !checkQueued && !(await bb.sdk.threads.queuedMessages.list({ threadId: thread.id }).catch(() => [])).length) {
      await endCheck(store, reviewKey);
      await checkEnded(reviewKey);
    }
  };
  /** A feedback check that ended, recorded through `writer`, the store or the block that found it ended: its review is prepared for its next turn. */
  const endCheck = (writer: AsyncStore, reviewKey: string) => writer.setLifecycle(reviewKey, { verifyingSince: null, verifyingHead: null, verifyingMessageId: null, verifyingFixes: null, preparedAt: Date.now() });
  /** Once a check's end is recorded: whose turn the review is now, and its open pages told. */
  const checkEnded = async (reviewKey: string) => {
    await sync.evaluate(reviewKey);
    bb.realtime.publish(`feedback:${reviewKey}`, { ts: Date.now() });
  };
  /** The review whose feedback check waits in the queue as this message. */
  const queuedCheck = async (store: AsyncStore, entry: { id: string; threadId: string }) => {
    return store.exclusive(async (tx) => {
      const reviewKey = await assistantReview(tx, entry.threadId);
      const review = reviewKey ? await tx.getReview(reviewKey) : null;
      return review?.verifyingSince && review.verifyingMessageId === entry.id ? reviewKey : null;
    });
  };
  // A queued ask: its turn comes when its message dispatches, and never if it's deleted from the queue.
  const queuedAsk = async (store: AsyncStore, entry: { id: string; threadId: string }) => {
    return store.exclusive(async (tx) => {
      const reviewKey = await assistantReview(tx, entry.threadId);
      const review = reviewKey ? await tx.getReview(reviewKey) : null;
      const found = review ? listAsks(review).find(({ ask }) => ask.state === "queued" && ask.queuedMessageId === entry.id) : undefined;
      return found ? { reviewKey: reviewKey!, ...found } : null;
    });
  };
  // A message leaving the queue takes one turn of the store's queue as its event arrives, so the event, the turn's end,
  // and the send that queued the message see each other whole, in the order BB told them.
  const dispatched: PluginThreadEventHandler<"message.dispatched"> = async ({ entry }) => {
    return store.exclusive(async (tx) => {
      const found = await queuedAsk(tx, entry);
      if (found) await setAsk(tx, found.reviewKey, found.at, { threadId: found.ask.threadId, state: "running", at: Date.now() });
      const checking = await queuedCheck(tx, entry);
      if (checking) await tx.setLifecycle(checking, { verifyingMessageId: null });
      else noteLeftQueue(entry.id, "dispatched");
    });
  };
  const cancelled: PluginThreadEventHandler<"message.cancelled"> = async ({ entry }) => {
    const checking = await store.exclusive(async (tx) => {
      const found = await queuedAsk(tx, entry);
      if (found) await setAsk(tx, found.reviewKey, found.at, null);
      if (found && "deepDive" in found.at) bb.realtime.publish(`review:${found.reviewKey}`, { ts: Date.now() });
      // A check deleted from the queue never runs.
      const checking = await queuedCheck(tx, entry);
      if (checking) await endCheck(tx, checking);
      else noteLeftQueue(entry.id, "cancelled");
      return checking;
    });
    if (checking) await checkEnded(checking);
  };
  // A review agent's chat deleted while its tab shows: the tab reads the conversation again, and says so.
  const deleted: PluginThreadEventHandler<"thread.deleted"> = async ({ thread }) => {
    const reviewKey = await store.exclusive((tx) => assistantReview(tx, thread.id));
    if (reviewKey) bb.realtime.publish(`conversation:${reviewKey}`, { deleted: thread.id });
  };
  return {
    events: {
      "thread.idle": [settle],
      "thread.deleted": [deleted],
      "thread.failed": [settle, ({ thread, error }) => guideWorkerFailed(bb, thread.id, error)],
      "message.dispatched": [dispatched],
      "message.cancelled": [cancelled],
    } satisfies EventListeners,
  };
}
