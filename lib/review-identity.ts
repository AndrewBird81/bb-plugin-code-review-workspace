// Which review this is, at a glance: its short id (api#4512, or api:branch for local work), its name, whose it is and
// where its code is, in one form for every page, title, alert and thread the plugin names it in. Pure, for the server
// and the panel alike; the server derives `place` (src/review-places.ts), which nothing stores.
import type { ReviewMeta } from "../src/store";
import { reviewName } from "./review-name";

/** Where a review's code is, as the server derives it for display. */
export interface ReviewPlace {
  /** A local review's repository, owner/repo, from its project's remote. */
  repo?: string;
  /** The machine a local review's checkout is on, and its folder. */
  machine?: string;
  path?: string;
  /** Another review in the list has a repository of the same name under another owner: the id names the owner. */
  owner?: boolean;
  /** Another local review of the same repository and branch reads another folder: the id adds the end of this one's path. */
  folder?: string;
  /** Another local review of the same repository and branch reads this folder too: the id says the ref as given. */
  ref?: boolean;
}

/** A review, and its guide's title where the server sent it: a local review's name until it has one. */
export type Identifiable = Pick<ReviewMeta, "targetKey"> & Partial<Pick<ReviewMeta, "kind" | "repo" | "number" | "title" | "name" | "gitRef" | "author" | "ownPr" | "prState" | "cwd" | "signals">> & { place?: ReviewPlace | null; guideTitle?: string | null };

export interface ReviewIdentity {
  /** api#4512, or api:feat/x for local work: short, and kept whole wherever the name is cut. */
  id: string;
  /** The id in two: the repository, which a narrow chip may cut, and `#4512` or `:feat/x`, which nothing cuts. */
  idRepo: string;
  idTail: string;
  /** The repository in full, owner/repo, where it's known. */
  repo: string | null;
  name: string;
  /** "Yours", "@dana", or "Local"; null for a PR whose author isn't known. */
  whose: string | null;
  /** A local review's machine and folder: "MaxBook · ~/src/api". */
  where: string | null;
  state: "Draft" | "Merged" | "Closed" | null;
  /** The id, then the name, so cutting it at its end keeps the id: "api#4512 · Fix login race". */
  line: string;
  /** All of it in words, for a screen reader. */
  label: string;
}

