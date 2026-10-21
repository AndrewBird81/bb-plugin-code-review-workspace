import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { parseTarget, prReviewKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { beginGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";
import { rebuildReview, upToDate } from "./rereview";
import type { AsyncStore } from "./store-queue";

interface Deps {
  bb: BbPluginApi;
  store: AsyncStore;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

/**
 * The PR's state as gh read it at the start, so the automatic review knows a merged or closed PR before the sync reads
 * it. The sync's later read replaces it. It isn't prState, which the sync stops reading once it's MERGED.
 */
export async function recordPrState(store: AsyncStore, targetKey: string, state: string | undefined): Promise<void> {
  if (state === "OPEN" || state === "CLOSED" || state === "MERGED") await store.setLifecycle(targetKey, { startedPrState: state });
}

// Panel-driven counterpart to review-command.ts's PR branch: a user pastes a
// full GitHub PR URL into the panel instead of running `bb review` in a
// terminal. Only a PR's URL or owner/repo#n is accepted here — a bare PR number or local
// git ref needs a project-scoped cwd/branch that the nav panel doesn't have,
// so those still route through the CLI.
export async function createPrReview(
  deps: Deps,
  args: { input: string; projectId: string },
): Promise<{ ok: boolean; error?: string; targetKey?: string }> {
  const target = parseTarget(args.input);
  if (target.kind !== "pr" || !target.repo) {
    return {
      ok: false,
      error:
        "Paste a full GitHub PR URL (github.com/owner/repo/pull/N). For a PR number or local ref, run `bb review` in a terminal.",
    };
  }

  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { ok: false, error: unavailable };

  let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
  try {
    snapshot = await readPrSnapshot(deps.gh.runGh, target.number, target.repo);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Couldn't load the PR." };
  }
  const { pr, patch } = snapshot;

  const now = Date.now();
  // Open pages hear of a review started, rebuilding, or back from Archive at once, not when its guide is done.
  const told = (key: string) => {
    deps.bb.realtime.publish(`review:${key}`, { ts: now });
    deps.bb.realtime.publish("reviews", { ts: now });
  };

  // What it finds and what it starts, in one turn, so a second start finds this one.
  let run: (() => Promise<void>) | undefined;
  let started: { key: string; told: boolean };
  try {
    started = await deps.store.exclusive(async (tx) => {
      const key = await prReviewKey(tx, { repo: target.repo!, number: target.number });
      const existing = await tx.getReview(key);
      // A review already building, or showing this diff, just opens.
      if (existing && (existing.status === "generating" || await upToDate(tx, existing, pr.headRefOid, patch))) {
        if (existing.userArchivedAt) await tx.setLifecycle(key, { userArchivedAt: null });
        return { key, told: !!existing.userArchivedAt };
      }
      const meta: ReviewMeta & { projectId: string } = {
        targetKey: key,
        kind: "pr",
        number: target.number,
        repo: target.repo,
        title: pr.title,
        author: pr.author?.login,
        base: pr.baseRefName,
        head: pr.headRefName,
        url: pr.url,
        gitRef: `${pr.baseRefName}...${pr.headRefName}`,
        headSha: pr.headRefOid,
        projectId: args.projectId,
        status: "generating",
        // Starting it again keeps when the review was created.
        createdAt: existing?.createdAt ?? now,
      };
      // An existing review rebuilds as Re-review does, keeping its guide and comments.
      if (existing) {
        await recordPrState(tx, key, pr.state);
        run = await rebuildReview(deps, tx, meta, patch);
        return { key, told: true };
      }
      await tx.saveReview(meta);
      await recordPrState(tx, key, pr.state);
      await tx.savePatch(key, ensureGitHeaders(patch));
      // Starting a PR again brings it back into discovery after a delete.
      await tx.unignoreDiscovery(key);
      // The panel refetches on the realtime signal.
      run = await beginGuide(deps.bb, tx, deps.store, key, args.projectId);
      return { key, told: true };
    });
  } finally {
    // Its guide builds on, after the turn that began it.
    void run?.();
  }
  if (started.told) told(started.key);
  return { ok: true, targetKey: started.key };
}
