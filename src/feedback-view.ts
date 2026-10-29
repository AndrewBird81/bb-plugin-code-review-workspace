// Your feedback, the PR's diffs at the commits that matter, and the assistant's
// check, assembled for Comments and the assistant's tools.
import type { ReviewMeta } from "./store";
import type { runGh } from "./gh";
import { ghErrorMessage, ghPrHeadArgs } from "./gh";
import { diffTooLarge, readFilesPatch, readPrDiff } from "./pr-snapshot";
import { ensureGitHeaders, splitPatchByFile } from "./patch";
import { diffFilesHead } from "./env-diff";
import { interdiff, type FileInterdiff } from "./interdiff";
import { firstLine, type AssessmentItem, type FeedbackItem, type FeedbackView } from "../lib/feedback";
import { baselineOf, type AssessmentSummary } from "../lib/turn";
import type { Verdict } from "./draft";
import { threadLabel } from "./github/threads";
import type { AsyncStore } from "./store-queue";

type Run = typeof runGh;

export { baselineOf } from "../lib/turn";
/** The most files GitHub's compare endpoint lists. */
const COMPARE_FILES = 300;
export const headOf = (review: ReviewMeta) => review.latestHeadSha ?? review.headSha ?? null;
/** Whether the PR has moved on from the guide: new commits, or a new base branch (a stacked PR retargeted). */
export const guideBehind = (review: ReviewMeta) =>
  review.headSha !== headOf(review) || !!review.base && !!review.latestBase && review.latestBase !== review.base;

/**
 * The PR's diff at a commit: saved, the review's own diff, the PR's diff while its head is that commit, or
 * reconstructed by comparing the base branch with that commit.
 */
export async function diffAt(store: AsyncStore, run: Run, review: ReviewMeta, sha: string): Promise<string> {
  // Saved, or the review's own diff, saved as that commit's, in one turn.
  const stored = await store.exclusive(async (tx) => {
    const saved = await tx.getSnapshot(review.targetKey, sha);
    if (saved !== null) return saved;
    if (sha === review.headSha) {
      const patch = await tx.patch(review.targetKey);
      if (patch) { await tx.saveSnapshot(review.targetKey, sha, patch); return patch; }
    }
    return null;
  });
  if (stored !== null) return stored;
  if (!review.repo || !review.number) throw new Error("This review has no GitHub PR.");
  const { repo, number } = review;
  let patch: string | null = null;
  // The PR's diff is that commit's only while the PR's head is that commit before and after the read: the author may push.
  if (sha === headOf(review) && await prHeadIs(run, number, repo, sha)) {
    const read = await readPrDiff(run, number, repo);
    if (await prHeadIs(run, number, repo, sha)) patch = read;
  }
  // The head is compared with the base the PR targets now, a retargeted one included.
  patch ??= await compareDiff(run, repo, (sha === headOf(review) ? review.latestBase : null) ?? review.base ?? "HEAD", sha);
  patch = ensureGitHeaders(patch);
  // A commit picked to compare with lives in the comparisons cache; storing its diff would keep it until a rebuild or submit.
  if (keptDiffs(review).includes(sha)) await store.saveSnapshot(review.targetKey, sha, patch);
  return patch;
}

async function prHeadIs(run: Run, number: number, repo: string, sha: string): Promise<boolean> {
  const out = await run(ghPrHeadArgs(number, repo));
  if (out.code !== 0) throw new Error(ghErrorMessage(out));
  try { return JSON.parse(out.stdout)?.headRefOid === sha; } catch { return false; }
}

