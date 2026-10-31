// Watching a local review's branch for its PR (1.9.0), so the review becomes the PR's soon after the PR opens, whoever
// opens it: a thread in the folder running git push or gh pr create (T1), Push's read when the main thread stops (T2,
// src/push.ts), a poll every 2 minutes (T3), and the review's open page (T4). GitHub is read once per check, for any
// number of reviews; the review becomes the PR's through src/feature-review.ts becomePr.
import { ghErrorMessage, type runGh } from "./gh";
import { becomePr, folderBranchOf } from "./feature-review";
import { featureBase } from "./env-diff";
import { parsePrLink } from "../lib/pr-link";
import type { FeatureReview, ReviewMeta } from "./store";
import { githubWaits } from "./review-lifecycle";
import type { EventListeners, RpcHandlers, ServeDeps } from "./server-modules";

type Run = typeof runGh;
type Deps = Pick<ServeDeps, "bb" | "store" | "gh" | "changed"> & { sync: Pick<ServeDeps["sync"], "one" | "health"> };
type Watched = ReviewMeta & { feature: FeatureReview & { repo: string } };

/** An open PR, a draft too, from a branch: in the repo it goes to. */
export interface BranchPr { repo: string; number: number; url: string; createdAt: number }
/** A branch on GitHub: its head, null when it isn't there, and its open PRs, newest first; or why it couldn't be read. */
export type BranchRead = { sha: string | null; prs: BranchPr[] } | { error: string };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The least time between two checks of a review, but for a thread's push or Push's own read. */
const CHECK_GAP = 15 * SECOND;
/** The least time between two checks a review's page asks for. */
const PAGE_GAP = 25 * SECOND;
const POLL_EVERY = 2 * MINUTE;
/** How often a branch that isn't on GitHub is polled, until a thread pushes; and how long the poll waits after GitHub fails. */
const UNPUSHED_EVERY = 10 * MINUTE;
/** How long a thread's events in a folder no review watched read no reviews. */
const UNWATCHED_GAP = 5 * SECOND;
/** Reviews read in one request. */
const BATCH = 20;
/** A command that may have opened a PR, as PR Status looks for them. */
const OPENS_PR = /(?:^|[\s;&|"'(])(git\s+push\b|gh\s+(pr\s+(create|new)\b|api\b.*\bpulls\b))/;

const PR_NODES = "nodes{ number url createdAt baseRepository{ nameWithOwner } headRepository{ nameWithOwner } }";

/**
 * Read each of `branches` on GitHub, in one request: its head, and its open PRs from it, into its repo or, from a
 * fork, into the repo it was forked from; never another fork's branch of the same name.
 */
export async function readBranches(run: Run, branches: Array<{ repo: string; branch: string }>): Promise<BranchRead[]> {
  const text = JSON.stringify;
  const parts = branches.map(({ repo, branch }, i) => {
    const [owner, name] = repo.split("/");
    return `b${i}: repository(owner:${text(owner)},name:${text(name)}){ ref(qualifiedName:${text(`refs/heads/${branch}`)}){ target{ oid } associatedPullRequests(states:OPEN,first:5){ ${PR_NODES} } }
      parent{ pullRequests(headRefName:${text(branch)},states:OPEN,first:5){ ${PR_NODES} } } }`;
  });
  const r = await run(["api", "graphql", "-f", `query=query{ ${parts.join("\n")} }`]);
  let data: any;
  try { data = JSON.parse(r.stdout)?.data; } catch { /* reported below */ }
  return branches.map(({ repo, branch }, i): BranchRead => {
    const found = data?.[`b${i}`];
    if (!found) return { error: `Couldn’t read ${branch} on GitHub: ${ghErrorMessage(r)}` };
    const prs = new Map<string, BranchPr>();
    for (const node of [...found.ref?.associatedPullRequests?.nodes ?? [], ...found.parent?.pullRequests?.nodes ?? []]) {
      if (node?.headRepository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase() || !node.baseRepository?.nameWithOwner || !node.number) continue;
      prs.set(node.url, { repo: node.baseRepository.nameWithOwner, number: node.number, url: node.url, createdAt: Date.parse(node.createdAt) || 0 });
    }
    return { sha: found.ref?.target?.oid ?? null, prs: [...prs.values()].sort((a, b) => b.createdAt - a.createdAt) };
  });
}

/** A local review whose branch may get a PR: of a folder that's still there, in a GitHub repo, not archived or offering to merge with its PR's review. */
const watched = (review: ReviewMeta | null): review is Watched => !!review && review.kind === "ref" && !!review.feature?.repo && !review.feature.folderGone
  && !review.prOffer && !review.archivedAt && !review.userArchivedAt;

/** The review becomes the newest PR `read` found, if any. Returns whether it found one. */
export async function becomeFound(deps: Parameters<typeof becomePr>[0], key: string, read: BranchRead): Promise<boolean> {
  const pr = "prs" in read ? read.prs[0] : undefined;
  if (!pr) return false;
  await becomePr(deps, key, { repo: pr.repo, number: pr.number }).catch((error) => deps.bb.log.warn(`Could not make ${key} the review of ${pr.url}: ${String(error)}`));
  return true;
}

/**
 * PR Status's PR for the review's folder, while it's on the review's branch: PR Status finds it by the branch's upstream,
 * so it names one pushed under another name too.
 */
async function statusPr(deps: Deps, feature: Watched["feature"]): Promise<{ repo: string; number: number } | null> {
  const env = await deps.bb.sdk.environments.get({ environmentId: feature.environmentId }).catch(() => null);
  if (env?.status !== "ready" || env.branchName !== folderBranchOf(feature)) return null;
  const found = await featureBase(deps.bb, env, feature.repo);
  const pr = "pr" in found ? found.pr : undefined;
  const link = pr?.url ? parsePrLink(pr.url) : null;
  if (!pr?.number || !link || link.repo.toLowerCase() !== feature.repo.toLowerCase() || pr.state !== undefined && !/^(open|draft)$/i.test(pr.state)) return null;
  return { repo: link.repo, number: pr.number };
}

export function register(deps: Deps) {
  const { bb, store, gh } = deps;
  /** Each review's check in flight, and when each was last checked, and asked for by its page. */
  const running = new Map<string, Promise<void>>();
  const checkedAt = new Map<string, number>();
  const pageAt = new Map<string, number>();
  /** When each review's branch was last found not to be on GitHub. */
  const unpushed = new Map<string, number>();
  let polledAt = 0;
  let pollAfter = 0;
  /** The last event of each thread read, and each thread's read in flight. */
  const cursors = new Map<string, number>();
  const scanning = new Map<string, Promise<void>>();
  /** The folders watched reviews were in, and when the reviews were read for them. */
  let watchedFolders: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
  /** What's kept of a review the watch no longer watches (it became its PR's, or went to Archive, or was deleted) goes. */
  const forget = (key: string) => { for (const map of [checkedAt, pageAt, unpushed]) map.delete(key); };

  /** What a read of the review's branch found: whether it's on GitHub, which the poll goes by, and its PR, which the review becomes. */
  const settle = async (review: Watched, read: BranchRead, now: number) => {
    if ("sha" in read && read.sha === null) unpushed.set(review.targetKey, now);
    else if ("sha" in read) unpushed.delete(review.targetKey);
    return becomeFound(deps, review.targetKey, read);
  };

  /**
   * Look for the review's PR now, once at a time, and no sooner than 15 seconds after the last look unless a thread's
   * command asks (`why` "thread"), when PR Status's PR for the folder counts too. The page's waits as the poll does.
   */
  function check(key: string, why: "thread" | "page"): Promise<void> {
    const now = Date.now();
    const inFlight = running.get(key);
    if (inFlight) return inFlight;
    if (why !== "thread" && now - (checkedAt.get(key) ?? 0) < CHECK_GAP) return Promise.resolve();
    if (why === "page" && (githubWaits(deps.sync.health(), now) || now - (unpushed.get(key) ?? -Infinity) < UNPUSHED_EVERY)) return Promise.resolve();
    checkedAt.set(key, now);
    const work = (async () => {
      const review = await store.getReview(key);
      if (!watched(review)) return forget(key);
      const { feature } = review;
      const [read] = await readBranches(gh.runGh, [{ repo: feature.repo, branch: feature.remoteBranch ?? feature.branch }]);
      if (await settle(review, read!, now) || why !== "thread") return;
      const pr = await statusPr(deps, feature);
      if (pr) await becomePr(deps, key, pr);
    })().catch((error) => bb.log.warn(`Could not look for the PR of ${key}: ${String(error)}`)).finally(() => running.delete(key));
    running.set(key, work);
    return work;
  }

  /**
   * Every 2 minutes, every watched review in one request, but while GitHub limits reads or gh isn't signed in; a branch
   * that isn't on GitHub every 10 minutes, until a thread pushes; after a failed read, in 10 minutes.
   */
  async function poll(): Promise<void> {
    const now = Date.now();
    if (now - polledAt < POLL_EVERY || now < pollAfter || githubWaits(deps.sync.health(), now)) return;
    polledAt = now;
    const all = (await store.listReviews()).filter(watched);
    const keys = new Set(all.map((review) => review.targetKey));
    for (const map of [checkedAt, pageAt, unpushed]) for (const key of map.keys()) if (!keys.has(key) && !running.has(key)) forget(key);
    const due = all.filter((review) => !running.has(review.targetKey)
      && now - (checkedAt.get(review.targetKey) ?? 0) >= CHECK_GAP && now - (unpushed.get(review.targetKey) ?? -Infinity) >= UNPUSHED_EVERY);
    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      // Whether GitHub answered.
      const answered = (async () => {
        const reads = await readBranches(gh.runGh, batch.map(({ feature }) => ({ repo: feature.repo, branch: feature.remoteBranch ?? feature.branch })));
        if (reads.every((read) => "error" in read)) return false;
        for (const [at, review] of batch.entries()) await settle(review, reads[at]!, now);
        return true;
      })().catch((error) => { bb.log.warn(`Could not look for local reviews' PRs: ${String(error)}`); return false; });
      const work = answered.then(() => {});
      for (const review of batch) {
        checkedAt.set(review.targetKey, now);
        running.set(review.targetKey, work);
      }
      const ok = await answered;
      for (const review of batch) if (running.get(review.targetKey) === work) running.delete(review.targetKey);
      if (!ok) {
        pollAfter = now + UNPUSHED_EVERY;
        return;
      }
    }
  }

  /**
   * Read a thread's new commands, when a review watches its folder: one that may have opened a PR checks that review at
   * once, and a push polls its branch again. One read per thread at a time; never the plugin's own, hidden, threads.
   */
  function scan(thread: { id: string; environmentId?: string | null; visibility?: string }): Promise<void> {
    if (thread.visibility === "hidden" || !thread.environmentId) return Promise.resolve();
    const next = (scanning.get(thread.id) ?? Promise.resolve()).then(async () => {
      const now = Date.now();
      if (now - watchedFolders.at < UNWATCHED_GAP && !watchedFolders.ids.has(thread.environmentId!)) return void cursors.delete(thread.id);
      const all = (await store.listReviews()).filter(watched);
      watchedFolders = { at: now, ids: new Set(all.map((review) => review.feature.environmentId)) };
      const reviews = all.filter((review) => review.feature.environmentId === thread.environmentId);
      // A folder no review watches: its thread's next read starts at its latest commands, as a first one does.
      if (!reviews.length) return void cursors.delete(thread.id);
      const after = cursors.get(thread.id);
      // The first read of a thread takes its latest commands.
      const rows = await bb.sdk.threads.events?.list({ threadId: thread.id, types: ["item/completed"], limit: "100", ...after === undefined ? { order: "desc" } : { afterSeq: String(after), order: "asc" } });
      if (!rows?.length) return;
      cursors.set(thread.id, Math.max(after ?? 0, ...rows.map((row) => row.seq)));
      const found = rows.flatMap((row) => {
        const item = row.type === "item/completed" ? row.data.item : null;
        const match = item?.type === "commandExecution" ? OPENS_PR.exec(item.command) : null;
        return match ? [match[1]!] : [];
      });
      if (!found.length) return;
      if (found.some((command) => command.startsWith("git"))) for (const review of reviews) unpushed.delete(review.targetKey);
      await Promise.all(reviews.map((review) => check(review.targetKey, "thread")));
    }).catch((error) => bb.log.warn(`Could not read the commands of thread ${thread.id}: ${String(error)}`));
    scanning.set(thread.id, next);
    void next.finally(() => { if (scanning.get(thread.id) === next) scanning.delete(thread.id); });
    return next;
  }

  const handlers = {
    // The review's page, every 30 seconds while it shows: a PR opened on GitHub is found within the minute.
    async checkPr({ targetKey }) {
      const now = Date.now();
      if (now - (pageAt.get(targetKey) ?? 0) < PAGE_GAP) return { ok: true };
      pageAt.set(targetKey, now);
      await check(targetKey, "page");
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;

  // Every thread in a watched folder, not only its review's main thread.
  const events: EventListeners = {
    "experimental_thread.events": [({ thread }) => scan(thread)],
    "thread.idle": [({ thread }) => scan(thread)],
    "thread.failed": [({ thread }) => scan(thread)],
  };
  return { handlers, events, poll };
}
