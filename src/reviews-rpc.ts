// Reviews: the list, a review's page, and what it reads of the PR (checks, generated files, CODEOWNERS, file contents);
// starting, rebuilding, stopping, archiving, pinning, renaming and deleting a review. Also bb review list.
import { changedFiles, splitPatchByFile } from "./patch";
import { readFileContents, readGeneratedFiles } from "./file-contents";
import { readCheckFailures, readCheckLog } from "./check-annotations";
import { runReviewCommand } from "./review-command";
import { NOT_LISTED, runListCommand } from "./list-command";
import { createPrReview } from "./start-review";
import { isAssistantAnswering } from "./agent";
import { personalProjectId } from "./machines";
import { placeFacts, reviewPlaces } from "./review-places";
import { agentReadsHead } from "./agent-reads";
import { isMissingThread } from "./thread-errors";
import { ghPrChecksJsonArgs, runGh, runGit } from "./gh";
import { reviewRevision } from "./review-revision";
import { GUIDE_WORKER_TITLE, stopGuide } from "./generate";
import { pluginThreadsTitled } from "./thread-review";
import { recordFormerWorker } from "./former-workers";
import { parseChecks } from "./threads";
import { localDiffChanged, rerunReview } from "./rereview";
import { feedbackProgress, type TurnOptions } from "../lib/turn";
import { findStacks } from "../lib/stacks";
import { defaultName } from "../lib/review-name";
import { diffAt, guideBehind } from "./feedback-view";
import type { ReviewMeta } from "./store";
import { turnOptions } from "./turn-signals";
import type { RpcHandlers, ServeDeps, Subcommands } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, notifications, sync, changed, reviewOwners } = deps;
  // Reviews leave the server with whose turn they are, how far your feedback got, and their place in a stack.
  // JSON round-trips drop the literal `undefined` fields rowToMeta leaves, which strict rpc output rejects.
  // A local review with no title of its own goes by its guide's (lib/review-identity.ts): `guideTitles`, by key.
  const decorate = async (review: ReviewMeta, options: TurnOptions, stacks: ReturnType<typeof findStacks>, places: ReturnType<typeof reviewPlaces>, guideTitles: ReadonlyMap<string, string>) => JSON.parse(JSON.stringify({
    ...review, turn: await sync.turnOf(review, undefined, options), progress: feedbackProgress(review), stack: stacks.get(review.targetKey) ?? null, place: places.get(review.targetKey) ?? null,
    guideTitle: guideTitles.get(review.targetKey) ?? null,
  }));
  /** The guides' titles of `reviews`' local reviews with no title of their own. */
  const guideTitles = async (tx: Pick<typeof store, "getGuide">, reviews: readonly ReviewMeta[]) => {
    const titles = new Map<string, string>();
    for (const review of reviews) {
      const title = review.kind === "ref" && !review.title ? (await tx.getGuide(review.targetKey))?.title : undefined;
      if (title) titles.set(review.targetKey, title);
    }
    return titles;
  };
  // Whether you wrote the PR, before the sync has read it: GitHub allows only a Comment review on your own PR.
  const ownPrUnread = (review: ReviewMeta) => review.kind === "pr" && !!review.author && typeof review.ownPr !== "boolean";
  const ownPrOf = (review: ReviewMeta, login: string | null): ReviewMeta =>
    ownPrUnread(review) ? { ...review, ownPr: !!login && login.toLowerCase() === review.author!.toLowerCase() } : review;
  const withOwnPr = async (review: ReviewMeta | null) => review && ownPrUnread(review) ? ownPrOf(review, await sync.login()) : review;
  /** Every review, decorated with one read of the settings and the sync's cached login, without the summaries only the assistant reads. */
  const listed = async () => {
    const { options, all, titles } = await store.exclusive(async (tx) => {
      const all = await tx.listReviews();
      return { options: turnOptions((await tx.getPreferences()).preferences), all, titles: await guideTitles(tx, all) };
    });
    // The sync reads who you are on its passes; a list load never waits on gh for it.
    const login = all.some(ownPrUnread) ? sync.cachedLogin() : null;
    const reviews = all.map((review) => ownPrOf(review, login));
    const stacks = findStacks(reviews);
    const places = reviewPlaces(await placeFacts(bb, reviews), reviews);
    return await Promise.all(reviews.map(async ({ reviewBodies: _bodies, agentReads: _reads, ...review }) => await decorate(review, options, stacks, places, titles)));
  };
  /** A review whose diff pruneOldDiffs dropped reads it again when it's opened; returns why it couldn't. */
  async function rereadPrunedDiff(targetKey: string): Promise<string | undefined> {
    const review = await store.exclusive(async (tx) => {
      const review = await tx.getReview(targetKey);
      return review?.kind !== "pr" || review.status !== "ready" || !review.headSha || await tx.hasPatch(targetKey) ? null : { ...review, headSha: review.headSha };
    });
    if (!review) return;
    let patch: string;
    try {
      patch = await diffAt(store, runGh, review, review.headSha);
    } catch (error) {
      bb.log.warn(`Could not read the diff of ${targetKey} again: ${String(error)}`);
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      const offline = /network|connect|resolve|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN|unreachable/i.test(reason);
      return `Couldn't read this review's diff from GitHub: ${reason}. The guide, your draft and notes are here${offline ? "; try again when GitHub can be reached" : ""}.`;
    }
    await store.savePatch(targetKey, patch);
    // The page's other reads ran without it. An empty diff changed nothing, and reloading would read it again.
    if (patch) bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
  }
  const handlers = {
    async getReviewBundle({ targetKey, knownRevision }) {
      const diffError = await rereadPrunedDiff(targetKey);
      const { revision, found, listedNow } = await store.exclusive(async (tx) => ({ revision: await reviewRevision(tx, targetKey), found: await tx.getReview(targetKey), listedNow: await tx.listReviews() }));
      const owned = await withOwnPr(found);
      // As the list asks it, so the page's id is the list's.
      const facts = await placeFacts(bb, listedNow);
      // What the page shows of it, read in one turn.
      return store.exclusive(async (tx) => {
        const all = await tx.listReviews();
        const stacks = findStacks(all);
        const review = owned && await decorate(owned, turnOptions((await tx.getPreferences()).preferences), stacks, reviewPlaces(facts, all), await guideTitles(tx, [owned]));
        // Reads of a local review's earlier diff don't count toward its rebuilt one, which the client can't tell apart.
        if (review?.agentReads && review.agentReads.head !== await agentReadsHead(tx, targetKey)) review.agentReads = null;
        return { review, guide: await tx.getGuide(targetKey),
          patch: revision === knownRevision ? null : await tx.patch(targetKey), revision,
          ...(diffError ? { diffError } : {}) };
      });
    },
    async getReviewerNotes({ targetKey }) { return await store.getReviewerNotes(targetKey); },
    async saveReviewerNotes({ targetKey, body, revision }) { return await store.saveReviewerNotes(targetKey, body, revision); },

    // Panel: start a review by pasting a GitHub PR URL. The nav panel isn't
    // project-scoped, so the frontend can't reliably supply a projectId —
    // resolve one server-side (prefer the personal project, else the first).
    async startReview({ input }) {
      let projectId: string | undefined;
      try {
        projectId = await personalProjectId(bb);
      } catch {
        return { ok: false, error: "Couldn't resolve a project to run generation." };
      }
      if (!projectId) return { ok: false, error: "No project available to run generation." };
      return createPrReview(deps, { input, projectId });
    },

    // Read
    async listReviews() {
      return { reviews: await listed(), sync: sync.health() };
    },
    async refreshReviews(input) {
      await sync.all(input?.force ?? true);
      return { reviews: await listed(), sync: sync.health() };
    },
    async getChecks({ targetKey }) {
      const m = await store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number) return { bucket: "none", checks: [] };
      const r = await runGh(ghPrChecksJsonArgs(m.number, m.repo));
      const parsed = parseChecks([0, 1, 8].includes(r.code) ? r.stdout : "");
      return { bucket: parsed.bucket, checks: parsed.checks };
    },
    async getCheckFailures({ targetKey }) {
      const review = await store.getReview(targetKey);
      return { failures: review ? await readCheckFailures(runGh, review) : [] };
    },
    async getCheckLog({ targetKey, runId }) {
      const read = await store.exclusive(async (tx) => (await tx.getPreferences()).preferences.knobs.checkFailureActions ? { review: await tx.getReview(targetKey) } : null);
      if (!read) return { ok: false, error: "Asking about a failing check is off in Settings." };
      if (!read.review) return { ok: false, error: "This review no longer exists." };
      return readCheckLog(runGh, read.review, runId);
    },
    async getGeneratedFiles({ targetKey }) {
      const read = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        return review && { review, patch: await tx.patch(targetKey) };
      });
      if (!read) return { files: [] };
      return { files: await readGeneratedFiles({ runGh, runGit, bb }, read.review, changedFiles(read.patch)) };
    },
    async getCodeOwners({ targetKey }) {
      const read = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        return review && { review, patch: await tx.patch(targetKey) };
      });
      if (!read) return { files: [] };
      try { return { files: await reviewOwners(read.review, changedFiles(read.patch)) }; }
      catch (error) { return { files: [], error: error instanceof Error ? error.message : "Couldn’t read CODEOWNERS." }; }
    },
    async getFileContents({ targetKey, file }) {
      const read = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        return review && { review, patch: await tx.patch(targetKey) };
      });
      if (!read) return { ok: false as const, error: "This review no longer exists." };
      const { review } = read;
      const patchFile = splitPatchByFile(read.patch).find((f) => f.path === file);
      if (!patchFile) return { ok: false as const, error: `${file} isn’t in this review’s diff.` };
      return readFileContents({ runGh, runGit, bb }, review, patchFile);
    },

    // Staleness and re-review, and the review's place in the list
    async checkForUpdates({ targetKey }) {
      // The sync records the PR's head when it reads it, at most a minute ago.
      await sync.one(targetKey);
      const { m, localDiffChanges } = await store.exclusive(async (tx) => {
        const m = await tx.getReview(targetKey);
        return { m, localDiffChanges: m?.kind === "ref" && (await tx.getPreferences()).preferences.knobs.localDiffChanges };
      });
      // A local review has no commits to read: its diff, run again, says whether its code changed.
      if (m?.kind === "ref") {
        const changed = localDiffChanges && await localDiffChanged(deps, m);
        return { hasNewCommits: false, ...(changed ? { localChanged: true } : {}) };
      }
      if (!m || m.kind !== "pr" || !m.number || m.archivedAt || !m.latestHeadSha) return { hasNewCommits: false };
      const baseChanged = m.base && m.latestBase && m.latestBase !== m.base ? { baseChanged: { from: m.base, to: m.latestBase } } : {};
      return { hasNewCommits: !!m.headSha && guideBehind(m), current: m.latestHeadSha, ...(m.headSha ? { stored: m.headSha } : {}), ...baseChanged };
    },
    async rereview({ targetKey }) {
      await sync.one(targetKey, true);
      const answered = await store.exclusive(async (tx) => {
        // An archived PR keeps the guide it has; one whose first guide stopped or failed can still build it.
        if ((await tx.getReview(targetKey))?.archivedAt && await tx.getGuide(targetKey)) return { ok: false, error: "This PR is archived. Its guide and conversation are still available." };
        // Reading the PR may have started an automatic rebuild already.
        if ((await tx.getReview(targetKey))?.status === "generating") return { ok: true };
        return null;
      });
      // A rebuild that started since is found, in the turn that would begin the guide.
      return answered ?? rerunReview(deps, targetKey);
    },
    async stopGuide({ targetKey }) {
      if (!(await store.getPreferences()).preferences.knobs.stopGenerating) return { ok: false, error: "Stopping a guide is off in Settings." };
      // No alert either way: you stopped it.
      return await stopGuide(bb, store, targetKey) === "restored" ? { ok: true, restored: true } : { ok: true };
    },
    async archiveReview({ targetKey, archived }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
        await tx.setLifecycle(targetKey, { userArchivedAt: archived ? Date.now() : null });
        changed(targetKey);
        return { ok: true };
      });
    },
    async pinReview({ targetKey, pinned }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
        await tx.setLifecycle(targetKey, { pinnedAt: pinned ? Date.now() : null });
        changed(targetKey);
        return { ok: true };
      });
    },
    async renameReview({ targetKey, name }) {
      return store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        if (!review) return { ok: false, error: "This review no longer exists." };
        // No name, or the one it has anyway, goes back to the PR's title or ref.
        await tx.setLifecycle(targetKey, { name: name && name !== defaultName(review) ? name : null });
        changed(targetKey);
        return { ok: true };
      });
    },
    async deleteReview({ targetKey }) {
      const review = await store.getReview(targetKey);
      if (!review) return { ok: true };
      // A guide worker can't be cancelled per review, and an answer in progress is the reviewer's to finish.
      if (review.status === "generating") return { ok: false, error: "Wait for the guide to finish generating, then delete the review." };
      if (await isAssistantAnswering(bb, store, targetKey)) return { ok: false, error: "Wait for the assistant to finish answering, then delete the review." };
      // Its guide writers too: the current one, and older ones left archived, by their exact title.
      const writers = await pluginThreadsTitled(bb, `${GUIDE_WORKER_TITLE}${targetKey}`).catch((error) => {
        bb.log.warn(`Could not list the guide writers of ${targetKey}: ${String(error)}`);
        return [];
      });
      // Its threads are read in the turn that deletes it, so a thread recorded meanwhile is stopped with them.
      const { writerIds, threadIds } = await store.exclusive(async (tx) => {
        const writerIds = new Set([await tx.generationWorker(targetKey), ...writers]);
        const threadIds = new Set([await tx.getAssistantThread(targetKey), await tx.getAgentThread(targetKey), ...writerIds]);
        await tx.deleteReview(targetKey);
        // Discovery won't add a PR you deleted back to the list; starting it again does.
        if (review.kind === "pr") await tx.ignoreDiscovery(targetKey);
        return { writerIds, threadIds };
      });
      await notifications.dismiss(targetKey).catch(() => {});
      changed(targetKey);
      await notifications.forget(targetKey).catch(() => {});
      for (const threadId of threadIds) {
        if (!threadId) continue;
        // A thread a failed stop or delete may leave running is kept to this review, as a replaced agent is.
        let left = false;
        await bb.sdk.threads.stop({ threadId }).catch((error) => { left ||= !isMissingThread(error); });
        await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: false }).catch((error) => {
          if (isMissingThread(error)) return;
          left = true;
          bb.log.warn(`Could not delete review thread ${threadId}: ${String(error)}`);
        });
        if (left) await recordFormerWorker(bb, threadId, targetKey, writerIds.has(threadId) ? "writer" : "assistant");
      }
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;
  const commands = {
    async list(args, ctx, ownReview) {
      if (!(await store.getPreferences()).preferences.knobs.reviewCommandInThreads) return runReviewCommand(deps, ["list", ...args], ctx, ownReview);
      return ownReview === undefined ? runListCommand(await listed(), args) : { exitCode: 2, stderr: NOT_LISTED };
    },
  } satisfies Subcommands;
  return { handlers, commands };
}
