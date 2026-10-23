import { bindGhAccount } from "./gh-identity";
import { ghErrorMessage, ghPrHeadArgs, ghPrReviewsArgs, ghSubmitReviewArgs, type runGh } from "./gh";
import { sameComments, toGithubReviewPayload, type Draft, type DraftComment, type Verdict } from "./draft";
import type { ReviewMeta } from "./store";
import { requireReviewRevision } from "./review-revision";
import { invalidComments } from "./review-positions";
import type { AsyncStore } from "./store-queue";
import { notRecorded, postReceipts, receiptText, recordPosted, reviewReceiptKey, type PostReceipts, type ReviewReceipt } from "./post-receipts";

/** Long enough for any review GitHub will take; a POST that hangs past it is checked for, never retried blind. */
const POST_TIMEOUT_MS = 5 * 60_000;
/** How far GitHub's clock may run behind this server's when a review is matched to the attempt that posted it. */
const CLOCK_SKEW_MS = 60_000;
const STATES: Record<Verdict, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };
const asReceipted = <T extends { body: string }>(comments: readonly T[]) => comments.map((c) => ({ ...c, body: receiptText(c.body) }));

/**
 * After a POST that failed or timed out: the review GitHub created from it anyway, as `viewer`, on this commit, with
 * this summary and verdict, submitted since the attempt began, and not `earlier`, the review last submitted from here:
 * by its id, or once the sync has read it back, which drops the id, by GitHub's time for it, which the sync records.
 * Its JSON, null when there's none, or undefined when GitHub couldn't be asked.
 */
async function postedAnyway(run: typeof runGh, repo: string, number: number, viewer: string, payload: { event: Verdict; body: string; commit_id: string }, since: number, earlier: { id?: string | null; at?: number | null }): Promise<string | null | undefined> {
  const listed = await run(ghPrReviewsArgs(repo, number));
  if (listed.code !== 0) return undefined;
  for (const line of listed.stdout.split("\n").reverse()) {
    let review: any;
    try { review = JSON.parse(line); } catch { continue; }
    if (earlier.id ? review?.node_id === earlier.id : earlier.at && Date.parse(review?.submitted_at) <= earlier.at) continue;
    if (typeof review?.user?.login === "string" && review.user.login.toLowerCase() === viewer.toLowerCase()
      && review.commit_id === payload.commit_id && review.state === STATES[payload.event] && (review.body ?? "") === payload.body
      && Date.parse(review.submitted_at) >= since - CLOCK_SKEW_MS) return line;
  }
  return null;
}

/** Why GitHub refused the review, saying how to clear a pending review started on github.com, which blocks it. */
function refusal(result: { stdout: string; stderr: string }): string {
  const message = ghErrorMessage(result);
  return /pending review/i.test(message) ? "You have a pending review on this PR, started on github.com. Submit or discard it there, then submit again. Your draft has been kept." : message;
}

