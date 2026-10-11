import { createHash } from "node:crypto";
import type { Store } from "./store";

export function reviewRevision(store: Store, targetKey: string): string {
  const meta = store.getReview(targetKey);
  return createHash("sha256").update(meta?.headSha ?? "").update("\0").update(store.patchHash(targetKey)).digest("hex");
}
export function requireReviewRevision(store: Store, targetKey: string, revision?: string) {
  if (store.getReview(targetKey)?.status === "generating") throw new Error("The guide is rebuilding for new commits; your text is kept. Save again when it’s ready.");
  if (!revision || revision !== reviewRevision(store, targetKey)) {
    throw new Error("This review changed in another window. Open the latest diff before saving or submitting feedback. Your text is still here.");
  }
}
