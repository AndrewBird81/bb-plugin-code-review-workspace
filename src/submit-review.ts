import { bindGhAccount } from "./gh-identity";
import { ghErrorMessage, ghPrHeadArgs, ghPrReviewsArgs, ghSubmitReviewArgs, type runGh } from "./gh";
import { classifyWriteError, PAGE_BUDGET_MS, refusalText, type GithubWrites } from "./github-writes";
import { postable, sameComments, sameLocation, SUBMIT_WARNINGS, toGithubReviewPayload, type CommentLocation, type Draft, type DraftComment, type Verdict } from "./draft";
import type { ReviewMeta } from "./store";
import { reviewRevision } from "./review-revision";
import { summaryLine, withSummaryLine } from "../lib/move-to-summary";
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

/**
 * Why GitHub refused the review, saying how to clear a pending review started on github.com, which blocks it. A timeout
 * is gh's own words, as what follows says whether GitHub took the review anyway.
 */
function refusal(result: { stdout: string; stderr: string }, args: string[]): string {
  const refused = classifyWriteError({ stdout: result.stdout, stderr: result.stderr }, { args, action: "review" });
  if (refused.kind === "pending-review") return "You have a pending review on this PR, started on github.com. Submit or discard it there, then submit again. Your draft has been kept.";
  return refused.kind === "rate-limited" ? `${refusalText(refused)} Your draft has been kept.` : refusalText(refused);
}

/** What holds a Submit back until you submit anyway. */
export type SubmitWarning = typeof SUBMIT_WARNINGS[number];
/** What the page offers beside a refusal or a warning: Submit anyway, Submit as Comment, Open it on GitHub. */
export type SubmitOffer = "anyway" | "comment" | "github";
/** A Submit that warned, rather than posting: `warning` says why, in words, and `warnings` names each. */
export type SubmitResult = {
  ok: boolean; error?: string; url?: string; warning?: string; warnings?: SubmitWarning[]; offers?: SubmitOffer[];
  /** Each warning's own sentence. */
  texts?: Partial<Record<SubmitWarning, string>>;
  /** New commits since the review: how many (null when GitHub didn't say), and GitHub's compare of them. */
  newCommits?: { count: number | null; url: string };
  /** Checking only: the summary and comments that would post, past the warnings, with what GitHub can't place in the summary. */
  posting?: { body: string; comments: DraftComment[] };
  /** Checking only: where the comments that post are, before any moves into the summary, for the Submit that posts them (`posting`). */
  posts?: CommentLocation[];
};
type Warned = [SubmitWarning, string][];

const count = (comments: readonly unknown[], one: string, many: string) => comments.length === 1 ? `1 comment ${one}` : `${comments.length} comments ${many}`;
const places = (comments: readonly DraftComment[]) => comments.slice(0, 3).map((c) => `${c.file}:${c.line}`).join(", ") + (comments.length > 3 ? ", …" : "");
/** How many commits `head` has past `reviewed`; null when GitHub couldn't say. */
async function commitsSince(run: typeof runGh, repo: string, reviewed: string, head: string): Promise<number | null> {
  const r = await run(["api", `repos/${repo}/compare/${reviewed}...${head}`, "--jq", ".ahead_by"]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) && n > 0 ? n : null;
}
export const DRAFT_CHANGED = "Draft changed · review it, then submit again.";
/** The draft's comments without `moved`, which become lines at the end of its summary. */
function moveToSummary(draft: Draft, moved: readonly DraftComment[], preExisting: boolean): { body: string; comments: DraftComment[] } {
  return {
    comments: draft.comments.filter((c) => !moved.some((x) => sameComments([c], [x]))),
    body: moved.reduce((body, c) => withSummaryLine(body, summaryLine(c, preExisting)), draft.body),
  };
}
/** A comment a Send took, or you resolved or dismissed, which may not post (draft.ts postable). */
const tracked = (c: Pick<DraftComment, "state">) => !!c.state && c.state !== "open";
/** The same places, in any order. */
const sameLocations = (a: readonly CommentLocation[], b: readonly CommentLocation[]) => a.length === b.length && a.every((at) => b.some((other) => sameLocation(at, other)));
const pendingReview = (result: { stdout: string; stderr: string }, args: string[]) => classifyWriteError({ stdout: result.stdout, stderr: result.stderr }, { args, action: "review" }).kind === "pending-review";

/**
 * `pace` runs the POST in the server's line of writes to GitHub (GithubWrites.pace): once, never retried, as a review
 * GitHub may have taken is looked for instead, and only if it can start within the page's wait.
 */
