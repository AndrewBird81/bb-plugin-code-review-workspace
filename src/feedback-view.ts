// Your feedback, the PR's diffs at the commits that matter, and the assistant's
// check, assembled for the Feedback view and the assistant's tools.
import type { Store, ReviewMeta } from "./store";
import type { runGh } from "./gh";
import { ghErrorMessage } from "./gh";
import { diffTooLarge, readFilesPatch, readPrDiff } from "./pr-snapshot";
import { ensureGitHeaders, splitPatchByFile } from "./patch";
import { interdiff, type FileInterdiff } from "./interdiff";
import { firstLine, type AssessmentItem, type FeedbackItem, type FeedbackView } from "../lib/feedback";
import { baselineOf, type AssessmentSummary } from "../lib/turn";
import type { Verdict } from "./draft";
import { threadLabel } from "./github/threads";

type Run = typeof runGh;

export { baselineOf } from "../lib/turn";
/** The most files GitHub's compare endpoint lists. */
const COMPARE_FILES = 300;
export const headOf = (review: ReviewMeta) => review.latestHeadSha ?? review.headSha ?? null;

/**
 * The PR's diff at a commit: saved, the review's own diff, the PR's current
 * diff, or reconstructed by comparing the base branch with that commit.
 */
export async function diffAt(store: Store, run: Run, review: ReviewMeta, sha: string): Promise<string> {
  const saved = store.getSnapshot(review.targetKey, sha);
  if (saved !== null) return saved;
  if (sha === review.headSha) {
    const patch = store.readPatch(review.targetKey, 0, store.readPatch(review.targetKey, 0, 0).total).text;
    if (patch) { store.saveSnapshot(review.targetKey, sha, patch); return patch; }
  }
  if (!review.repo || !review.number) throw new Error("This review has no GitHub PR.");
  let patch: string;
  if (sha === headOf(review)) {
    patch = await readPrDiff(run, review.number, review.repo);
  } else {
    // GitHub diffs the base branch with that commit from their merge base, as the PR did then.
    const compare = `repos/${review.repo}/compare/${encodeURIComponent(review.base ?? "HEAD")}...${sha}`;
    const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", compare]);
    if (diff.code === 0) patch = diff.stdout;
    else if (!diffTooLarge(diff)) throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: ${ghErrorMessage(diff)}`);
    else {
      // Too large for a diff: rebuild it from the comparison's files.
      patch = await readFilesPatch(run, ["api", compare, "--jq", ".files[] | @json"])
        .catch((error: Error) => { throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: ${error.message}`); });
      // The comparison lists at most 300 files; a diff missing the rest would show them as added since.
      if (splitPatchByFile(patch).length >= COMPARE_FILES) {
        throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: GitHub's comparison lists at most ${COMPARE_FILES} files, and the PR may have had more than ${COMPARE_FILES} files then.`);
      }
    }
  }
  patch = ensureGitHeaders(patch);
  store.saveSnapshot(review.targetKey, sha, patch);
  return patch;
}

/** Keep the diffs this review still needs: its guide's, your review's, and the PR's head. */
export function pruneDiffs(store: Store, review: ReviewMeta) {
  store.pruneSnapshots(review.targetKey, [review.headSha, baselineOf(review).sha, headOf(review)].filter((sha): sha is string => !!sha));
}

/** How long a review stays out of play (merged, closed, or archived) before its stored diffs are dropped. */
const PRUNE_AFTER = 30 * 86_400_000;

/**
 * Drop the stored diffs of PR reviews out of play for a month: the diff, its snapshots, and a kept guide's
 * backup. The guide, draft, notes, and GitHub state stay, and so does the diff you last reviewed, which
 * Since your review compares with. Opening such a review reads its diff again (diffAt). Left alone: drafts
 * with comments, which follow their lines into a new diff, and merged PRs whose guide is for an earlier
 * head, whose diff GitHub can't rebuild once the base has it. Returns the reviews pruned.
 */
export function pruneOldDiffs(store: Store, now: number): string[] {
  const pruned: string[] = [];
  for (const review of store.listReviews()) {
    const since = Math.min(review.archivedAt ?? Infinity, review.userArchivedAt ?? Infinity);
    if (review.kind !== "pr" || review.status !== "ready" || !review.headSha || now - since < PRUNE_AFTER) continue;
    if (review.prState === "MERGED" && headOf(review) !== review.headSha) continue;
    if (!store.hasPatch(review.targetKey) || store.getDraft(review.targetKey).comments.length) continue;
    const baseline = baselineOf(review).sha;
    store.dropPatch(review.targetKey);
    store.pruneSnapshots(review.targetKey, baseline && baseline !== review.headSha ? [baseline] : []);
    pruned.push(review.targetKey);
  }
  return pruned;
}

type SinceReview = { baseline: { sha: string; at: number | null; verdict: Verdict | null }; files: FileInterdiff[] };
/** The latest comparisons, by review, for the few reviews compared last. */
const compared = new WeakMap<Store, Map<string, { key: string; since: SinceReview }>>();
const COMPARED_REVIEWS = 8;

