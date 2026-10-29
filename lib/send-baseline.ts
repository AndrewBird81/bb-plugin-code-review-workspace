import type { ReviewLifecycle } from "../src/store";

/** The snapshot a Send's diff is kept as: `send:<n>`. */
export const sendKey = (n: number) => `send:${n}`;

/** The Send a snapshot key names, as `send:2` names 2; null for a commit's. */
export function sendOf(key: string | null | undefined): number | null {
  const match = key ? /^send:(\d+)$/.exec(key) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The diff a Send went at: Send `n`, as a comment's `sendN` names it, or else the review's last Send. Null before any
 * Send, and for one the review no longer keeps. Your PR review's commit is baselineOf's, which this never changes.
 */
export function sendBaselineOf(review: Pick<ReviewLifecycle, "sends">, n?: number): { n: number; key: string; at: number } | null {
  const sends = review.sends ?? [];
  const send = n === undefined ? sends.at(-1) : sends.find((entry) => entry.n === n);
  return send ? { n: send.n, key: sendKey(send.n), at: send.at } : null;
}
