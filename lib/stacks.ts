// Stacked PRs: a PR whose base branch is another open PR's head builds on it. Pure, so the server
// attaches each review's place and the panel shows it.
import type { ReviewMeta } from "../src/store";

/** A PR in a stack: one of your reviews (targetKey), or one GitHub named that isn't in your list. */
export interface StackMember {
  targetKey: string | null;
  number: number;
  title: string | null;
  url: string | null;
  status: ReviewMeta["status"] | null;
  /** You've reviewed it, or wrote it. */
  reviewed: boolean;
}

/** A review's place in its stack: every PR in it, bottom first, and its neighbours. */
export interface StackPlace {
  members: StackMember[];
  index: number;
  parent: StackMember | null;
  children: StackMember[];
}

export type StackInput = Pick<ReviewMeta, "targetKey"> & Partial<Pick<ReviewMeta,
  "kind" | "repo" | "number" | "base" | "head" | "prState" | "archivedAt" | "title" | "url" | "status" | "stackParent" | "submittedVerdict" | "signals" | "ownPr">>;

/** A branch PRs merge into for good, such as gitflow's develop: an open PR from it (a release) stacks nothing on it. */
export const longLivedBranch = (name: string) => /^(main|master|develop|development|dev|trunk|staging|production|prod|releases?\/.+)$/i.test(name);

/**
 * Each stacked review's place, by targetKey. A review's parent is the open PR GitHub found for its
 * base branch when it has been read, else an open review in the same repository whose head is its base.
 */
export function findStacks(reviews: StackInput[]): Map<string, StackPlace> {
  const id = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  const open = reviews.filter((r): r is StackInput & { repo: string; number: number } =>
    r.kind === "pr" && !!r.repo && !!r.number && r.prState !== "MERGED" && r.prState !== "CLOSED" && !r.archivedAt);
  const members = new Map<string, StackMember>(open.map((r) => [id(r.repo, r.number), {
    targetKey: r.targetKey, number: r.number, title: r.title ?? null, url: r.url ?? null, status: r.status ?? null,
    reviewed: !!(r.submittedVerdict || r.signals?.lastReviewAt || r.ownPr),
  }]));
  const parentOf = new Map<string, string>();
  for (const r of open) {
    let parent: string | undefined;
    if (r.stackParent !== undefined) {
      if (r.stackParent) {
        parent = id(r.repo, r.stackParent.number);
        if (!members.has(parent)) members.set(parent, { targetKey: null, number: r.stackParent.number, title: r.stackParent.title, url: r.stackParent.url, status: null, reviewed: false });
      }
    } else {
      const found = r.base && !longLivedBranch(r.base) ? open.find((o) => o !== r && o.repo.toLowerCase() === r.repo.toLowerCase() && o.head === r.base) : undefined;
      parent = found && id(found.repo, found.number);
    }
    if (parent && parent !== id(r.repo, r.number)) parentOf.set(id(r.repo, r.number), parent);
  }
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) childrenOf.set(parent, [...childrenOf.get(parent) ?? [], child]);
  for (const children of childrenOf.values()) children.sort((a, b) => members.get(a)!.number - members.get(b)!.number);

  const places = new Map<string, StackPlace>();
  for (const r of open) {
    const self = id(r.repo, r.number);
    if (!parentOf.has(self) && !childrenOf.has(self)) continue;
    // Down to the bottom, minding a loop of retargeted branches.
    let root = self;
    const seen = new Set([root]);
    while (parentOf.has(root) && !seen.has(parentOf.get(root)!)) { root = parentOf.get(root)!; seen.add(root); }
    const order: string[] = [];
    const walk = (node: string) => { if (order.includes(node)) return; order.push(node); for (const child of childrenOf.get(node) ?? []) walk(child); };
    walk(root);
    const parent = parentOf.get(self);
    places.set(r.targetKey, {
      members: order.map((node) => members.get(node)!), index: order.indexOf(self),
      parent: parent ? members.get(parent)! : null, children: (childrenOf.get(self) ?? []).map((node) => members.get(node)!),
    });
  }
  return places;
}
