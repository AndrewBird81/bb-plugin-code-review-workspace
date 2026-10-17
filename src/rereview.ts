import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { reanchorAll, type ReviewMeta, type Store } from "./store";
import { ensureGitHeaders } from "./patch";
import { generateGuide, guideWriterUnavailable } from "./generate";
import { gitDiffArgs } from "./gh";
import { readPrSnapshot } from "./pr-snapshot";
import { pruneDiffs } from "./feedback-view";
import { skipRun } from "./agent";
import { mayRunUnattended } from "../lib/trust";
import { existsSync } from "node:fs";

interface Deps {
  bb: BbPluginApi; store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

const rerunning = new WeakMap<BbPluginApi, Set<string>>();

/** Re-read the target and regenerate its guide. `notify: false` leaves alerts to the turn that asked for it. */
export async function rerunReview(deps: Deps, targetKey: string, options: { notify?: boolean; unattended?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  // A re-review already reading the target starts the guide for both callers.
  const running = rerunning.get(deps.bb) ?? new Set<string>();
  rerunning.set(deps.bb, running);
  if (running.has(targetKey)) return { ok: true };
  running.add(targetKey);
  try {
    return await rerun(deps, targetKey, options);
  } finally {
    running.delete(targetKey);
  }
}

async function rerun(deps: Deps, targetKey: string, options: { notify?: boolean; unattended?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const m = deps.store.getReview(targetKey);
  if (!m || !m.projectId) return { ok: false, error: "Unknown review or missing project." };
  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { ok: false, error: unavailable };

  let patch = "";
  if (m.kind === "pr" && m.number && m.repo) {
    try {
      const snapshot = await readPrSnapshot(deps.gh.runGh, m.number, m.repo);
      // Unattended, the head read now reaches the guide writer only from a trusted author, or one you started agents on.
      if (options.unattended && !mayRunUnattended(m, deps.store.getPreferences().preferences, snapshot.pr.headRefOid)) {
        skipRun(deps.bb, deps.store, targetKey, "guide", snapshot.pr.headRefOid);
        return { ok: false, error: "The PR's author isn't trusted to start agents on its new commits; it waits for your click." };
      }
      patch = snapshot.patch;
      m.headSha = snapshot.pr.headRefOid;
      m.base = snapshot.pr.baseRefName;
      m.head = snapshot.pr.headRefName;
      m.gitRef = `${m.base}...${m.head}`;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Couldn't load the PR." };
    }
  } else if (m.kind === "ref" && m.gitRef) {
    if (!m.cwd) return { ok: false, error: "Rebuilding a local review's guide needs its original working dir; re-run `bb review` in the terminal." };
    const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
    if (diff.code !== 0) return { ok: false, error: diff.stderr || "git diff failed" };
    patch = diff.stdout;
  } else {
    return { ok: false, error: "Review has no re-runnable target." };
  }
  if (!patch.trim()) return { ok: false, error: "No changes found." };
  // The review may have been deleted while GitHub answered; don't bring it back.
  if (!deps.store.getReview(targetKey)) return { ok: false, error: "This review was deleted." };
  // A guide started while GitHub or git answered, as by bb review, is building this review already: one writer, not two.
  if (deps.store.getReview(targetKey)?.status === "generating") return { ok: true };
  rebuildReview(deps, { ...m, projectId: m.projectId }, patch, options);
  return { ok: true };
}

/** Rebuild an existing review's guide for a new diff, keeping the current guide in case it fails and moving the draft comments. */
export function rebuildReview(deps: Pick<Deps, "bb" | "store">, m: ReviewMeta & { projectId: string }, patch: string, options: { notify?: boolean; unattended?: boolean } = {}) {
  const targetKey = m.targetKey;
  const previous = deps.store.patch(targetKey);
  // If the new guide fails, the current one comes back.
  deps.store.backupGuide(targetKey);
  const next = ensureGitHeaders(patch);
  deps.store.savePatch(targetKey, next);
  deps.store.saveReview({ ...m, status: "generating" });
  if (m.headSha) deps.store.saveSnapshot(targetKey, m.headSha, next);
  // Unsent draft comments follow their lines into the new diff; ones whose lines are gone stay flagged.
  deps.store.rebaseDraftComments(targetKey, reanchorAll(deps.store, targetKey, previous, next));
  pruneDiffs(deps.store, deps.store.getReview(targetKey)!);
  void generateGuide(deps.bb, deps.store, targetKey, m.projectId, options);
}

/**
 * Whether a local review's diff, run again in its checkout, is no longer the one its guide was written for. False while
 * its guide is building, and when the diff can't be run, as without its checkout, or comes back empty.
 */
export async function localDiffChanged(deps: Pick<Deps, "store" | "gh">, m: ReviewMeta): Promise<boolean> {
  if (m.kind !== "ref" || m.status !== "ready" || !m.gitRef || !m.cwd || !existsSync(m.cwd)) return false;
  const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
  if (diff.code !== 0 || !diff.stdout.trim()) return false;
  return deps.store.patch(m.targetKey) !== ensureGitHeaders(diff.stdout);
}

/** Whether a review already shows this diff: its guide is ready, at the same head, for the same patch. */
export function upToDate(store: Store, m: ReviewMeta, headSha: string | undefined, patch: string): boolean {
  return m.status === "ready" && !!store.getGuide(m.targetKey) && m.headSha === headSha
    && store.patch(m.targetKey) === ensureGitHeaders(patch);
}
