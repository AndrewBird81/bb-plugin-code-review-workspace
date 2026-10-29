// Whose turn a review is, and your feedback on a PR: snoozing and seeing a review, starting what didn't run on its own,
// checking and replying to your feedback, the suggested verdict, and what changed since your review.
import { isAssistantAnswering, startAutomaticReview } from "./agent";
import { commentsKey } from "./draft";
import { ghReplyThreadArgs, runGh, ghErrorMessage } from "./gh";
import { requireReviewRevision } from "./review-revision";
import { forgetPostedReply, postDraftedReply } from "./post-receipts";
import { rerunReview } from "./rereview";
import { baselineOf, feedbackView, guideBehind, headOf, prCommits, remainingBody, sinceReview } from "./feedback-view";
import { startVerification } from "./verification";
import { approve } from "../lib/trust";
import { automaticReviewPrompt, reReviewCheckPrompt } from "./preferences";
import type { AsyncStore } from "./store-queue";
import { NOT_THIS_REVIEW, verifiedGh } from "./github-threads-rpc";
import type { RpcHandlers, ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, receipts, notifications, sync, changed, refreshThreads } = deps;
  const view = async (store: AsyncStore, targetKey: string) => {
    return store.exclusive(async (tx) => {
      const review = await tx.getReview(targetKey);
      return review ? await feedbackView(tx, review) : null;
    });
  };

  return {
    handlers: {
      async snoozeReview({ targetKey, snoozed, until }: { targetKey: string; snoozed: boolean; until?: number | null }) {
        const refused = await store.exclusive(async (tx) => {
          if (!await tx.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
          if (snoozed && until != null && until <= Date.now()) return { ok: false, error: "Pick a time in the future." };
          await tx.setLifecycle(targetKey, { snoozedAt: snoozed ? Date.now() : null, snoozedUntil: snoozed ? until ?? null : null });
          return null;
        });
        if (refused) return refused;
        if (snoozed) await notifications.dismiss(targetKey);
        await sync.evaluate(targetKey);
        changed(targetKey);
        return { ok: true };
      },
      async markSeen({ targetKey }: { targetKey: string }) {
        // Settings says an alert clears when you open its review, so one still waiting for its re-review won't come. Its
        // item goes at once, and again once any evaluation in progress, which may alert meanwhile, is done.
        await notifications.dismiss(targetKey);
        await sync.seen(targetKey);
        await notifications.dismiss(targetKey);
        return { ok: true };
      },
      async startTrackedReview({ targetKey }: { targetKey: string }) {
        const review = await store.getReview(targetKey);
        if (!review) return { ok: false, error: "This review no longer exists." };
        if (review.status === "generating") return { ok: true };
        const result = await rerunReview(deps, targetKey);
        changed(targetKey);
        return result;
      },
      async runSkipped({ targetKey }: { targetKey: string }) {
        // What it finds, and the approval it records before the run starts, in one turn.
        const decided = await store.exclusive(async (tx) => {
          const review = await tx.getReview(targetKey);
          const skipped = review?.skippedRun;
          if (!review || !skipped || review.status === "generating") return { result: { ok: true } };
          // What can't run now is refused before agents are approved on the PR's head, and the notice stays.
          const preferences = (await tx.getPreferences()).preferences;
          const state = review.startedPrState ?? review.prState;
          if (skipped.run === "review" && !automaticReviewPrompt(preferences)) return { result: { ok: false, error: "The automatic review is off. Turn it on in Review settings." } };
          if (skipped.run === "check" && !reReviewCheckPrompt(preferences)) return { result: { ok: false, error: "The re-review check is off. Turn it on in Review settings." } };
          if (skipped.run === "review" && (state === "MERGED" || state === "CLOSED")) return { result: { ok: false, error: `This PR is ${state === "MERGED" ? "merged" : "closed"}, so its review doesn't run.` } };
          // A guide that's missing or behind the PR is built first. Starting it approves its head, so the review or check follows.
          const rebuild = skipped.run === "guide" || review.status === "tracked" || skipped.run === "check" && guideBehind(review);
          if (!rebuild) await tx.setLifecycle(targetKey, { ...approve(skipped.run === "check" ? headOf(review) : review.headSha ?? null, Date.now()), skippedRun: null });
          return { review, skipped, rebuild };
        });
        if (decided.result) return decided.result;
        const { review, skipped } = decided;
        let result: { ok: boolean; error?: string };
        if (decided.rebuild) {
          result = await rerunReview(deps, targetKey);
        } else {
          try {
            // A conversation under way gets the review, as a message you send it.
            const ran = skipped.run === "review" ? ["started", "sent"].includes(await startAutomaticReview(bb, store, targetKey, undefined, { clicked: true }))
              : await startVerification(bb, store, targetKey, "the reviewer asked for a check");
            result = ran ? { ok: true } : { ok: false, error: skipped.run === "review" ? "The review didn't start. Try again." : "The assistant couldn't start. Open Ask agent to choose its agent." };
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : "The assistant couldn't start." };
          }
          // Nothing started, so nothing is approved.
          if (!result.ok) await store.setLifecycle(targetKey, { approvedHead: review.approvedHead ?? null, approvedAt: review.approvedAt ?? null, skippedRun: skipped });
        }
        changed(targetKey);
        return result;
      },
      async getFeedback({ targetKey }: { targetKey: string }) {
        return { feedback: await view(store, targetKey) };
      },
      async refreshFeedback({ targetKey }: { targetKey: string }) {
        const review = await store.getReview(targetKey);
        if (review) await refreshThreads(review).catch((error) => bb.log.warn(`Could not read your threads on ${targetKey}: ${String(error)}`));
        await sync.evaluate(targetKey);
        return { feedback: await view(store, targetKey) };
      },
      async checkFeedback({ targetKey }: { targetKey: string }) {
        const { review, checking } = await store.exclusive(async (tx) => {
          const review = await tx.getReview(targetKey);
          return { review, checking: !!review && !!baselineOf(review).at && !!reReviewCheckPrompt((await tx.getPreferences()).preferences) };
        });
        if (!review) return { ok: false, error: "This review no longer exists." };
        if (!baselineOf(review).at) return { ok: false, error: "Submit a review first; then the assistant can check your feedback." };
        if (!checking) return { ok: false, error: "The re-review check is off. Turn it on in Review settings." };
        if (await isAssistantAnswering(bb, store, targetKey)) return { ok: false, error: "The assistant is still answering. Try again when it finishes." };
        await refreshThreads(review).catch(() => {});
        if (!await startVerification(bb, store, targetKey, "the reviewer asked for a check")) return { ok: false, error: "The assistant couldn't start. Open Ask agent to choose its agent." };
        // The check you ran replaces one that didn't run on its own.
        if (review.skippedRun?.run === "check") await store.setLifecycle(targetKey, { skippedRun: null });
        return { ok: true };
      },
      async replyToFeedback({ targetKey, threadId, body, account }: { targetKey: string; threadId: string; body: string; account?: string }) {
        const { review, thread } = await store.exclusive(async (tx) => ({
          review: await tx.getReview(targetKey),
          thread: (await tx.listFeedbackThreads(targetKey)).find((t) => t.id === threadId),
        }));
        if (!review?.repo || !review.number || !thread) return { ok: false, error: NOT_THIS_REVIEW };
        const gh = await verifiedGh(account, "reply");
        if ("error" in gh) return { ok: false, error: gh.error };
        const replied = await postDraftedReply(receipts, store, targetKey, threadId, body, async () => {
          const r = await gh.run(ghReplyThreadArgs(review.repo!, review.number!, thread.commentId), { stdin: JSON.stringify({ body }), timeoutMs: 0 });
          return r.code !== 0 ? { ok: false, error: ghErrorMessage(r) } : { ok: true };
        });
        if (!replied.ok) return replied;
        await refreshThreads(review).catch(() => {});
        // GitHub has the reply: a store that can't be read now mustn't fail the Send, or the page drafts it to post again.
        const feedback = await view(store, targetKey).catch((error) => {
          bb.log.warn(`Could not read the feedback on ${targetKey} after your reply: ${String(error)}`);
          return undefined;
        });
        return { ok: true, ...(feedback !== undefined ? { feedback } : {}) };
      },
      async saveReplyDraft({ targetKey, threadId, body }: { targetKey: string; threadId: string; body: string }) {
        const saved = await store.exclusive(async (tx) => {
          // A page saving after another window deleted the review would write what Delete can no longer remove.
          if (!await tx.getReview(targetKey)) return { ok: false };
          if (body.trim()) await tx.setReplyDraft(targetKey, threadId, body, "reviewer");
          else await tx.deleteReplyDraft(targetKey, threadId);
          return { ok: true };
        });
        if (saved.ok) await forgetPostedReply(receipts, targetKey, threadId, body.trim() ? body : undefined);
        return saved;
      },
      async discardReplyDraft({ targetKey, threadId }: { targetKey: string; threadId: string }) {
        await store.deleteReplyDraft(targetKey, threadId);
        await forgetPostedReply(receipts, targetKey, threadId);
        bb.realtime.publish(`feedback:${targetKey}`, { ts: Date.now() });
        return { ok: true };
      },
      async getReplyDrafts({ targetKey }: { targetKey: string }) {
        return { drafts: [...await store.listReplyDrafts(targetKey)].map(([threadId, draft]) => ({ threadId, ...draft })) };
      },
      async useSuggestedVerdict({ targetKey, revision, mode }: { targetKey: string; revision?: string; mode: "suggested" | "remaining" }) {
        return store.exclusive(async (tx) => {
          try { await requireReviewRevision(tx, targetKey, revision); } catch (error) { return { ok: false, error: (error as Error).message }; }
          const feedback = await view(tx, targetKey);
          if (!feedback) return { ok: false, error: "This review no longer exists." };
          let verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
          let body: string;
          if (mode === "suggested") {
            if (!feedback.run) return { ok: false, error: "The assistant hasn't suggested a verdict yet." };
            verdict = feedback.run.suggestedVerdict ?? "COMMENT";
            body = feedback.run.suggestedBody;
          } else {
            body = remainingBody(feedback);
            if (!body) return { ok: false, error: "Nothing is left open. Consider approving." };
            verdict = "REQUEST_CHANGES";
          }
          // You chose the verdict; the words are still the assistant's until you edit them. You've settled the summary.
          await tx.setLifecycle(targetKey, { summaryAsk: null });
          const draft = await tx.updateSummary(targetKey, { verdict, verdictChosen: true, body, bodyAuthor: "agent", written: { verdict, comments: commentsKey((await tx.getDraft(targetKey)).comments) } });
          bb.realtime.publish(`draft:${targetKey}`, {});
          return { ok: true, draft };
        });
      },
      async getSinceReview({ targetKey, from }: { targetKey: string; from?: string }) {
        const review = await store.getReview(targetKey);
        if (!review) return { baseline: null, files: [] };
        try {
          const since = await sinceReview(store, runGh, review, from);
          return since ? { baseline: since.baseline, files: since.files } : { baseline: null, files: [] };
        } catch (error) {
          return { baseline: null, files: [], error: error instanceof Error ? error.message : from ? `Couldn't compare with ${from.slice(0, 7)}.` : "Couldn't compare with your last review." };
        }
      },
      async getPrCommits({ targetKey }: { targetKey: string }) {
        const review = await store.getReview(targetKey);
        if (review?.kind !== "pr") return { commits: [] };
        try { return { commits: await prCommits(runGh, review) }; }
        catch (error) { return { commits: [], error: error instanceof Error ? error.message : "Couldn't read the PR's commits." }; }
      },
    } satisfies Partial<RpcHandlers>,
  };
}
