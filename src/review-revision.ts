import { createHash } from "node:crypto";
import type { AsyncStore } from "./store-queue";

/** The revision of the diff a review shows: its head commit and its patch's hash. */
export function revisionOf(headSha: string | null | undefined, patchHash: string): string {
  return createHash("sha256").update(headSha ?? "").update("\0").update(patchHash).digest("hex");
}

export async function reviewRevision(store: AsyncStore, targetKey: string): Promise<string> {
  return store.exclusive(async (tx) => {
    const meta = await tx.getReview(targetKey);
    return revisionOf(meta?.headSha, await tx.patchHash(targetKey));
  });
}
export async function requireReviewRevision(store: AsyncStore, targetKey: string, revision?: string) {
  return store.exclusive(async (tx) => {
    if ((await tx.getReview(targetKey))?.status === "generating") throw new Error("The guide is rebuilding for new commits; your text is kept. Try again when it’s ready.");
    if (!revision || revision !== await reviewRevision(tx, targetKey)) {
      throw new Error("This review changed in another window. Open the latest diff before saving or submitting feedback. Your text is still here.");
    }
  });
}
