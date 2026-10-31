import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parsePrLink } from "../lib/pr-link";
import { localIdOf, reviewIdentity } from "../lib/review-identity";
import { placeFacts, reviewPlaces, type PlaceFacts } from "./review-places";
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

/**
 * A local review's key: its folder, as bb's environment, and its branch. One review per folder and branch, however many
 * threads work there; `n`, 2 and on, for the next review once the one keyed before moved on (src/feature-review.ts).
 */
export function featureKey(environmentId: string, branch: string, n?: number): string {
  return `br-${createHash("sha1").update(JSON.stringify(n ? [environmentId, branch, n] : [environmentId, branch])).digest("hex").slice(0, 16)}`;
}

/** How many merges on a review is followed, so a cycle, which the store never makes, still ends. */
const MERGE_HOPS = 10;

/**
 * The review that stays of `review`'s merges, among `reviews`: the one it was merged into, and on through each merge
 * after that. `review` itself when it wasn't merged; the last one found when the next is gone.
 */
export function mergedSurvivor(review: ReviewMeta, reviews: readonly ReviewMeta[]): ReviewMeta {
  let at = review;
  for (let hop = 0; at.mergedInto && hop < MERGE_HOPS; hop++) {
    const into = reviews.find((other) => other.targetKey === at.mergedInto);
    if (!into) break;
    at = into;
  }
  return at;
}

/**
 * The key of the saved review of a PR: its own, else, for a renamed or transferred repository, or a folder's review that
 * became the PR's, the one with the PR's link. One merged into another review is the one that stays of its merges. The
 * PR's own key when none is saved.
 */
export async function prReviewKey(store: Pick<AsyncStore, "getReview" | "listReviews" | "exclusive">, pr: { repo: string; number: number }): Promise<string> {
  return store.exclusive(async (tx) => {
    const key = targetKey({ kind: "pr", ...pr });
    const own = await tx.getReview(key);
    if (own) return own.mergedInto ? mergedSurvivor(own, await tx.listReviews()).targetKey : key;
    const url = `https://github.com/${pr.repo.toLowerCase()}/pull/${pr.number}`;
    const linked = (await tx.listReviews()).filter((review) => review.kind === "pr" && review.url && parsePrLink(review.url)?.url === url);
    return (linked.find((review) => !review.mergedInto) ?? linked[0])?.targetKey ?? key;
  });
}

/**
 * The review `given` names, as every command takes it: its key; a PR's link or owner/repo#n; its id as the review shows
 * it, api#4512 or api:feat; a folder's review's id from before it became its PR's (localIdOf); the id of a review
 * merged into it; or its id on a branch it followed its folder off. One merged into another names that one. Of the reviews an id names, one not archived, then the
 * newest. Null for none. `facts`: bb's facts for local reviews' ids, read before; without them it reads them, so not in
 * the store's lock.
 */
export async function reviewNamed(store: AsyncStore, bb: BbPluginApi, given: string, facts?: PlaceFacts): Promise<ReviewMeta | null> {
  const text = given.trim();
  if (!text) return null;
  const all = await store.listReviews();
  const merged = (review: ReviewMeta) => mergedSurvivor(review, all);
  const keyed = all.find((review) => review.targetKey === text);
  if (keyed) return merged(keyed);
  const link = parsePrLink(text);
  if (link) return store.getReview(await prReviewKey(store, link));
  const places = reviewPlaces(facts ?? await placeFacts(bb, all), all);
  const archived = (review: ReviewMeta) => Number(!!(review.archivedAt || review.userArchivedAt));
  // Each id in turn.
  const ids: Array<(review: ReviewMeta) => Array<string | null>> = [
    (review) => [reviewIdentity({ ...review, place: places.get(review.targetKey) }).id],
    (review) => [review.feature ? localIdOf({ ...review, feature: review.feature }) : null],
    (review) => review.mergedFrom?.map((from) => from.id) ?? [],
    (review) => review.feature ? (review.formerBranches ?? []).map((branch) => localIdOf({ ...review, feature: { ...review.feature!, branch } })) : [],
  ];
  for (const idOf of ids) {
    const named = [...new Set(all.filter((review) => idOf(review).some((id) => id?.toLowerCase() === text.toLowerCase())).map(merged))];
    if (named.length) return named.sort((a, b) => archived(a) - archived(b) || b.createdAt - a.createdAt)[0];
  }
  return null;
}
