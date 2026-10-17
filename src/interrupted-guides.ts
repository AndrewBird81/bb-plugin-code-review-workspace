// Guides a reload interrupted: they restart at load, or once their writer's machine reconnects.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { rerunReview } from "./rereview";
import { guideWriterUnavailable } from "./generate";

interface Deps {
  bb: BbPluginApi; store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

/** How long an interrupted guide waits for its writer's machine to reconnect before it stays Failed. */
const RESTART_WAIT = 10 * 60_000;

/**
 * Start an interrupted guide's rebuild again, without alerting. When the guide writer's machine isn't
 * connected, the review records restartPending, `since` the first try, for retryInterruptedGuides.
 */
export async function restartInterruptedGuide(deps: Deps, targetKey: string, since = Date.now()): Promise<void> {
  const restarted = await rerunReview(deps, targetKey, { notify: false, unattended: true });
  if (restarted.ok) return;
  const waiting = !!deps.store.getReview(targetKey) && !!await guideWriterUnavailable(deps.bb, deps.store).catch(() => null);
  if (waiting) deps.store.setLifecycle(targetKey, { restartPending: { since } });
  deps.bb.log.warn(`The interrupted guide for ${targetKey} didn't restart${waiting ? " yet" : ""}: ${restarted.error}`);
}

/** Restart the interrupted guides whose writer's machine is back, for up to RESTART_WAIT. */
export async function retryInterruptedGuides(deps: Deps, now = Date.now()): Promise<void> {
  for (const review of deps.store.listReviews()) {
    const pending = review.restartPending;
    if (!pending) continue;
    // Rebuilt some other way since, as with a click on Rebuild.
    if (review.status !== "error") { deps.store.setLifecycle(review.targetKey, { restartPending: null }); continue; }
    const unavailable = await guideWriterUnavailable(deps.bb, deps.store).catch((error) => String(error));
    if (now - pending.since >= RESTART_WAIT) {
      deps.store.setLifecycle(review.targetKey, { restartPending: null });
      // An open page stops saying the guide restarts on its own.
      deps.bb.realtime.publish(`review:${review.targetKey}`, { ts: now });
      deps.bb.realtime.publish("reviews", { ts: now });
      deps.bb.log.warn(`The interrupted guide for ${review.targetKey} stays failed: ${unavailable ?? "its machine didn't reconnect in time"}`);
      continue;
    }
    if (unavailable) continue;
    deps.store.setLifecycle(review.targetKey, { restartPending: null });
    await restartInterruptedGuide(deps, review.targetKey, pending.since);
  }
}
