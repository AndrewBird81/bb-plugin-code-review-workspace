// A review's local draft and its Submit: comments, discussions and asks, the summary and verdict, and the files you
// marked Viewed. Also bb review comment and bb review summary.
import { undoable, undoChange } from "./draft-comments";
import { rangeOf, sameLocation, severityOf, type Draft } from "./draft";
import { summaryLine, withSummaryLine } from "../lib/move-to-summary";
import { runSummaryCommand } from "./summary-command";
import { askAgent } from "./discussions";
import { clearAsks, setAsk } from "./asks";
import { digDeeper } from "./deep-dive";
import { runCommentCommand } from "./comment-command";
import { computeFileViewState } from "./file-views";
import { requireReviewRevision } from "./review-revision";
import { invalidComments, rangeProblem } from "./review-positions";
import { pruneDiffs } from "./feedback-view";
import { noteReviewerRemoval, noteReviewerSave, recordOutcomes } from "./learning";
import type { AsyncStore } from "./store-queue";
import { DRAFT_CHANGED, type SubmitWarning } from "./submit-review";
import type { RpcHandlers, ServeDeps, Subcommands } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, submitReview, notifications, sync, changed } = deps;
  // The draft, its comments drafted against an older diff (which Submit warns about), and the discussions at its lines and summary.
  const draftState = async (store: AsyncStore, targetKey: string, given?: Draft) => {
    return store.exclusive(async (tx) => {
      const draft = given ?? await tx.getDraft(targetKey);
      const canUndo = undoable(tx, targetKey);
      const stale = (await tx.staleDraftComments(targetKey)).map(({ file, line, side }) => ({ file, line, side }));
      const discussions = [];
      for (const d of await tx.listDiscussions(targetKey)) discussions.push(await canUndo(d) ? { ...d, undoable: true } : d);
      return { draft, stale, discussions };
    });
  };

  /**
   * Submit the draft to GitHub, then record what follows: the page's Submit, and the review agent's. `alone`, a Ready to
   * approve row's: `summary` alone, the draft and what's about it staying.
   */
  async function submit(targetKey: string, revision: string | undefined, account: string | undefined, comments: Parameters<typeof submitReview>[3], summary: Parameters<typeof submitReview>[4], force?: boolean | readonly SubmitWarning[], { alone = false, reviewed }: { alone?: boolean; reviewed?: string } = {}) {
    // The draft the submitter checks next. A change between the two reads fails its check against the page's draft.
    const submitted = await store.getDraft(targetKey);
    const result = await submitReview(targetKey, revision, account, comments, summary, { force, alone, ...(reviewed === undefined ? {} : { reviewed }) });
    // The discussions were about this draft. The assistant's conversation keeps them.
    // GitHub has the review and it's recorded: what follows failing mustn't fail the Submit.
    if (result.ok) {
      try {
        await store.exclusive(async (tx) => {
          if (!alone) {
            await recordOutcomes(tx, targetKey, submitted);
            await tx.clearDiscussions(targetKey);
            await clearAsks(tx, targetKey);
          }
          bb.realtime.publish(`draft:${targetKey}`, {});
          const review = (await tx.getReview(targetKey))!;
          // The diff you reviewed is what "since your review" compares against.
          if (review.headSha) await tx.saveSnapshot(targetKey, review.headSha, await tx.patch(targetKey));
          await pruneDiffs(tx, review);
          // Your review answers whatever turn was holding, and what didn't run on its own for it.
          await tx.setLifecycle(targetKey, { heldTurn: null, skippedRun: null });
        });
        await notifications.dismiss(targetKey).catch(() => {});
        await sync.evaluate(targetKey);
      } catch (error) {
        bb.log.warn(`Could not finish recording the review of ${targetKey} GitHub took: ${String(error)}`);
      }
    }
    changed(targetKey);
    return result;
  }

  const handlers = {
    // Draft and submit
    async getDraft({ targetKey }) {
      return await draftState(store, targetKey);
    },
    // The server's own fields a page sends back with a comment it read: the saved comment's stand.
    async saveDraftComment({ targetKey, comment: { startLine, startSide, severity, body, id: _id, state: _state, sendN: _sendN, claim: _claim, editedBy: _editedBy, ...input }, revision, replaces }) {
      return store.exclusive(async (tx) => {
        await requireReviewRevision(tx, targetKey, revision);
        const comment = { ...input, ...rangeOf({ ...input, startLine, startSide }), ...severityOf(body, severity) };
        // GitHub refuses a comment on a line the diff doesn't show; say so now, not at submit.
        if (invalidComments(await tx.diffPositions(targetKey), [{ ...comment, startLine: undefined }]).length) {
          throw new Error(`${comment.file}:${comment.line} isn’t in the current diff. Choose a line the diff shows.`);
        }
        // Only a range needs the diff's rows.
        const range = comment.startLine === undefined ? null : rangeProblem(await tx.patch(targetKey), comment);
        if (range) throw new Error(range);
        // A new comment's box doesn't replace a comment it didn't show, such as the agent's, written as you wrote.
        if (replaces !== undefined && ((await tx.getDraft(targetKey)).comments.find((c) => sameLocation(c, comment))?.body ?? null) !== replaces) {
          throw new Error(`The comment on ${comment.file}:${comment.line} changed as you wrote, so yours isn’t saved yet. Read it, then save yours to replace it.`);
        }
        // Your words now, and an ask on the comment is over.
        await setAsk(tx, targetKey, comment, null);
        await noteReviewerSave(tx, targetKey, comment);
        const saved = await draftState(tx, targetKey, await tx.upsertDraftComment(targetKey, comment));
        // Another window of the review, perhaps with this comment's box open, reads it again.
        bb.realtime.publish(`draft:${targetKey}`, {});
        return saved;
      });
    },
    async removeDraftComment({ targetKey, file, line, side }) {
      return store.exclusive(async (tx) => {
        await noteReviewerRemoval(tx, targetKey, { file, line, side });
        // Already gone, for example deleted by an agent: the current draft shows that.
        const draft = await tx.deleteDraftComment(targetKey, { file, line, side }) ?? await tx.getDraft(targetKey);
        await tx.deleteDiscussion(targetKey, { file, line, side });
        await setAsk(tx, targetKey, { file, line, side }, null);
        // Another window of the review stops showing it.
        bb.realtime.publish(`draft:${targetKey}`, {});
        return await draftState(tx, targetKey, draft);
      });
    },
    async askAgent({ targetKey, ...input }) {
      const { started } = await askAgent(bb, store, targetKey, input);
      if (started) bb.realtime.publish(`conversation:${targetKey}`, {});
      return await draftState(store, targetKey);
    },
    async digDeeper({ targetKey, chapterId }) {
      if (!(await store.getPreferences()).preferences.knobs.digDeeper) return { ok: false, error: "Dig deeper is off in Settings. Use Ask agent." };
      let started: boolean;
      try { ({ started } = await digDeeper(bb, store, targetKey, chapterId)); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The agent couldn’t start." }; }
      if (started) bb.realtime.publish(`conversation:${targetKey}`, {});
      // The chapter says the agent is digging into it.
      bb.realtime.publish(`review:${targetKey}`, { ts: Date.now() });
      return { ok: true };
    },
    async dismissDiscussion({ targetKey, file, line, side }) {
      return store.exclusive(async (tx) => {
        await tx.deleteDiscussion(targetKey, { file, line, side });
        // Dismissed, the ask there is withdrawn.
        await setAsk(tx, targetKey, { file, line, side }, null);
        return await draftState(tx, targetKey);
      });
    },
    async undoAgentChange({ targetKey, file, line, side }) {
      return store.exclusive(async (tx) => {
        const result = await undoChange(tx, targetKey, { file, line, side });
        if (!result.ok) throw new Error(result.error);
        bb.realtime.publish(`draft:${targetKey}`, {});
        return await draftState(tx, targetKey);
      });
    },
    async setRemovalReason({ targetKey, file, line, side, reason, note }) {
      return store.exclusive(async (tx) => {
        if (!(await tx.getPreferences()).preferences.knobs.removalReasons) return { ok: false };
        const ok = await tx.setRemovalReason(targetKey, { file, line, side }, { reason, ...(note ? { note } : {}) });
        // Settings counts the reasons of submitted reviews' removals.
        if (ok) bb.realtime.publish("learning", {});
        return { ok };
      });
    },
    // The summary and verdict don't depend on the diff, so they save while it changes; submit checks everything.
    async setVerdict({ targetKey, verdict }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) throw new Error("This review no longer exists.");
        const draft = await tx.setVerdict(targetKey, verdict);
        bb.realtime.publish(`draft:${targetKey}`, {});
        return { draft };
      });
    },
    async saveSummary({ targetKey, body }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) throw new Error("This review no longer exists.");
        // Your words now, whoever wrote them before, and an ask on the summary is over.
        await tx.setLifecycle(targetKey, { summaryAsk: null });
        const draft = await tx.updateSummary(targetKey, { body, bodyAuthor: undefined, written: undefined });
        bb.realtime.publish(`draft:${targetKey}`, {});
        return await draftState(tx, targetKey, draft);
      });
    },
    async moveToSummary({ targetKey, revision, file, line, side }) {
      return store.exclusive(async (tx) => {
        if (!(await tx.getPreferences()).preferences.knobs.moveToSummary) throw new Error("Move to summary is off in Settings. Edit or remove the comment instead.");
        await requireReviewRevision(tx, targetKey, revision);
        const at = { file, line, side };
        // Only a comment the diff left behind: one on the current diff is edited or removed.
        const comment = (await tx.staleDraftComments(targetKey)).find((c) => sameLocation(c, at));
        if (!comment) throw new Error(`The comment on ${file}:${line} isn’t on an older diff. Edit or remove it instead.`);
        const body = withSummaryLine((await tx.getDraft(targetKey)).body, summaryLine(comment, (await tx.getPreferences()).preferences.knobs.preExistingFindings));
        if (body.length > 65_000) throw new Error("The summary would be too long. Shorten it, or edit the comment instead.");
        // As saveSummary does: your words now, and an ask on the summary is over. The line goes in before the comment
        // goes, so nothing in between can lose it.
        await tx.setLifecycle(targetKey, { summaryAsk: null });
        await tx.updateSummary(targetKey, { body, bodyAuthor: undefined, written: undefined });
        // Moved, not removed: learning doesn't count it. Its discussion and ask go with it, as with Remove.
        const draft = await tx.deleteDraftComment(targetKey, at) ?? await tx.getDraft(targetKey);
        await tx.deleteDiscussion(targetKey, at);
        await setAsk(tx, targetKey, at, null);
        bb.realtime.publish(`draft:${targetKey}`, {});
        return await draftState(tx, targetKey, draft);
      });
    },
    async submitReview({ targetKey, revision, account, comments, body, verdict, force, asComment }) {
      if (!account) return { ok: false, error: "Verify your GitHub account before submitting. Reload this review to check access." };
      if (!revision) return { ok: false, error: "This review changed in another window. Open the latest diff before saving or submitting feedback. Your text is still here." };
      // Submit as Comment: the verdict the page showed becomes Comment, in the draft it's checked against, and goes
      // back if the review didn't post.
      const shownVerdict = verdict;
      if (asComment && verdict !== "COMMENT") {
        const switched = await store.exclusive(async (tx) => {
          const draft = await tx.getDraft(targetKey);
          if (draft.verdict !== verdict || draft.body !== body) return false;
          await tx.setVerdict(targetKey, "COMMENT");
          return true;
        });
        if (!switched) return { ok: false, error: DRAFT_CHANGED };
        verdict = "COMMENT";
      }
      const { ok, error, url, warning, warnings, offers, newCommits } = await submit(targetKey, revision, account, comments, { body, verdict }, force);
      if (!ok && verdict !== shownVerdict) await store.exclusive(async (tx) => {
        const draft = await tx.getDraft(targetKey);
        if (draft.verdict === "COMMENT" && draft.body === body) await tx.setVerdict(targetKey, shownVerdict);
      });
      if (verdict !== shownVerdict) bb.realtime.publish(`draft:${targetKey}`, {});
      return { ok, ...(error ? { error } : {}), ...(url ? { url } : {}), ...(warning ? { warning } : {}), ...(warnings ? { warnings } : {}), ...(offers ? { offers } : {}), ...(newCommits ? { newCommits } : {}) };
    },

    // Per-file "Viewed" state (viewed/stale computed against the patch)
    async getFileViews({ targetKey }) {
      return store.exclusive(async (tx) => {
        return { views: computeFileViewState(await tx.getFileViews(targetKey), await tx.fileHashes(targetKey)) };
      });
    },
    async setFileViewed({ targetKey, file, viewed }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) return { ok: false };
        if (!viewed) {
          await tx.unsetFileViewed(targetKey, file);
          return { ok: true };
        }
        const hash = (await tx.fileHashes(targetKey)).current([file]).get(file);
        if (!hash) return { ok: false };
        await tx.setFileViewed(targetKey, file, hash);
        return { ok: true };
      });
    },
    async setFilesViewed({ targetKey, files, viewed = true, previous = [] }) {
      return store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) return { ok: false };
        if (!viewed) {
          const before = new Map(previous.map((view) => [view.file, view]));
          for (const file of files) {
            const view = before.get(file);
            if (view) await tx.setFileViewed(targetKey, file, view.hash, view.viewedAt);
            else await tx.unsetFileViewed(targetKey, file);
          }
          return { ok: true };
        }
        const hashes = (await tx.fileHashes(targetKey)).current(files);
        const replaced = (await tx.getFileViews(targetKey)).filter((view) => hashes.has(view.file));
        for (const [file, hash] of hashes) await tx.setFileViewed(targetKey, file, hash);
        return { ok: hashes.size === new Set(files).size, previous: replaced };
      });
    },
  } satisfies Partial<RpcHandlers>;
  const changedDraft = (targetKey: string) => bb.realtime.publish(`draft:${targetKey}`, {});
  const commands = {
    comment: (args, _ctx, ownReview) => runCommentCommand(store, args, changedDraft, ownReview),
    summary: (args, _ctx, ownReview) => runSummaryCommand(store, args, changedDraft, ownReview),
  } satisfies Subcommands;
  return { handlers, commands, submit };
}
