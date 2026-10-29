// Where each review's code is, for its identity (lib/review-identity.ts): a local review's repository, from its
// project's remote, and the machine its checkout is on, the bb server's, where `bb review` reads it; a folder's review's
// own folder, machine and repository. Derived for display, never stored: the top-level `repo` still means a PR.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { distinguish, reviewIdentity, type ReviewIdentity, type ReviewPlace } from "../lib/review-identity";
import { machineStatus } from "./machines";
import type { ReviewMeta } from "./store";

/** What bb says that a local review's place needs: each project's repository, and the bb server's name. */
export interface PlaceFacts { repos: ReadonlyMap<string, string>; machine?: string }

const NONE: PlaceFacts = { repos: new Map() };
/** How long bb's answer is reused: every list load and open review reads it. */
const FRESH_MS = 60_000;
const cache = new WeakMap<BbPluginApi, { at: number; facts: Promise<PlaceFacts> }>();

/** owner/repo from a remote's URL: https://github.com/o/r.git, git@github.com:o/r, ssh://git@host/o/r. */
export function remoteRepo(url: string | null | undefined): string | null {
  const match = url?.trim().match(/[/:]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function answer<T, F>(ask: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await ask();
  } catch {
    return fallback;
  }
}

/** bb's facts for local reviews' places, when `reviews` has one; read outside the store's lock, as it asks bb. */
export function placeFacts(bb: BbPluginApi, reviews: readonly Pick<ReviewMeta, "kind">[]): Promise<PlaceFacts> {
  if (!reviews.some((review) => review.kind === "ref")) return Promise.resolve(NONE);
  const cached = cache.get(bb);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.facts;
  const facts = (async (): Promise<PlaceFacts> => {
    // Without an answer, the ids name the folder, and no machine.
    const [projects, config] = await Promise.all([
      answer(() => bb.sdk.projects.list({ includePersonal: true }), []),
      answer(() => bb.sdk.system.config(), null),
    ]);
    const repos = new Map<string, string>();
    for (const project of projects) {
      const repo = remoteRepo(project.gitRemoteUrl);
      if (repo) repos.set(project.id, repo);
    }
    const machine = (await machineStatus(bb, config?.primaryHostId ?? undefined))?.name;
    return { repos, ...machine ? { machine } : {} };
  })();
  cache.set(bb, { at: Date.now(), facts });
  return facts;
}

/** Each review's place in `reviews`, your list, with what tells apart ids that would match. */
export function reviewPlaces(facts: PlaceFacts, reviews: readonly ReviewMeta[]): Map<string, ReviewPlace> {
  // A folder's review is where its folder is, on whichever machine (src/feature-review.ts).
  const placed = reviews.map((review) => review.kind !== "ref" ? review : review.feature ? { ...review, place: {
    ...review.feature.repo ? { repo: review.feature.repo } : {}, machine: review.feature.machine, path: review.feature.path,
  } } : { ...review, place: {
    ...review.projectId && facts.repos.get(review.projectId) ? { repo: facts.repos.get(review.projectId) } : {},
    ...facts.machine ? { machine: facts.machine } : {},
    ...review.cwd ? { path: review.cwd } : {},
  } });
  const apart = distinguish(placed);
  const places = new Map<string, ReviewPlace>();
  for (const review of placed) {
    const place = { ..."place" in review ? review.place : {}, ...apart.get(review.targetKey) };
    if (Object.keys(place).length) places.set(review.targetKey, place);
  }
  return places;
}

/** `review`'s identity among `reviews`, your list; `guideTitle` names a local review that has no name (lib/review-identity.ts). */
export function identityIn(facts: PlaceFacts, reviews: readonly ReviewMeta[], review: ReviewMeta, guideTitle?: string | null): ReviewIdentity {
  return reviewIdentity({ ...review, place: reviewPlaces(facts, [...reviews.filter((other) => other.targetKey !== review.targetKey), review]).get(review.targetKey) }, guideTitle);
}