/** The diff of the base branch with a commit from their merge base, as GitHub showed the PR at that commit. */
async function compareDiff(run: Run, repo: string, base: string, sha: string): Promise<string> {
  const compare = `repos/${repo}/compare/${encodeURIComponent(base)}...${sha}`;
  const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", compare]);
  if (diff.code === 0) return diff.stdout;
  if (!diffTooLarge(diff)) throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: ${ghErrorMessage(diff)}`);
  // Too large for a diff: rebuild it from the comparison's files.
  const patch = await readFilesPatch(run, ["api", compare, "--jq", ".files[] | @json"])
    .catch((error: Error) => { throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: ${error.message}`); });
  // The comparison lists at most 300 files; a diff missing the rest would show them as added since.
  if (splitPatchByFile(patch).length >= COMPARE_FILES) {
    throw new Error(`Couldn't read the PR as of ${sha.slice(0, 7)}: GitHub's comparison lists at most ${COMPARE_FILES} files, and the PR may have had more than ${COMPARE_FILES} files then.`);
  }
  return patch;
}

/** The diffs this review still needs: its guide's, your review's, and the PR's head. */
const keptDiffs = (review: ReviewMeta) => [review.headSha, baselineOf(review).sha, headOf(review)].filter((sha): sha is string => !!sha);

/** Keep the diffs this review still needs, and a local review's diff's files. */
export async function pruneDiffs(store: AsyncStore, review: ReviewMeta) {
  const live = review.feature ? [diffFilesHead(await store.patchHash(review.targetKey))] : [];
  await store.pruneSnapshots(review.targetKey, [...keptDiffs(review), ...live]);
}

/** How long a review stays out of play (merged, closed, or archived) before its stored diffs are dropped. */
const PRUNE_AFTER = 30 * 86_400_000;

/**
 * Drop the stored diffs of merged and closed PRs' reviews out of play for a month: the diff, its snapshots,
 * and a kept guide's backup. The guide, draft, notes, and GitHub state stay, and so does an earlier diff
 * you last reviewed, which Since your review compares with. Opening such a review reads its diff again, at
 * the PR's own head (diffAt). Left alone: open PRs, which can come back into play with agents reading the
 * diff before you open it; reviews whose guide is for an earlier head, whose diff GitHub may not rebuild
 * (the base has it, or the base branch is gone); and drafts with comments, which follow their lines into a
 * new diff. Returns the reviews pruned.
 */
export async function pruneOldDiffs(store: AsyncStore, now: number): Promise<string[]> {
  return store.exclusive(async (tx) => {
    const pruned: string[] = [];
    for (const review of await tx.listReviews()) {
      const since = Math.min(review.archivedAt ?? Infinity, review.userArchivedAt ?? Infinity);
      // A local review whose folder bb removed has nothing to read again, and nothing waits on it once archived.
      const folderGone = review.kind === "ref" && !!review.feature?.folderGone && !!review.archivedAt;
      if (folderGone && now - since >= PRUNE_AFTER && !(await tx.getDraft(review.targetKey)).comments.length && await tx.hasPatch(review.targetKey)) {
        await tx.dropPatch(review.targetKey);
        await tx.pruneSnapshots(review.targetKey, []);
        pruned.push(review.targetKey);
        continue;
      }
      if (review.kind !== "pr" || review.status !== "ready" || !review.headSha || now - since < PRUNE_AFTER) continue;
      if (review.prState !== "MERGED" && review.prState !== "CLOSED" || headOf(review) !== review.headSha) continue;
      if (!await tx.hasPatch(review.targetKey) || (await tx.getDraft(review.targetKey)).comments.length) continue;
      const baseline = baselineOf(review).sha;
      await tx.dropPatch(review.targetKey);
      await tx.pruneSnapshots(review.targetKey, baseline && baseline !== review.headSha ? [baseline] : []);
      pruned.push(review.targetKey);
    }
    return pruned;
  });
}

type SinceReview = { baseline: { sha: string; at: number | null; verdict: Verdict | null }; files: FileInterdiff[] };
/** The latest comparisons, by review and starting commit, for the few compared last. */
const compared = new WeakMap<AsyncStore, Map<string, { key: string; since: SinceReview }>>();
const COMPARED_REVIEWS = 8;

/**
 * The displayed diff compared with the diff at your last review, or at `from`, a commit you picked;
 * null when there's nothing to compare. An added file's patch is left out: the page has its whole diff already.
 */