export function createReviewSubmitter(store: AsyncStore, run: typeof runGh, receipts: PostReceipts = postReceipts(), pace: GithubWrites["pace"] = (write) => write(Infinity), login: () => Promise<string | null> = async () => (await run(["api", "user", "--jq", ".login"])).stdout.trim() || null) {
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
  /**
   * `shown` is the list of comments the reviewer's page displays, and `summary` its summary and verdict; the draft must
   * still match them. `force` submits past the warnings it names, or with true past all of them (Submit anyway).
   * `check` only checks what would stop it, or warn, with `summary` as it would post, without posting. `alone` posts
   * `summary` by itself, with no line comments, as a Ready to approve row does: the draft's comments stay in it, and its
   * own summary unless it's the one posted. `reviewed`, the head it was asked on, must still be the review's. `posting`,
   * the comments the caller showed as posting: a draft whose comments that post differ, as after a Reopen or a Send
   * since, is refused; without it, so is one with a comment sent, resolved or dismissed.
   */
  return async (targetKey: string, revision: string | undefined, account: string | undefined, shown: Pick<DraftComment, "file" | "line" | "side" | "severity" | "introduced" | "body">[], summary: { body: string; verdict: Verdict }, { force, check, alone, reviewed, posting }: { force?: boolean | readonly SubmitWarning[]; check?: boolean; alone?: boolean; reviewed?: string; posting?: readonly CommentLocation[] } = {}): Promise<SubmitResult> => {
    const allowed = (kind: SubmitWarning) => force === true || (Array.isArray(force) && force.includes(kind));
    if (inFlight.has(targetKey)) return { ok: false, error: "This review is already being submitted." };
    inFlight.add(targetKey);
    // Whether the PR is yours, read outside the store's turn, as GitHub may be asked who you are; only a draft with a
    // comment sent, resolved or dismissed needs it. On your own change only open comments post. `own` null: not known.
    const ownOf = async (): Promise<{ needed: boolean; own: boolean | null }> => {
      const review = await store.getReview(targetKey);
      if (!review || !(await store.getDraft(targetKey)).comments.some(tracked)) return { needed: false, own: false };
      if (review.kind === "ref" || review.feature) return { needed: true, own: true };
      if (typeof review.ownPr === "boolean") return { needed: true, own: review.ownPr };
      if (!review.author) return { needed: true, own: false };
      const viewer = await login().catch(() => null);
      return { needed: true, own: viewer ? viewer.toLowerCase() === review.author.toLowerCase() : null };
    };
    try {
      // A review GitHub took that couldn't be recorded: recorded now. The same draft, on the head it was for, isn't posted
      // again; a changed one, or one on a newer head, is a new review, but the comments GitHub has leave the draft first.
      const earlier = await receipts.get<ReviewReceipt>(reviewReceiptKey(targetKey));
      if (earlier) {
        let current = false;
        let taken = { comments: 0, summary: false };
        // What GitHub took was the shown comments that post: those that don't stay in the draft.
        let kept: DraftComment[] = [];
        try {
          const review = await store.getReview(targetKey);
          current = review?.headSha === earlier.headSha;
          // Recorded whole each time, as both writes can be made again: a record can fail between them, and the sync
          // replaces submittedAt with GitHub's time, so the review's state can't tell what was recorded.
          if (review) taken = await record(targetKey, earlier, !current);
          const { own } = await ownOf();
          kept = (await store.getDraft(targetKey)).comments.filter((c) => !postable(c, own !== false));
        } catch (error) {
          // Put in kv again, as it may be in memory alone.
          return { ok: false, error: notRecorded("review", error, await receipts.put(reviewReceiptKey(targetKey), earlier), earlier.url) };
        }
        await receipts.drop(reviewReceiptKey(targetKey));
        const shownPosting = shown.filter((c) => !kept.some((k) => sameLocation(k, c)));
        if (current && sameComments(asReceipted(earlier.draft.comments), asReceipted(shownPosting)) && receiptText(earlier.draft.body) === receiptText(summary.body) && earlier.draft.verdict === summary.verdict) return { ok: true, ...(earlier.url ? { url: earlier.url } : {}) };
        const from = `from your review of ${earlier.headSha.slice(0, 7)}${earlier.url ? ` (${earlier.url})` : ""}`;
        if (taken.comments) return { ok: false, error: `GitHub already has ${taken.comments} of these comments, ${from}, so ${taken.comments === 1 ? "it was" : "they were"} taken out of your draft. Check the draft, then submit again.` };
        if (taken.summary) return { ok: false, error: `GitHub already has your summary and verdict, ${from}, so they were taken out of your draft. Check the draft, then submit again.` };
      }
      const ownership = alone ? { needed: false, own: false } : await ownOf();
      // Unknown, a comment sent to fix could post: nothing does.
      if (ownership.needed && ownership.own === null) return { ok: false, error: "Couldn't tell whether this PR is yours, so nothing posted. Try again in a moment." };
      const own = ownership.own === true;
      const posts = (c: DraftComment) => postable(c, own);
      // The review and the draft it checks, in one turn: what GitHub would refuse stops it; the rest warns.
      const warned: Warned = [];
      const checked = await store.exclusive(async (tx): Promise<{ error: string; offers?: SubmitOffer[] } | { m: ReviewMeta & { number: number; repo: string }; draft: Draft; stale: DraftComment[]; outside: DraftComment[] }> => {
        if (revision && revision !== await reviewRevision(tx, targetKey)) warned.push(["revision", "This review changed in another window since this page loaded it."]);
        const m = await tx.getReview(targetKey);
        if (!m || m.kind !== "pr" || !m.number || !m.repo) return { error: "Submitting requires a GitHub PR target." };
        if (reviewed !== undefined && m.headSha !== reviewed) return { error: "The review moved to newer commits since this was asked. Approve it from the review." };
        if (m.prState === "MERGED" || m.prState === "CLOSED") warned.push(["closed", `This PR is ${m.prState.toLowerCase()}.`]);
        if (m.status === "generating") warned.push(["generating", "The guide is still rebuilding, so these comments are on the diff from before it."]);
        if (!m.headSha) warned.push(["no-head", "The commit you reviewed isn't known, so the review would go on the PR's latest commit."]);
        const saved = await tx.getDraft(targetKey);
        if (!alone && !sameComments(saved.comments, shown)) return { error: DRAFT_CHANGED };
        // A comment sent since ownership was read.
        if (!alone && !ownership.needed && saved.comments.some(tracked)) return { error: DRAFT_CHANGED };
        // Checking only, the summary and verdict are the ones it would post with; alone, they're all it posts. Only the
        // comments that post are checked, posted, moved into the summary, or taken out of the draft once GitHub has them.
        const read = alone ? { ...saved, comments: [], body: summary.body, verdict: summary.verdict } : check ? { ...saved, body: summary.body, verdict: summary.verdict } : saved;
        if (read.body !== summary.body || read.verdict !== summary.verdict) return { error: DRAFT_CHANGED };
        const draft = { ...read, comments: read.comments.filter(posts) };
        // What the caller showed as posting is what posts: a Reopen, a Send or a Resolve since changes it.
        if (!alone && !check && (posting ? !sameLocations(posting, draft.comments) : saved.comments.some(tracked))) return { error: DRAFT_CHANGED };
        if (draft.verdict === "COMMENT" && !draft.body.trim() && !draft.comments.length) return { error: "Add a summary or at least one comment before submitting a Comment review." };
        if (draft.verdict === "REQUEST_CHANGES" && !draft.body.trim()) return { error: "Add a summary explaining the requested changes before submitting." };
        if (account && m.author && draft.verdict !== "COMMENT" && account.toLowerCase() === m.author.toLowerCase()) return { error: "GitHub allows only a Comment review on your own PR.", offers: ["comment"] };
        if (draft.comments.some((c) => !c.body.trim())) return { error: "Draft comments can't be blank." };
        const stale = alone ? [] : (await tx.staleDraftComments(targetKey)).filter(posts);
        if (stale.length) warned.push(["older-diff", `${count(stale, "was", "were")} drafted on an older diff (${places(stale)}). Submitting anyway moves ${stale.length === 1 ? "it" : "them"} into the summary.`]);
        const staleSet = new Set(stale.map((c) => JSON.stringify([c.file, c.line, c.side])));
        const outside = invalidComments(await tx.patch(targetKey), draft.comments).filter((c) => !staleSet.has(JSON.stringify([c.file, c.line, c.side])));
        if (outside.length) warned.push(["outside-diff", `${count(outside, "is", "are")} outside the current diff (${places(outside)}). Submitting anyway moves ${outside.length === 1 ? "it" : "them"} into the summary.`]);
        return { m: { ...m, number: m.number, repo: m.repo }, draft, stale, outside };
      });
      if ("error" in checked) return { ok: false, error: checked.error, ...(checked.offers ? { offers: checked.offers } : {}) };
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
        if ((snapshot.state === "MERGED" || snapshot.state === "CLOSED") && m.prState !== snapshot.state) {
          await store.setLifecycle(targetKey, { prState: snapshot.state, archivedAt: Date.now() });
          warned.push(["closed", `This PR is ${snapshot.state.toLowerCase()}.`]);
        }
      } catch { /* reject below */ }
      if (typeof current !== "string" || !current) return { ok: false, error: "Couldn't verify the PR revision. Your draft has been kept." };
      let newCommits: SubmitResult["newCommits"];
      if (m.headSha && current !== m.headSha) {
        const unseen = !allowed("new-commits") ? await commitsSince(authenticatedRun, m.repo, m.headSha, current) : null;
        newCommits = { count: unseen, url: `https://github.com/${m.repo}/compare/${m.headSha}...${current}` };
        warned.push(["new-commits", `${unseen ? `${unseen} new ${unseen === 1 ? "commit" : "commits"}` : "New commits"} since you reviewed. ${draft.verdict === "APPROVE" ? "Approving now covers them unseen." : "Submitting now posts on the version you reviewed."}`]);
      }
      if (typeof base === "string" && base && m.base && base !== m.base) warned.push(["base-changed", `The PR's base changed to ${base} since you reviewed it.`]);
      const held = warned.filter(([kind]) => !allowed(kind));
      const warning = held.length ? { ok: false, warning: held.map(([, text]) => text).join(" "), warnings: [...new Set(held.map(([kind]) => kind))], texts: Object.fromEntries(held), offers: ["anyway" as const], ...(newCommits ? { newCommits } : {}) } : { ok: true };
      // Checking only: what would post, past what it warns about.
      if (check) {
        const preExisting = (await store.getPreferences()).preferences.knobs.preExistingFindings;
        return { ...warning, posting: moveToSummary(draft, [...checked.stale, ...checked.outside], preExisting), posts: draft.comments.map(({ file, line, side }) => ({ file, line, side })) };
      }
      if (held.length) return warning;
      // Checked again as it posts, in one turn.
      const preExistingFindings = await store.exclusive(async (tx) => {
        const now = await tx.getReview(targetKey);
        if ((now?.status === "generating" && !allowed("generating")) || now?.headSha !== m.headSha) return null;
        if (revision && !allowed("revision") && revision !== await reviewRevision(tx, targetKey)) return null;
        return (await tx.getPreferences()).preferences.knobs.preExistingFindings;
      });
      if (preExistingFindings === null) return { ok: false, error: "The review changed during submission. Wait for generation and review the draft again." };
      // Comments GitHub can't place, once you submit anyway, go in the summary instead, as one bad comment likely fails the whole review.
      const sending = { ...draft, ...moveToSummary(draft, [...(allowed("older-diff") ? checked.stale : []), ...(allowed("outside-diff") ? checked.outside : [])], preExistingFindings) };
      // On the version you reviewed, past new commits: GitHub takes an older commit.
      const payload = { ...toGithubReviewPayload(sending, preExistingFindings, own), commit_id: m.headSha ?? current };
      const attempted = Date.now();
      const args = ghSubmitReviewArgs(m.repo, m.number);
      const result = await pace(() => authenticatedRun(args, { timeoutMs: POST_TIMEOUT_MS, stdin: JSON.stringify(payload) }), PAGE_BUDGET_MS);
      if ("ok" in result) return { ok: false, error: `${refusalText(result)} Your draft has been kept.` };
      let posted = result.stdout;
      if (result.code !== 0) {
        // gh can fail, or time out, after GitHub created the review: finish with that one, so Submit never posts twice.
        const viewer = account ?? (await authenticatedRun(["api", "user", "--jq", ".login"])).stdout.trim();
        const found = viewer ? await postedAnyway(authenticatedRun, m.repo, m.number, viewer, payload, attempted, { id: m.submittedReviewId, at: m.submittedAt }) : undefined;
        if (found === undefined) return { ok: false, error: `${refusal(result, args)} Couldn't check whether GitHub got your review anyway: look at the PR before you submit again. Your draft has been kept.` };
        if (found === null) return { ok: false, error: refusal(result, args), ...(pendingReview(result, args) ? { offers: ["github"] } : {}) };
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
      const receipt: ReviewReceipt = { submittedAt: Date.now(), reviewId, headSha: payload.commit_id, draft, ...(reviewer ? { reviewer } : {}), ...(url ? { url } : {}) };
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
