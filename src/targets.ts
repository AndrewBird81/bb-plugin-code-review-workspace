import { createHash } from "node:crypto";
import { parsePrLink } from "../lib/pr-link";
import type { AsyncStore } from "./store-queue";

export type ReviewTarget =
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "ref"; gitRef: string; base?: string };

export function parseTarget(input: string, base?: string): ReviewTarget {
  const trimmed = input.trim();
  // A PR's link, or owner/repo#n.
  const link = parsePrLink(trimmed);
  if (link) return { kind: "pr", number: link.number, repo: link.repo };
  if (/^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return { kind: "pr", number: Number(trimmed) };
  return base ? { kind: "ref", gitRef: trimmed, base } : { kind: "ref", gitRef: trimmed };
}

export function targetKey(t: ReviewTarget, scope?: { projectId: string; cwd: string }): string {
  if (t.kind === "pr") return t.repo
    ? `pr-${createHash("sha256").update(t.repo.toLowerCase()).digest("hex").slice(0, 16)}-${t.number}`
    : `pr-${t.number}`;
  const hash = createHash("sha1")
    .update(JSON.stringify([scope?.projectId, scope?.cwd, t.gitRef, t.base ?? ""]))
    .digest("hex")
    .slice(0, 12);
  return `ref-${hash}`;
}

/** A local review's key: its folder, as bb's environment, and its branch. One review per folder and branch, however many threads work there. */
export function featureKey(environmentId: string, branch: string): string {
  return `br-${createHash("sha1").update(JSON.stringify([environmentId, branch])).digest("hex").slice(0, 16)}`;
}

/**
 * The key of the saved review of a PR: its own, else, for a renamed or transferred repository, the one the sync keeps
 * under the old name with the PR's new link. The PR's own key when neither is saved.
 */
export async function prReviewKey(store: Pick<AsyncStore, "getReview" | "listReviews" | "exclusive">, pr: { repo: string; number: number }): Promise<string> {
  return store.exclusive(async (tx) => {
    const key = targetKey({ kind: "pr", ...pr });
    if (await tx.getReview(key)) return key;
    const url = `https://github.com/${pr.repo.toLowerCase()}/pull/${pr.number}`;
    return (await tx.listReviews()).find((review) => review.kind === "pr" && review.url && parsePrLink(review.url)?.url === url)?.targetKey ?? key;
  });
}