export async function sinceReview(store: AsyncStore, run: Run, review: ReviewMeta, from?: string): Promise<SinceReview | null> {
  const baseline = from ? { sha: from, at: null, verdict: null } : baselineOf(review);
  if (!baseline.sha || !review.headSha || baseline.sha === review.headSha) return null;
  const cache = compared.get(store) ?? new Map<string, { key: string; since: SinceReview }>();
  compared.set(store, cache);
  const key = JSON.stringify([baseline, await store.patchHash(review.targetKey)]);
  const slot = `${review.targetKey}\0${from ?? ""}`;
  const hit = cache.get(slot);
  cache.delete(slot);
  if (hit?.key === key) {
    cache.set(slot, hit);
    return hit.since;
  }
  const reviewed = await diffAt(store, run, review, baseline.sha);
  const current = await store.patch(review.targetKey);
  const files = interdiff(reviewed, current).map((f) => (f.status === "added" ? { ...f, patch: "" } : f));
  const since = { baseline: { ...baseline, sha: baseline.sha }, files };
  cache.set(slot, { key, since });
  if (cache.size > COMPARED_REVIEWS) cache.delete(cache.keys().next().value!);
  return since;
}

export interface PrCommit { sha: string; headline: string; committedAt: number | null }
/** The commits listed last, by PR and head: a push changes the key. */
const listed = new Map<string, PrCommit[]>();

/** The PR's commits up to the diff shown, newest first: where a comparison can start. */
export async function prCommits(run: Run, review: ReviewMeta): Promise<PrCommit[]> {
  if (!review.repo || !review.number) throw new Error("This review has no GitHub PR.");
  const key = `${review.repo}#${review.number}@${headOf(review)}`;
  let commits = listed.get(key);
  if (!commits) {
    const out = await run(["api", "--paginate", `repos/${review.repo}/pulls/${review.number}/commits?per_page=100`, "--jq",
      '.[] | {sha, at: .commit.committer.date, headline: (.commit.message | split("\\n")[0])} | @json']);
    if (out.code !== 0) throw new Error(`Couldn't read the PR's commits: ${ghErrorMessage(out)}`);
    commits = out.stdout.split("\n").filter(Boolean).map((line) => {
      const row = JSON.parse(line) as { sha: string; at: string | null; headline: string | null };
      return { sha: row.sha, headline: row.headline ?? "", committedAt: (row.at && Date.parse(row.at)) || null };
    });
    listed.set(key, commits);
    if (listed.size > COMPARED_REVIEWS) listed.delete(listed.keys().next().value!);
  }
  // Commits pushed after the diff shown aren't in it.
  const shown = commits.findIndex((commit) => commit.sha === review.headSha);
  return (shown >= 0 ? commits.slice(0, shown + 1) : commits).slice().reverse();
}

/** Summary asks are the assistant's items "summary:<n>". */
export const isSummaryItem = (id: string) => /^summary:\d+$/.test(id);

/** Your feedback, the assistant's latest check, and drafted replies. */
export async function feedbackView(store: AsyncStore, review: ReviewMeta): Promise<FeedbackView> {
  return store.exclusive(async (tx) => {
    const head = headOf(review);
    const threads = await tx.listFeedbackThreads(review.targetKey);
    const latest = await tx.latestAssessmentRun(review.targetKey);
    // The check of the head now; otherwise the latest check, marked as older.
    const checkedHead = head && (await tx.getAssessment(review.targetKey, head)).items.length ? head : latest?.headSha ?? null;
    const assessment = checkedHead ? await tx.getAssessment(review.targetKey, checkedHead) : { items: [], run: null };
    const byId = new Map(assessment.items.map((item) => [item.id, item]));
    const drafts = await tx.listReplyDrafts(review.targetKey);
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
      fetchedAt: (await tx.feedbackFetched(review.targetKey))?.fetchedAt ?? null,
      suggestionInDraft: !!suggested && (await tx.getDraft(review.targetKey)).body.trim() === suggested,
    };
  });
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
