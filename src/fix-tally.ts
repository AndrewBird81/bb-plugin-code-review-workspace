// What's out with the thread that fixes a review's comments, counted, and when the review is Ready to re-review: kept
// on the review (`fixes`, each Send's `readyAt`), so whose turn it is reads it without the draft.
import type { FixTally, SendEntry } from "./store";
import type { AsyncStore } from "./store-queue";
import { commentsOut, tallyOf } from "../lib/fixes";
import { sendKey } from "../lib/send-baseline";
import type { AssessmentVerdict } from "../lib/feedback";

/**
 * Count what's out with the thread that fixes the review's comments again, with what the review agent's check found of
 * each, in the caller's block, and make the review Ready to re-review when the thread asks: `ready` (bb review ready),
 * or a `report` that leaves nothing out unreported, `by` whoever ran ready. Each Send waiting then is ready; with nothing
 * out, none is. Returns whether it became ready now; null for a review that sent nothing.
 */
export async function settleFixes(tx: AsyncStore, key: string, fire?: "report" | "ready", by?: SendEntry["readyBy"]): Promise<{ ready: boolean; tally: FixTally } | null> {
  const review = await tx.getReview(key);
  if (!review || !review.sends?.length && !review.fixes) return null;
  const out = commentsOut((await tx.getDraft(key)).comments, review.threadSends);
  // What the review agent's check found of each, against the Send it's out with.
  const verdicts = new Map<string, AssessmentVerdict>();
  for (const n of new Set(out.map((comment) => comment.sendN))) {
    for (const item of (await tx.getAssessment(key, sendKey(n))).items) if (out.some((comment) => comment.id === item.id && comment.sendN === n)) verdicts.set(item.id, item.verdict);
  }
  const tally = tallyOf(out, verdicts);
  const sends = review.sends ?? [];
  const waiting = sends.some((send) => send.readyAt === undefined);
  // With nothing out, there's nothing to finish.
  const ready = waiting && tally.sent > 0 && (fire === "ready" || fire === "report" && tally.reported === tally.sent);
  const at = Date.now();
  const readied = (send: SendEntry): SendEntry => ({ ...send, readyAt: at, ...fire === "ready" && by ? { readyBy: by } : {} });
  await tx.setLifecycle(key, { fixes: tally, ...ready ? { sends: sends.map((send) => send.readyAt === undefined ? readied(send) : send) } : {} });
  return { ready, tally };
}