/**
 * The displayed diff compared with the diff at your last review; null when there's nothing to compare.
 * An added file's patch is left out: the page has its whole diff already.
 */
export async function sinceReview(store: Store, run: Run, review: ReviewMeta): Promise<SinceReview | null> {
  const baseline = baselineOf(review);
  if (!baseline.sha || !review.headSha || baseline.sha === review.headSha) return null;
  const cache = compared.get(store) ?? new Map<string, { key: string; since: SinceReview }>();
  compared.set(store, cache);
  const key = JSON.stringify([baseline, store.patchHash(review.targetKey)]);
  const hit = cache.get(review.targetKey);
  cache.delete(review.targetKey);
  if (hit?.key === key) {
    cache.set(review.targetKey, hit);
    return hit.since;
  }
  const reviewed = await diffAt(store, run, review, baseline.sha);
  const current = store.readPatch(review.targetKey, 0, store.readPatch(review.targetKey, 0, 0).total).text;
  const files = interdiff(reviewed, current).map((f) => (f.status === "added" ? { ...f, patch: "" } : f));
  const since = { baseline: { ...baseline, sha: baseline.sha }, files };
  cache.set(review.targetKey, { key, since });
  if (cache.size > COMPARED_REVIEWS) cache.delete(cache.keys().next().value!);
  return since;
}

/** Summary asks are the assistant's items "summary:<n>". */
export const isSummaryItem = (id: string) => /^summary:\d+$/.test(id);

/** Your feedback, the assistant's latest check, and drafted replies. */
export function feedbackView(store: Store, review: ReviewMeta): FeedbackView {
  const head = headOf(review);
  const threads = store.listFeedbackThreads(review.targetKey);
  const latest = store.latestAssessmentRun(review.targetKey);
  // The check of the head now; otherwise the latest check, marked as older.
  const checkedHead = head && store.getAssessment(review.targetKey, head).items.length ? head : latest?.headSha ?? null;
  const assessment = checkedHead ? store.getAssessment(review.targetKey, checkedHead) : { items: [], run: null };
  const byId = new Map(assessment.items.map((item) => [item.id, item]));
  const drafts = store.listReplyDrafts(review.targetKey);
  const url = (commentId: number) => review.url ? `${review.url}#discussion_r${commentId}` : null;
  const items: FeedbackItem[] = threads.map(({ resolvedSeenAt: _, ...thread }) => {
    const label = threadLabel(thread.body);
    return {
      id: thread.id, kind: "thread", title: firstLine(thread.body) || `${thread.path ?? "File"} comment`,
      thread: { ...thread, url: url(thread.commentId) }, assessment: byId.get(thread.id) ?? null, replyDraft: drafts.get(thread.id) ?? null,
      ...(label ? { label: label.label } : {}), ...(label?.nonBlocking ? { nonBlocking: true as const } : {}),
    };
  });
  for (const item of assessment.items) {
    if (isSummaryItem(item.id)) items.push({ id: item.id, kind: "summary", title: item.title ?? "From your review summary", thread: null, assessment: item, replyDraft: null });
  }
  const run = assessment.run ?? (checkedHead ? null : latest);
  const suggested = run?.suggestedBody.trim();
  return {
    baseline: baselineOf(review), head, items,
    run: run ? { ...run, current: run.headSha === head } : null,
    fetchedAt: store.feedbackFetched(review.targetKey)?.fetchedAt ?? null,
    suggestionInDraft: !!suggested && store.getDraft(review.targetKey).body.trim() === suggested,
  };
}

/** Counts for the list and the turn rules, over every thread plus the summary asks checked. */
export function summarize(headSha: string, items: AssessmentItem[], threadIds: readonly string[]): AssessmentSummary {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = [...new Set([...threadIds, ...items.filter((item) => isSummaryItem(item.id)).map((item) => item.id)])];
  const count = (verdict: AssessmentItem["verdict"]) => ids.filter((id) => byId.get(id)?.verdict === verdict).length;
  return {
    headSha, total: ids.length, addressed: count("addressed"), partial: count("partial"), notAddressed: count("not_addressed"),
    disputed: count("disputed"), unclear: count("unclear"), assessedAt: Math.max(0, ...items.map((item) => item.assessedAt)),
  };
}

/** A Request changes summary listing the blocking feedback that isn't addressed yet. */
export function remainingBody(view: FeedbackView): string {
  const open = view.items.filter((item) => !item.nonBlocking && (item.assessment ? item.assessment.verdict !== "addressed" : item.thread?.status !== "resolved"));
  if (!open.length) return "";
  const line = (item: FeedbackItem) => {
    const where = item.thread?.path ? ` (\`${item.thread.path}${item.thread.line ? `:${item.thread.line}` : ""}\`)` : "";
    const evidence = item.assessment?.evidence ? ` — ${item.assessment.evidence}` : "";
    return `- ${item.title}${where}${evidence}`;
  };
  return ["Thanks for the updates. A few things are still open:", "", ...open.map(line)].join("\n");
}
