import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { reanchorDraft, type ReviewMeta } from "./store";
import { ensureGitHeaders } from "./patch";
import { beginGuide, guideWriterUnavailable } from "./generate";
import { gitDiffArgs } from "./gh";
import { readPrSnapshot } from "./pr-snapshot";
import { pruneDiffs } from "./feedback-view";
import { skipRun } from "./agent";
import { mayRunUnattended } from "../lib/trust";
import { existsSync } from "node:fs";
import type { AsyncStore } from "./store-queue";
import { readForGuide } from "./feature-review";

interface Deps {
  bb: BbPluginApi; store: AsyncStore;
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
  const m = await deps.store.getReview(targetKey);
  if (!m || !m.projectId) return { ok: false, error: "Unknown review or missing project." };
  const unavailable = await guideWriterUnavailable(deps.bb, deps.store);
  if (unavailable) return { ok: false, error: unavailable };

  let patch = "";
  let saveRead: ((tx: AsyncStore) => Promise<void>) | undefined;
  if (m.kind === "pr" && m.number && m.repo) {
    try {
      const snapshot = await readPrSnapshot(deps.gh.runGh, m.number, m.repo);
      // Unattended, the head read now reaches the guide writer only from a trusted author, or one you started agents on.
      if (options.unattended && await deps.store.exclusive(async (tx) => {
        if (mayRunUnattended(m, (await tx.getPreferences()).preferences, snapshot.pr.headRefOid)) return false;
        await skipRun(deps.bb, tx, targetKey, "guide", snapshot.pr.headRefOid);
        return true;
      })) {
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
  } else if (m.feature && m.kind === "ref") {
    // A folder's review reads its folder, on whichever machine it's on, and keeps what it read with the guide.
    const read = await readForGuide(deps.bb, m);
    if (!read || "error" in read) return { ok: false, error: read?.error ?? "Review has no re-runnable target." };
    patch = read.patch;
    saveRead = read.save;
  } else if (m.kind === "ref" && m.gitRef) {
    if (!m.cwd) return { ok: false, error: "Rebuilding a local review's guide needs its original working dir; re-run `bb review` in the terminal." };
    const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
    if (diff.code !== 0) return { ok: false, error: diff.stderr || "git diff failed" };
    patch = diff.stdout;
  } else {
    return { ok: false, error: "Review has no re-runnable target." };
  }
  if (!patch.trim()) return { ok: false, error: "No changes found." };
  const projectId = m.projectId;
  // Checked and started in one turn, so a second start finds this one.
  let run: (() => Promise<void>) | undefined;
  try {
    return await deps.store.exclusive(async (tx) => {
      // The review may have been deleted while GitHub answered; don't bring it back.
      if (!await tx.getReview(targetKey)) return { ok: false, error: "This review was deleted." };
      // A guide started while GitHub or git answered, as by bb review, is building this review already: one writer, not two.
      if ((await tx.getReview(targetKey))?.status === "generating") return { ok: true };
      run = await rebuildReview(deps, tx, { ...m, projectId }, patch, options);
      await saveRead?.(tx);
      return { ok: true };
    });
  } finally {
    void run?.();
  }
}

/**
 * Rebuild an existing review's guide for a new diff, in the caller's block, `tx`, keeping the current guide in case it
 * fails and moving the draft comments. It begins the guide (beginGuide), so call it last in the block, and start the
 * run it returns once the block has ended.
 */
export async function rebuildReview(deps: Pick<Deps, "bb" | "store">, tx: AsyncStore, m: ReviewMeta & { projectId: string }, patch: string, options: { notify?: boolean; unattended?: boolean } = {}): Promise<() => Promise<void>> {
  const targetKey = m.targetKey;
  const previous = await tx.patch(targetKey);
  // If the new guide fails, the current one comes back.
  await tx.backupGuide(targetKey);
  const next = ensureGitHeaders(patch);
  await tx.savePatch(targetKey, next);
  await tx.saveReview({ ...m, status: "generating" });
  if (m.headSha) await tx.saveSnapshot(targetKey, m.headSha, next);
  // Unsent draft comments follow their lines into the new diff; ones whose lines are gone stay flagged.
  await tx.rebaseDraftComments(targetKey, await reanchorDraft(tx, targetKey, previous, next));
  await pruneDiffs(tx, (await tx.getReview(targetKey))!);
  return beginGuide(deps.bb, tx, deps.store, targetKey, m.projectId, options);
}

/**
 * Update: read a local review's code again and show it, the comments following their lines, without the guide writer.
 * The guide stays as it was written; Rewrite guide (rerunReview) writes a new one.
 */
export async function updateReview(deps: Pick<Deps, "store" | "gh">, targetKey: string): Promise<{ ok: boolean; error?: string }> {
  const m = await deps.store.getReview(targetKey);
  if (!m) return { ok: false, error: "This review no longer exists." };
  if (m.kind !== "ref" || !m.gitRef) return { ok: false, error: "Only a local review updates without its guide. Use Update guide." };
  if (!m.cwd) return { ok: false, error: "Updating a local review needs its original working dir; re-run `bb review` in the terminal." };
  const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
  if (diff.code !== 0) return { ok: false, error: diff.stderr || "git diff failed" };
  if (!diff.stdout.trim()) return { ok: false, error: "No changes found." };
  return deps.store.exclusive(async (tx) => {
    const now = await tx.getReview(targetKey);
    if (!now) return { ok: false, error: "This review was deleted." };
    // The guide being written is for the diff it was given: an Update meanwhile would show it another.
    if (now.status === "generating") return { ok: false, error: "The guide writer is writing this review’s guide. Update once it’s done." };
    const previous = await tx.patch(targetKey);
    const next = ensureGitHeaders(diff.stdout);
    await tx.savePatch(targetKey, next);
    // The comments follow their lines into the new diff, as on a rebuild.
    await tx.rebaseDraftComments(targetKey, await reanchorDraft(tx, targetKey, previous, next));
    await pruneDiffs(tx, now);
    return { ok: true };
  });
}

/**
 * Whether a local review's diff, run again in its checkout, is no longer the one its guide was written for. False while
 * its guide is building, and when the diff can't be run, as without its checkout, or comes back empty.
 */
export async function localDiffChanged(deps: Pick<Deps, "store" | "gh">, m: ReviewMeta): Promise<boolean> {
  if (m.kind !== "ref" || m.status !== "ready" || !m.gitRef || !m.cwd || !existsSync(m.cwd)) return false;
  const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
  if (diff.code !== 0 || !diff.stdout.trim()) return false;
  return await deps.store.patch(m.targetKey) !== ensureGitHeaders(diff.stdout);
}

/** Whether a review already shows this diff: its guide is ready, at the same head, for the same patch. */
export async function upToDate(store: AsyncStore, m: ReviewMeta, headSha: string | undefined, patch: string): Promise<boolean> {
  return store.exclusive(async (tx) => {
    return m.status === "ready" && !!await tx.getGuide(m.targetKey) && m.headSha === headSha
      && await tx.patch(m.targetKey) === ensureGitHeaders(patch);
  });
}