/** A name as a thread's title takes it: on one line, and at most 80 characters. */
export function titleText(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** The identity as a thread's title says it: the id, then the name on one line and cut to 80 characters. */
export const threadLine = (identity: ReviewIdentity) => identity.line === identity.id ? identity.id : `${identity.id} · ${titleText(identity.name)}`;

/** A bb-managed branch reads as its slug: bb/snooze-checks-thr_ab12 is snooze-checks. */
export const branchLabel = (branch: string) => branch.replace(/^bb\/(.+)-thr_[a-z0-9]+$/, "$1");

/** The branch a local review's ref ends on: feat in main...feat. */
const refHead = (gitRef: string) => gitRef.split(/\.{2,3}/).at(-1) || gitRef;

const folderName = (path: string | undefined) => path?.split(/[\\/]/).filter(Boolean).at(-1);

/** A home folder as ~: /Users/ana/src/api is ~/src/api. */
const homeShort = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

const fullRepo = (review: Identifiable) => (review.kind === "ref" ? review.place?.repo : review.repo) ?? null;

/** The repository as the id says it: its name, or owner/name where another owner's repository has the name too. */
function shownRepo(review: Identifiable): string | null {
  const repo = fullRepo(review);
  return repo && !review.place?.owner ? repo.split("/").at(-1)! : repo;
}

/**
 * The review's identity. `guideTitle`, its guide's title, names a local review that has no title or name of yours,
 * where its ref would say no more than its id.
 */
export function reviewIdentity(review: Identifiable, guideTitle?: string | null): ReviewIdentity {
  const repo = fullRepo(review);
  const named = review.kind === "ref" && !review.name && !review.title ? guideTitle || review.guideTitle || null : null;
  const name = named ?? reviewName(review);
  if (review.kind !== "ref") {
    const [idRepo, idTail] = review.number ? [shownRepo(review) ?? "", `#${review.number}`] : [review.targetKey, ""];
    const id = idRepo + idTail;
    const state = review.prState === "MERGED" ? "Merged" : review.prState === "CLOSED" ? "Closed" : review.signals?.isDraft ? "Draft" : null;
    const whose = review.ownPr ? "Yours" : review.author ? `@${review.author}` : null;
    const by = review.ownPr ? ", yours" : review.author ? `, by ${review.author}` : "";
    const label = review.number ? `Pull request ${review.number}${repo ? ` in ${repo}` : ""}: ${name}${by}${state ? `, ${state.toLowerCase()}` : ""}` : name;
    return { id, idRepo, idTail, repo, name, whose, where: null, state, line: `${id} · ${name}`, label };
  }
  const path = review.place?.path ?? review.cwd;
  const branch = review.gitRef ? review.place?.ref ? review.gitRef : branchLabel(refHead(review.gitRef)) : null;
  const [idRepo, idTail] = branch ? [shownRepo(review) ?? folderName(path) ?? "local", `:${branch}${review.place?.folder ? ` (${review.place.folder})` : ""}`] : [review.targetKey, ""];
  const id = idRepo + idTail;
  const where = [review.place?.machine, path && homeShort(path)].filter(Boolean).join(" · ") || null;
  // Called by its ref, which the id says already, until it has a title, a guide, or your name.
  const bare = !review.name && !review.title && !named;
  const label = `Local review of ${branch ?? review.gitRef ?? id}${repo ? ` in ${repo}` : ""}${bare ? "" : `: ${name}`}${review.place?.machine ? `, on ${review.place.machine}` : ""}${path ? ` in ${homeShort(path)}` : ""}`;
  return { id, idRepo, idTail, repo, name, whose: "Local", where, state: null, line: bare ? id : `${id} · ${name}`, label };
}

/** Each of `paths`' shortest ending that no other has: /w/thr_a-1/api and /w/thr_b-1/api end thr_a-1/api and thr_b-1/api. */
function endings(paths: readonly string[]): Map<string, string> {
  const parts = paths.map((path) => path.split(/[\\/]/).filter(Boolean));
  return new Map(paths.map((path, at) => {
    const own = parts[at];
    for (let count = 1; count < own.length; count++) {
      const end = own.slice(-count).join("/");
      if (parts.every((other, i) => i === at || other.slice(-count).join("/") !== end)) return [path, end];
    }
    return [path, own.join("/")];
  }));
}

/**
 * What tells apart reviews whose ids would match in `reviews`, your list: the owner, where two repositories share a name;
 * the end of the folder's path, where two local reviews of one repository and branch read different folders; and the
 * ref as given, where they read the same folder, as main...feat and feat, or bb/feat-thr_a and feat, do.
 */
export function distinguish(reviews: readonly Identifiable[]): Map<string, Pick<ReviewPlace, "owner" | "folder" | "ref">> {
  // Each repository name's repositories, owner/name, in any case.
  const owners = new Map<string, Set<string>>();
  const repoName = (repo: string) => repo.split("/").at(-1)!;
  for (const review of reviews) {
    const repo = fullRepo(review)?.toLowerCase();
    if (repo) owners.set(repoName(repo), (owners.get(repoName(repo)) ?? new Set()).add(repo));
  }
  const shared = (review: Identifiable) => {
    const repo = fullRepo(review)?.toLowerCase();
    return !!repo && owners.get(repoName(repo))!.size > 1;
  };
  // Local reviews whose ids would match, by that id, and each one's folder.
  const pathOf = (review: Identifiable) => review.place?.path ?? review.cwd ?? "";
  const clashes = new Map<string, Identifiable[]>();
  for (const review of reviews) {
    if (review.kind !== "ref" || !review.gitRef) continue;
    const key = `${fullRepo(review)?.toLowerCase() ?? folderName(pathOf(review))}:${branchLabel(refHead(review.gitRef))}`;
    clashes.set(key, [...clashes.get(key) ?? [], review]);
  }
  const apart = new Map<string, Pick<ReviewPlace, "folder" | "ref">>();
  for (const group of clashes.values()) {
    if (group.length < 2) continue;
    const paths = [...new Set(group.map(pathOf))];
    const ends = paths.length > 1 ? endings(paths) : null;
    for (const review of group) {
      const folder = ends?.get(pathOf(review));
      const ref = group.some((other) => other !== review && pathOf(other) === pathOf(review));
      apart.set(review.targetKey, { ...folder ? { folder } : {}, ...ref ? { ref } : {} });
    }
  }
  const result = new Map<string, Pick<ReviewPlace, "owner" | "folder" | "ref">>();
  for (const review of reviews) {
    const owner = shared(review);
    const local = apart.get(review.targetKey);
    if (owner || local) result.set(review.targetKey, { ...owner ? { owner } : {}, ...local });
  }
  return result;
}
