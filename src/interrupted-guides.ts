// Guides a reload interrupted: they restart at load, or once their writer's machine reconnects.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rerunReview } from "./rereview";
import { guideWriterUnavailable } from "./generate";
import type { AsyncStore } from "./store-queue";

interface Deps {
  bb: BbPluginApi; store: AsyncStore;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

/** How long an interrupted guide waits for its writer's machine to reconnect before it stays Failed. */
const RESTART_WAIT = 10 * 60_000;

/**
 * Start an interrupted guide's rebuild again, without alerting. When the guide writer's machine isn't
 * connected, the review records restartPending, `since` the first try, for retryInterruptedGuides; for any other
 * reason, as GitHub not answering, it stays failed, saying why, until Try again.
 */
export async function restartInterruptedGuide(deps: Deps, targetKey: string, since = Date.now()): Promise<void> {
  const restarted = await rerunReview(deps, targetKey, { notify: false, unattended: true });
  if (restarted.ok) return;
  const exists = !!await deps.store.getReview(targetKey);
  const waiting = exists && !!await guideWriterUnavailable(deps.bb, deps.store).catch(() => null);
  if (waiting) await deps.store.setLifecycle(targetKey, { restartPending: { since } });
  else if (exists) await failed(deps, targetKey, restarted.error ?? "The guide couldn't restart.");
  deps.bb.log.warn(`The interrupted guide for ${targetKey} didn't restart${waiting ? " yet" : ""}: ${restarted.error}`);
}

/** The interrupted guide stays failed, its page saying `why`. */
async function failed(deps: Deps, targetKey: string, why: string, now = Date.now()) {
  await deps.store.setLifecycle(targetKey, { guideError: { at: now, text: why } });
  deps.bb.realtime.publish(`review:${targetKey}`, { ts: now });
  deps.bb.realtime.publish("reviews", { ts: now });
}

/** Restart the interrupted guides whose writer's machine is back, for up to RESTART_WAIT. */
export async function retryInterruptedGuides(deps: Deps, now = Date.now()): Promise<void> {
  const waiting = await deps.store.exclusive(async (tx) => {
    const waiting: Array<{ targetKey: string; since: number }> = [];
    for (const review of await tx.listReviews()) {
      const pending = review.restartPending;
      if (!pending) continue;
      // Rebuilt some other way since, as with a click on Rebuild.
      if (review.status !== "error") await tx.setLifecycle(review.targetKey, { restartPending: null });
      else waiting.push({ targetKey: review.targetKey, since: pending.since });
    }
    return waiting;
  });
  for (const { targetKey, since } of waiting) {
    const unavailable = await guideWriterUnavailable(deps.bb, deps.store).catch((error) => String(error));
    if (now - since >= RESTART_WAIT) {
      await deps.store.exclusive(async (tx) => {
        await tx.setLifecycle(targetKey, { restartPending: null });
        // An open page stops saying the guide restarts on its own, and says why it failed.
        await failed({ ...deps, store: tx }, targetKey, unavailable ?? "The guide writer's machine didn't reconnect in time.", now);
      });
      deps.bb.log.warn(`The interrupted guide for ${targetKey} stays failed: ${unavailable ?? "its machine didn't reconnect in time"}`);
      continue;
    }
    if (unavailable) continue;
    await deps.store.setLifecycle(targetKey, { restartPending: null });
    await restartInterruptedGuide(deps, targetKey, since);
  }
}
