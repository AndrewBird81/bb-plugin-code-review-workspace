// Which changed files a review's assistant read through Code Review Workspace, for Finish review's "Read 14 of 16 files".
import { assistantReview } from "./draft-comments";
import type { AsyncStore } from "./store-queue";

/** What reads count against: a PR's head commit, or a local review's diff. */
export async function agentReadsHead(store: AsyncStore, targetKey: string): Promise<string | null> {
  return store.exclusive(async (tx) => {
    const review = await tx.getReview(targetKey);
    return review ? review.headSha ?? `diff:${await tx.patchHash(targetKey)}` : null;
  });
}

/**
 * Record the files a tool returned to `threadId`, when it's the review's own assistant: the guide writer's reads don't
 * count. A new head starts the list again.
 */
export async function recordAgentReads(store: AsyncStore, threadId: string, targetKey: string, files: readonly string[]): Promise<void> {
  return store.exclusive(async (tx) => {
    if (!files.length || await assistantReview(tx, threadId) !== targetKey) return;
    const head = await agentReadsHead(tx, targetKey);
    if (!head) return;
    const reads = (await tx.getReview(targetKey))?.agentReads;
    const kept = reads?.head === head ? reads.files : [];
    const added = [...new Set(files)].filter((file) => !kept.includes(file));
    if (added.length || reads?.head !== head) await tx.setLifecycle(targetKey, { agentReads: { head, files: [...kept, ...added] } });
  });
}
