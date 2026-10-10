import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta, Store } from "./store";
import { parseTarget, targetKey } from "./targets";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { readPrSnapshot } from "./pr-snapshot";
import { rebuildReview, upToDate } from "./rereview";

interface Deps {
  bb: BbPluginApi;
  store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

// Panel-driven counterpart to review-command.ts's PR branch: a user pastes a
// full GitHub PR URL into the panel instead of running `bb review` in a
// terminal. Only full PR URLs are accepted here — a bare PR number or local
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
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the PR." };
  }
  const { pr, patch } = snapshot;

  const key = targetKey(target);
  const now = Date.now();

  const existing = deps.store.getReview(key);
  // A review already building, or showing this diff, just opens.
  if (existing && (existing.status === "generating" || upToDate(deps.store, existing, pr.headRefOid, patch))) {
    if (existing.userArchivedAt) deps.store.setLifecycle(key, { userArchivedAt: null });
    return { ok: true, targetKey: key };
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
    createdAt: now,
  };
  // An existing review rebuilds as Re-review does, keeping its guide and comments.
  if (existing) {
    rebuildReview(deps, meta, patch);
    return { ok: true, targetKey: key };
  }
  deps.store.saveReview(meta);
  deps.store.savePatch(key, ensureGitHeaders(patch));
  // Starting a PR again brings it back into discovery after a delete.
  deps.store.unignoreDiscovery(key);

  // Fire-and-forget generation; the panel refetches on the realtime signal.
  void generateGuide(deps.bb, deps.store, key, args.projectId);

  return { ok: true, targetKey: key };
}
