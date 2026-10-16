// BB can mount a review's new workspace while the old one is still there (lib/remount.ts), so what a workspace forgets
// of its review as it goes, in state shared by review, waits until no other workspace shows the review.
const holds = new Map<string, number>();

/**
 * A workspace's `part` shows the review `targetKey`. The returned function says it went, and runs `forget` when no
 * other workspace's `part` shows the review.
 */
export function holdReview(part: string, targetKey: string, forget: () => void): () => void {
  const key = `${part}:${targetKey}`;
  holds.set(key, (holds.get(key) ?? 0) + 1);
  return () => {
    const left = (holds.get(key) ?? 1) - 1;
    if (left > 0) return void holds.set(key, left);
    holds.delete(key);
    forget();
  };
}
