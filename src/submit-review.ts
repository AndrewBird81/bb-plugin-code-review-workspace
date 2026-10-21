import { bindGhAccount } from "./gh-identity";
import { ghErrorMessage, ghPrHeadArgs, ghPrReviewsArgs, ghSubmitReviewArgs, type runGh } from "./gh";
import { sameComments, toGithubReviewPayload, type DraftComment, type Verdict } from "./draft";
import { requireReviewRevision } from "./review-revision";
import { invalidComments } from "./review-positions";
import type { AsyncStore } from "./store-queue";

/** Long enough for any review GitHub will take; a POST that hangs past it is checked for, never retried blind. */
const POST_TIMEOUT_MS = 5 * 60_000;
/** How far GitHub's clock may run behind this server's when a review is matched to the attempt that posted it. */
const CLOCK_SKEW_MS = 60_000;
const STATES: Record<Verdict, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

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

export function createReviewSubmitter(store: AsyncStore, run: typeof runGh) {
  const inFlight = new Set<string>();
  /** `shown` is the list of comments the reviewer's page displays, and `summary` its summary and verdict; the draft must still match them. */
  return async (targetKey: string, revision: string | undefined, account: string | undefined, shown: Pick<DraftComment, "file" | "line" | "side" | "severity" | "introduced" | "body">[], summary: { body: string; verdict: Verdict }): Promise<{ ok: boolean; error?: string; url?: string }> => {
    if (inFlight.has(targetKey)) return { ok: false, error: "This review is already being submitted." };
    inFlight.add(targetKey);
    try {
      if (revision) await requireReviewRevision(store, targetKey, revision);
      const m = await store.getReview(targetKey);
      if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Submitting requires a GitHub PR target." };
      if (m.prState === "MERGED" || m.prState === "CLOSED") return { ok: false, error: `This PR is ${m.prState.toLowerCase()}. Your draft has been kept.` };
      if (m.status === "generating") return { ok: false, error: "Wait for the review to finish generating before submitting." };
      if (!m.headSha) return { ok: false, error: "Rebuild the guide before submitting so the reviewed revision can be verified." };
      const draft = await store.getDraft(targetKey);
      if (!sameComments(draft.comments, shown)) return { ok: false, error: "Your draft comments changed since this page showed them, possibly from the assistant. Check them, then submit again." };
      if (draft.body !== summary.body || draft.verdict !== summary.verdict) return { ok: false, error: "Your review summary or verdict changed since this page showed it, possibly from the assistant or another window. Check them, then submit again." };
      if (draft.verdict === "COMMENT" && !draft.body.trim() && !draft.comments.length) return { ok: false, error: "Add a summary or at least one comment before submitting a Comment review." };
      if (draft.verdict === "REQUEST_CHANGES" && !draft.body.trim()) return { ok: false, error: "Add a summary explaining the requested changes before submitting." };
      if (account && m.author && draft.verdict !== "COMMENT" && account.toLowerCase() === m.author.toLowerCase()) return { ok: false, error: "GitHub allows only a Comment review on your own PR. Choose Comment, then submit again." };
      if (draft.comments.some((c) => !c.body.trim())) return { ok: false, error: "Draft comments can't be blank." };
      const stale = await store.staleDraftComments(targetKey);
      if (stale.length) return { ok: false, error: `The diff changed after these comments were drafted. Edit and save, or remove: ${stale.map((c) => `${c.file}:${c.line}`).join(", ")}` };
      const patch = await store.patch(targetKey);
      const bad = invalidComments(patch, draft.comments);
      if (bad.length) return { ok: false, error: `These comments are outside the current diff: ${bad.map((c) => `${c.file}:${c.line}`).join(", ")}. Remove them and add any replacement comments on lines in the current diff.` };
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
      if ((await store.getReview(targetKey))?.status === "generating" || (await store.getReview(targetKey))?.headSha !== m.headSha) return { ok: false, error: "The review changed during submission. Wait for generation and review the draft again." };
      if (revision) await requireReviewRevision(store, targetKey, revision);
      const payload = { ...toGithubReviewPayload(draft, (await store.getPreferences()).preferences.knobs.preExistingFindings), commit_id: m.headSha };
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
      await store.setLifecycle(targetKey, { submittedVerdict: draft.verdict, submittedAt: Date.now(), submittedHeadSha: m.headSha, submittedReviewId: reviewId, ...(reviewer ? { reviewer } : {}) });
      await store.clearSubmittedDraft(draft);
      return { ok: true, ...(url ? { url } : {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Couldn't submit the review. Your draft has been kept." };
    } finally {
      inFlight.delete(targetKey);
    }
  };
}
