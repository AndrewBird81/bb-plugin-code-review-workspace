import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parsePrLink } from "../lib/pr-link";
import { localIdOf, reviewIdentity } from "../lib/review-identity";
import { placeFacts, reviewPlaces } from "./review-places";
import type { ReviewMeta } from "./store";
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

/**
 * The review `given` names, as every command takes it: its key; a PR's link or owner/repo#n; its id as the review shows
 * it, api#4512 or api:feat; or a folder's review's id from before it became its PR's (localIdOf). Of the reviews an id
 * names, one not archived, then the newest. Null for none.
 */
export async function reviewNamed(store: AsyncStore, bb: BbPluginApi, given: string): Promise<ReviewMeta | null> {
  const text = given.trim();
  if (!text) return null;
  const keyed = await store.getReview(text);
  if (keyed) return keyed;
  const link = parsePrLink(text);
  if (link) return store.getReview(await prReviewKey(store, link));
  const all = await store.listReviews();
  const places = reviewPlaces(await placeFacts(bb, all), all);
  const archived = (review: ReviewMeta) => Number(!!(review.archivedAt || review.userArchivedAt));
  // Each id in turn: a merged review's former ids (mergedFrom[].id) go after these, and a tombstone found leads on to
  // the review it was merged into.
  const ids: Array<(review: ReviewMeta) => string | null> = [
    (review) => reviewIdentity({ ...review, place: places.get(review.targetKey) }).id,
    (review) => review.feature ? localIdOf({ ...review, feature: review.feature }) : null,
  ];
  for (const idOf of ids) {
    const named = all.filter((review) => idOf(review)?.toLowerCase() === text.toLowerCase());
    if (named.length) return named.sort((a, b) => archived(a) - archived(b) || b.createdAt - a.createdAt)[0];
  }
  return null;
}