export function createReviewSubmitter(store: AsyncStore, run: typeof runGh, receipts: PostReceipts = postReceipts()) {
  const inFlight = new Set<string>();
  /**
   * Record what GitHub took. One on an earlier head than the review's, as after a rebuild, leaves the summary and verdict:
   * submitted again, they're a review of the new head. Returns how many of its comments left the draft, and whether its
   * summary and verdict did.
   */
  const record = (targetKey: string, receipt: ReviewReceipt, keepSummary = false) => store.exclusive(async (tx) => {
    await tx.setLifecycle(targetKey, { submittedVerdict: receipt.draft.verdict, submittedAt: receipt.submittedAt, submittedHeadSha: receipt.headSha, submittedReviewId: receipt.reviewId, ...(receipt.reviewer ? { reviewer: receipt.reviewer } : {}) });
    return tx.clearSubmittedDraft(receipt.draft, keepSummary);
  });
  /** `shown` is the list of comments the reviewer's page displays, and `summary` its summary and verdict; the draft must still match them. */
  return async (targetKey: string, revision: string | undefined, account: string | undefined, shown: Pick<DraftComment, "file" | "line" | "side" | "severity" | "introduced" | "body">[], summary: { body: string; verdict: Verdict }): Promise<{ ok: boolean; error?: string; url?: string }> => {
    if (inFlight.has(targetKey)) return { ok: false, error: "This review is already being submitted." };
    inFlight.add(targetKey);
    try {
      // A review GitHub took that couldn't be recorded: recorded now. The same draft, on the head it was for, isn't posted
      // again; a changed one, or one on a newer head, is a new review, but the comments GitHub has leave the draft first.
      const earlier = await receipts.get<ReviewReceipt>(reviewReceiptKey(targetKey));
      if (earlier) {
        let current = false;
        let taken = { comments: 0, summary: false };
        try {
          const review = await store.getReview(targetKey);
          current = review?.headSha === earlier.headSha;
          // Recorded whole each time, as both writes can be made again: a record can fail between them, and the sync
          // replaces submittedAt with GitHub's time, so the review's state can't tell what was recorded.
          if (review) taken = await record(targetKey, earlier, !current);
        } catch (error) {
          // Put in kv again, as it may be in memory alone.
          return { ok: false, error: notRecorded("review", error, await receipts.put(reviewReceiptKey(targetKey), earlier), earlier.url) };
        }
        await receipts.drop(reviewReceiptKey(targetKey));
        if (current && sameComments(asReceipted(earlier.draft.comments), asReceipted(shown)) && receiptText(earlier.draft.body) === receiptText(summary.body) && earlier.draft.verdict === summary.verdict) return { ok: true, ...(earlier.url ? { url: earlier.url } : {}) };
        const from = `from your review of ${earlier.headSha.slice(0, 7)}${earlier.url ? ` (${earlier.url})` : ""}`;
        if (taken.comments) return { ok: false, error: `GitHub already has ${taken.comments} of these comments, ${from}, so ${taken.comments === 1 ? "it was" : "they were"} taken out of your draft. Check the draft, then submit again.` };
        if (taken.summary) return { ok: false, error: `GitHub already has your summary and verdict, ${from}, so they were taken out of your draft. Check the draft, then submit again.` };
      }
      // The review and the draft it checks, in one turn.
      const checked = await store.exclusive(async (tx): Promise<{ error: string } | { m: ReviewMeta & { number: number; repo: string; headSha: string }; draft: Draft }> => {
        if (revision) await requireReviewRevision(tx, targetKey, revision);
        const m = await tx.getReview(targetKey);
        if (!m || m.kind !== "pr" || !m.number || !m.repo) return { error: "Submitting requires a GitHub PR target." };
        if (m.prState === "MERGED" || m.prState === "CLOSED") return { error: `This PR is ${m.prState.toLowerCase()}. Your draft has been kept.` };
        if (m.status === "generating") return { error: "Wait for the review to finish generating before submitting." };
        if (!m.headSha) return { error: "Rebuild the guide before submitting so the reviewed revision can be verified." };
        const draft = await tx.getDraft(targetKey);
        if (!sameComments(draft.comments, shown)) return { error: "Your draft comments changed since this page showed them, possibly from the assistant. Check them, then submit again." };
        if (draft.body !== summary.body || draft.verdict !== summary.verdict) return { error: "Your review summary or verdict changed since this page showed it, possibly from the assistant or another window. Check them, then submit again." };
        if (draft.verdict === "COMMENT" && !draft.body.trim() && !draft.comments.length) return { error: "Add a summary or at least one comment before submitting a Comment review." };
        if (draft.verdict === "REQUEST_CHANGES" && !draft.body.trim()) return { error: "Add a summary explaining the requested changes before submitting." };
        if (account && m.author && draft.verdict !== "COMMENT" && account.toLowerCase() === m.author.toLowerCase()) return { error: "GitHub allows only a Comment review on your own PR. Choose Comment, then submit again." };
        if (draft.comments.some((c) => !c.body.trim())) return { error: "Draft comments can't be blank." };
        const stale = await tx.staleDraftComments(targetKey);
        if (stale.length) return { error: `The diff changed after these comments were drafted. Edit and save, or remove: ${stale.map((c) => `${c.file}:${c.line}`).join(", ")}` };
        const patch = await tx.patch(targetKey);
        const bad = invalidComments(patch, draft.comments);
        if (bad.length) return { error: `These comments are outside the current diff: ${bad.map((c) => `${c.file}:${c.line}`).join(", ")}. Remove them and add any replacement comments on lines in the current diff.` };
        return { m: { ...m, number: m.number, repo: m.repo, headSha: m.headSha }, draft };
      });
      if ("error" in checked) return { ok: false, error: checked.error };
      const { m, draft } = checked;
      const authenticatedRun = account ? await bindGhAccount(run, account) : run;
      const head = await authenticatedRun(ghPrHeadArgs(m.number, m.repo));
      if (head.code !== 0) return { ok: false, error: ghErrorMessage(head) };
      let current: unknown;
      let base: unknown;
      try {
        const snapshot = JSON.parse(head.stdout);
        current = snapshot?.headRefOid;
        base = snapshot?.baseRefName;
        if (snapshot.state === "MERGED" || snapshot.state === "CLOSED") {
          await store.setLifecycle(targetKey, { prState: snapshot.state, archivedAt: Date.now() });
          return { ok: false, error: `This PR is ${snapshot.state.toLowerCase()}. Your draft has been kept.` };
        }
      } catch { /* reject below */ }
      if (typeof current !== "string" || !current) return { ok: false, error: "Couldn't verify the PR revision. Your draft has been kept." };
      if (current !== m.headSha) return { ok: false, error: "The PR has new commits. Update the guide for them before submitting. Your draft has been kept." };
      if (typeof base === "string" && base && m.base && base !== m.base) return { ok: false, error: `The PR's base changed to ${base}. Update the guide for it before submitting. Your draft has been kept.` };
      // Checked again as it posts, in one turn.
      const preExistingFindings = await store.exclusive(async (tx) => {
        if ((await tx.getReview(targetKey))?.status === "generating" || (await tx.getReview(targetKey))?.headSha !== m.headSha) return null;
        if (revision) await requireReviewRevision(tx, targetKey, revision);
        return (await tx.getPreferences()).preferences.knobs.preExistingFindings;
      });
      if (preExistingFindings === null) return { ok: false, error: "The review changed during submission. Wait for generation and review the draft again." };
      const payload = { ...toGithubReviewPayload(draft, preExistingFindings), commit_id: m.headSha };
      const attempted = Date.now();
      const result = await authenticatedRun(ghSubmitReviewArgs(m.repo, m.number), { timeoutMs: POST_TIMEOUT_MS, stdin: JSON.stringify(payload) });
      let posted = result.stdout;
      if (result.code !== 0) {
        // gh can fail, or time out, after GitHub created the review: finish with that one, so Submit never posts twice.
        const viewer = account ?? (await authenticatedRun(["api", "user", "--jq", ".login"])).stdout.trim();
        const found = viewer ? await postedAnyway(authenticatedRun, m.repo, m.number, viewer, payload, attempted, { id: m.submittedReviewId, at: m.submittedAt }) : undefined;
        if (found === undefined) return { ok: false, error: `${refusal(result)} Couldn't check whether GitHub got your review anyway: look at the PR before you submit again. Your draft has been kept.` };
        if (found === null) return { ok: false, error: refusal(result) };
        posted = found;
      }
      let reviewer: string | undefined;
      let reviewId: string | null = null;
      let url: string | undefined;
      try {
        const receipt = JSON.parse(posted);
        if (typeof receipt?.user?.login === "string") reviewer = receipt.user.login;
        // The review's GraphQL id, to recognize it when the sync reads it back.
        if (typeof receipt?.node_id === "string") reviewId = receipt.node_id;
        if (typeof receipt?.html_url === "string") url = receipt.html_url;
      } catch { /* A successful response still records the submitted verdict. */ }
      const receipt: ReviewReceipt = { submittedAt: Date.now(), reviewId, headSha: m.headSha, draft, ...(reviewer ? { reviewer } : {}), ...(url ? { url } : {}) };
      const durable = await receipts.put(reviewReceiptKey(targetKey), receipt);
      try {
        await recordPosted(async () => { await record(targetKey, receipt); });
      } catch (error) {
        return { ok: false, error: notRecorded("review", error, durable, url) };
      }
      await receipts.drop(reviewReceiptKey(targetKey));
      return { ok: true, ...(url ? { url } : {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Couldn't submit the review. Your draft has been kept." };
    } finally {
      inFlight.delete(targetKey);
    }
  };
}
