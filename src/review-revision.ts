import { createHash } from "node:crypto";
import type { AsyncStore } from "./store-queue";

export async function reviewRevision(store: AsyncStore, targetKey: string): Promise<string> {
  return store.exclusive(async (tx) => {
    const meta = await tx.getReview(targetKey);
    return createHash("sha256").update(meta?.headSha ?? "").update("\0").update(await tx.patchHash(targetKey)).digest("hex");
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
