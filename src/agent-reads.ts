// Which changed files a review's assistant read through Code Review Workspace, for Finish review's "Read 14 of 16 files".
import type { Store } from "./store";
import { assistantReview } from "./draft-comments";

/** What reads count against: a PR's head commit, or a local review's diff. */
export function agentReadsHead(store: Store, targetKey: string): string | null {
  const review = store.getReview(targetKey);
  return review ? review.headSha ?? `diff:${store.patchHash(targetKey)}` : null;
}

/**
 * Record the files a tool returned to `threadId`, when it's the review's own assistant: the guide writer's reads don't
 * count. A new head starts the list again.
 */
export function recordAgentReads(store: Store, threadId: string, targetKey: string, files: readonly string[]): void {
  if (!files.length || assistantReview(store, threadId) !== targetKey) return;
  const head = agentReadsHead(store, targetKey);
  if (!head) return;
  const reads = store.getReview(targetKey)?.agentReads;
  const kept = reads?.head === head ? reads.files : [];
  const added = [...new Set(files)].filter((file) => !kept.includes(file));
  if (added.length || reads?.head !== head) store.setLifecycle(targetKey, { agentReads: { head, files: [...kept, ...added] } });
}
