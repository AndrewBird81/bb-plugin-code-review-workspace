// A feature review: a local review of a folder and branch, one however many threads work there, addressed to its main
// thread, the top thread working in that folder. `bb review` with no arguments starts it, or opens it as it is. Its page
// checks the folder (changed, on another branch, its machine offline, other threads there); once its branch has a PR
// the same review becomes that PR's; and bb removing the folder ends it, unless comments wait on it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { placeOn, reanchorDraft, type FeatureReview, type MainThread, type PushRun, type ReviewLifecycle, type ReviewMeta, type Store } from "./store";
import type { AsyncStore } from "./store-queue";
import { diffFilesHead, folderHas, folderHasBranch, folderHasSince, folderHead, isNotFound, isSecretPath, readFeatureDiff, readFeatureRevisions, type FeatureDiff, type FolderPr, type HiddenFile } from "./env-diff";
import { featureKey, mergedSurvivor, prReviewKey, targetKey } from "./targets";
import { beginGuide, guideWriterUnavailable, stopGuide } from "./generate";
import { pruneDiffs } from "./feedback-view";
import { readPrSnapshot } from "./pr-snapshot";
import { prHead } from "./own-pr";
import { ensureGitHeaders, splitPatchByFile } from "./patch";
import { normalizedFileHash } from "./diff-hash";
import { machineStatus } from "./machines";
import { identityIn, placeFacts, remoteRepo } from "./review-places";
import { defaultName } from "../lib/review-name";
import { localIdOf } from "../lib/review-identity";
import { assistantReview } from "./draft-comments";
import { retitleAssistant } from "./agent";
import { hasUserContent, mergeIn, mergeReviews, movesOf } from "./merge";
import { formerWorkerReview } from "./former-workers";
import { parsePrLink } from "../lib/pr-link";
import { NOT_PUSHED } from "../lib/push";
import { isLocal, sameLocation } from "./draft";
import { githubWaits } from "./review-lifecycle";
import type { EventListeners, RpcHandlers, ServeDeps } from "./server-modules";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
interface Deps { bb: BbPluginApi; store: AsyncStore; gh: ServeDeps["gh"]; changed(targetKey: string): void; sync?: Pick<ServeDeps["sync"], "one" | "health"> }

/** How long a PR GitHub didn't answer for waits before a check reads it again. */
const ERROR_RETRY = 60_000;

const live = (thread: Pick<Thread, "archivedAt" | "deletedAt">) => !thread.archivedAt && !thread.deletedAt;
const threadTitle = (thread: Pick<Thread, "title" | "titleFallback">) => thread.title ?? thread.titleFallback ?? null;
/** A home folder as ~, as the review shows it. */
export const homeShort = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/** The thread, or null when BB has no such thread. Any other failure throws: it says nothing about the thread. */
async function threadOf(bb: BbPluginApi, threadId: string): Promise<Thread | null> {
  return bb.sdk.threads.get({ threadId }).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
}

/** Whether the thread is gone for good, archived or deleted; null when BB couldn't say. */
async function threadGone(bb: BbPluginApi, threadId: string): Promise<{ gone: boolean; thread: Thread | null } | null> {
  try {
    const thread = await threadOf(bb, threadId);
    return { gone: !thread || !live(thread), thread };
  } catch {
    return null;
  }
}

/**
 * The thread a folder's comments go to: the highest of `caller` and its ancestors that still works in its folder. A
 * subagent bb spawned, or one sharing its parent's thread, finds the thread that leads the work; an orchestrator in
 * another folder is passed over. Each step reads one thread (threads.get, not experimental_listAncestors, which older
 * BBs lack); a parent BB no longer has ends the walk, and any other failure throws, as the leader can't be told.
 */
export async function mainThreadOf(bb: BbPluginApi, caller: Thread): Promise<Thread> {
  let main = caller;
  let at = caller;
  // A cycle, which BB shouldn't make, ends here too.
  for (let depth = 0; at.parentThreadId && depth < 50; depth++) {
    const parent = await threadOf(bb, at.parentThreadId);
    if (!parent) break;
    if (parent.environmentId === caller.environmentId && live(parent)) main = parent;
    at = parent;
  }
  return main;
}

/** What a folder's review needs to know of it: bb's environment, its machine's name, and its project's GitHub repo. */
interface Folder { env: Environment & { path: string; branchName: string }; machine: string; repo: string | null }

async function folderOf(bb: BbPluginApi, environmentId: string): Promise<Folder | { error: string }> {
  let env: Environment;
  try {
    env = await bb.sdk.environments.get({ environmentId });
  } catch {
    return { error: "Couldn’t read this thread’s folder from BB. Try again in a moment." };
  }
  if (env.status !== "ready" || !env.path) return { error: "This thread’s folder isn’t ready yet. Try again once it is." };
  if (!env.isGitRepo) return { error: "This thread’s folder isn’t a git repository, so it has no changes to review." };
  if (!env.branchName) return { error: "This thread’s folder isn’t on a branch, so there’s no feature to review. Check out a branch, or pass a git ref." };
  const [machine, project] = await Promise.all([
    machineStatus(bb, env.hostId),
    bb.sdk.projects.get({ projectId: env.projectId }).catch(() => null),
  ]);
  return { env: env as Folder["env"], machine: machine?.name ?? "its machine", repo: remoteRepo(project?.gitRemoteUrl) };
}

/** What the review says when a folder has nothing to show. */
function nothingToReview(read: Extract<FeatureDiff, { outcome: "available" }>): string {
  return read.hidden.length
    ? `The folder’s only changes against ${read.base} are files the review keeps out (${read.hidden.map((file) => file.path).join(", ")}). Open the review once there’s code to read.`
    : `No changes found in the folder against ${read.base}.`;
}

/**
 * Keep what a read of the folder found as the review's diff, in the caller's block: the patch, its comments moved with
 * their lines, the base, and the revisions and hidden files beside it (src/env-diff.ts diffFilesHead).
 */
async function saveRead(tx: AsyncStore, key: string, feature: FeatureReview, read: Extract<FeatureDiff, { outcome: "available" }>) {
  const previous = await tx.patch(key);
  await tx.savePatch(key, read.patch);
  if (previous) await tx.rebaseDraftComments(key, await reanchorDraft(tx, key, previous, read.patch));
  await tx.setLifecycle(key, { feature: { ...feature, baseRef: read.base, mergeBaseRef: read.mergeBaseRef, pausedOn: null, changedFiles: null } });
  await pruneDiffs(tx, (await tx.getReview(key))!);
  await tx.saveSnapshotFiles(key, diffFilesHead(await tx.patchHash(key)), { revisions: read.revisions, hidden: read.hidden });
}

/**
 * The lifecycle that records `main` as the review's main thread, the one before it, if any, kept as an implementer:
 * adopted, one already working in the folder, or fresh, one a Send started.
 */
export function mainThreadState(review: Pick<ReviewMeta, "mainThread" | "implementers"> | null, main: Pick<Thread, "id" | "environmentId">, now: number, origin: MainThread["origin"] = "adopted", fixer?: MainThread["fixer"]): ReviewLifecycle {
  const mainThread: MainThread = { threadId: main.id, environmentId: main.environmentId ?? null, origin, since: now, ...fixer ? { fixer } : {} };
  const before = review?.mainThread;
  // The thread a Send goes to until Send has its own (src/fix-handoff.ts), and its title as the review shows it.
  return { mainThread, sourceThreadId: main.id, sourceThreadAt: now, ...before ? { implementers: [...review.implementers ?? [], before] } : {} };
}

/** The review opened: whether it was started, whether its main thread was replaced and by which, and whether anything in it changed. */
type Opened = { key: string; created: boolean; replaced: { threadId: string; title: string | null } | null; main: { threadId: string; title: string | null }; changed: boolean };

/**
 * Open the review of `folder` at its branch now, addressed to `main`, or start it: an existing one opens as it is, with
 * its main thread, unless that thread is archived or deleted and `main` is live. `run` starts its guide once called.
 */
async function openFolderReview(deps: Deps, folder: Folder, main: Thread | null, options: { name?: string; context?: string } = {}): Promise<{ opened: Opened; run?: () => Promise<void> } | { error: string }> {
  const { bb, store } = deps;
  const { env, machine, repo } = folder;
  // A review re-homed to a fixer's worktree, on that worktree's branch, is the folder's review: its key is its old folder's;
  // so is one that followed the folder onto this branch. A key whose review moved on gives way to the next; one merged
  // into another review of its PR, which goes on, to that one.
  const reviews = await store.listReviews();
  let exact = featureKey(env.id, env.branchName);
  let survivor: string | undefined;
  for (let n = 2, keyed = reviews.find((review) => review.targetKey === exact); keyed && movedOn(keyed, env.branchName); n++) {
    const into = keyed.mergedInto ? mergedSurvivor(keyed, reviews) : null;
    if (into && !into.mergedInto && !prEnded(into)) {
      survivor = into.targetKey;
      break;
    }
    exact = featureKey(env.id, env.branchName, n);
    keyed = reviews.find((review) => review.targetKey === exact);
  }
  const key = survivor ?? (reviews.some((review) => review.targetKey === exact) ? exact
    : reviewOfFolder(reviews.filter((review) => !movedOn(review, env.branchName)), env.id, env.branchName)?.targetKey ?? exact);
  const existing = await store.getReview(key);
  // A recorded main thread that's archived or deleted gives way to the live one asking. One BB can't read now stays.
  const checked = existing?.mainThread && main && existing.mainThread.threadId !== main.id ? await threadGone(bb, existing.mainThread.threadId) : null;
  const recorded = checked?.thread ?? null;
  const gone = !!checked?.gone;
  let read: FeatureDiff | undefined;
  if (!existing) {
    if (!main) return { error: "Couldn’t tell which thread leads the work in this folder: BB didn’t answer for one of this thread’s parents. Try again in a moment." };
    const unavailable = await guideWriterUnavailable(bb, store);
    if (unavailable) return { error: unavailable };
    read = await readFeatureDiff(bb, { environmentId: env.id, machine, repo, branch: env.branchName });
    if (read.outcome !== "available") return { error: read.message };
    if (!read.patch.trim()) return { error: nothingToReview(read) };
  }
  let run: (() => Promise<void>) | undefined;
  const now = Date.now();
  const result = await store.exclusive(async (tx): Promise<{ opened: Opened } | { error: string }> => {
    const review = await tx.getReview(key);
    let created = false;
    let replaced: Opened["replaced"] = null;
    if (!review) {
      // Read first above, unless another call started it meanwhile: this one only opens it.
      if (!main || !read || read.outcome !== "available") return { error: "This folder’s review was deleted just now. Run bb review again to start a new one." };
      const feature: FeatureReview = { environmentId: env.id, hostId: env.hostId, machine, path: env.path, branch: env.branchName, baseRef: read.base, mergeBaseRef: read.mergeBaseRef, repo };
      // Named after the main thread, as it's called now. Kept as "ref" with no cwd, so 1.7.0 never runs git on it.
      const title = threadTitle(main) ?? undefined;
      await tx.saveReview({ targetKey: key, kind: "ref", gitRef: env.branchName, ...title ? { title } : {}, status: "generating", createdAt: now, projectId: env.projectId });
      await tx.setLifecycle(key, { feature, ...mainThreadState(null, main, now) });
      await saveRead(tx, key, feature, read);
      created = true;
    } else {
      if (main && gone && review.mainThread?.threadId === existing!.mainThread!.threadId) {
        replaced = { threadId: review.mainThread!.threadId, title: recorded ? threadTitle(recorded) : null };
        await tx.setLifecycle(key, mainThreadState(review, main, now));
      }
      // Asked for again, it's back from your archive.
      if (review.userArchivedAt) await tx.setLifecycle(key, { userArchivedAt: null });
    }
    const changed = created || !!replaced || !!review?.userArchivedAt || options.name !== undefined || options.context !== undefined;
    if (options.context !== undefined) await tx.setReviewContext(key, options.context.trim() || null);
    if (options.name !== undefined) {
      const named = (await tx.getReview(key))!;
      await tx.setLifecycle(key, { name: options.name && options.name !== defaultName(named) ? options.name : null });
    }
    if (created) run = await beginGuide(bb, tx, store, key, env.projectId);
    const threadId = (await tx.getReview(key))!.mainThread?.threadId ?? main?.id ?? "";
    return { opened: { key, created, replaced, changed, main: { threadId, title: threadId === main?.id ? threadTitle(main) : recorded && threadTitle(recorded) } } };
  });
  return "error" in result ? result : { ...result, run };
}

/** The branch a folder's review reads in its folder: a fresh thread's worktree's own branch, else the review's. */
export const folderBranchOf = (feature: Pick<FeatureReview, "branch" | "workBranch">) => feature.workBranch ?? feature.branch;

/**
 * Whether the review keyed for its folder and `branch` is no longer that branch's: it followed the folder onto another,
 * or it became a PR's that merged, or closed and went to Archive, and the branch is used again for new work; or it was
 * merged into another review of its PR.
 */
const movedOn = (review: ReviewMeta, branch: string) => !!review.feature && folderBranchOf(review.feature) !== branch || prEnded(review) || !!review.mergedInto;
/** Whether a review's PR merged, or closed and went to Archive. */
const prEnded = (review: ReviewMeta) => review.kind === "pr" && (review.prState === "MERGED" || review.prState === "CLOSED" && !!review.archivedAt);

/**
 * The review of a folder at the branch it's on, by where the review reads it (folderBranchOf), as the thread pages'
 * index links it: one re-homed to a fixer's worktree keeps a key of its old folder's. Newest first; never one whose
 * folder is gone, nor one the sync archived as its PR merged or closed (one you archived comes back).
 */
export function reviewOfFolder(reviews: readonly ReviewMeta[], environmentId: string, branch: string): (ReviewMeta & { feature: FeatureReview }) | null {
  return reviews.map(featureOf).filter((review) => !!review && !review.feature.folderGone && !review.archivedAt && review.feature.environmentId === environmentId && folderBranchOf(review.feature) === branch)
    .sort((a, b) => b!.createdAt - a!.createdAt)[0] ?? null;
}

/**
 * Whether a thread is one of the plugin's own: a review's agent, a guide writer, one that was either, or the Suggest
 * instructions worker; with `hidden`, any hidden thread too, as they all are. Never a folder review's main thread.
 */
async function pluginThread(deps: Deps, thread: Thread, hidden: boolean): Promise<boolean> {
  if (hidden && thread.visibility === "hidden") return true;
  if (await deps.store.exclusive(async (tx) => !!await assistantReview(tx, thread.id) || !!await tx.generationOf(thread.id))) return true;
  return await formerWorkerReview(deps.bb, thread.id) !== null;
}

/** The parts of `bb review`'s output the no-argument form takes. */
interface FeatureCommand { name?: string; context?: string; inThreads: boolean }
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

/**
 * The folder `threadId` works in and the top thread working there, as `bb review` with no arguments finds them, or why
 * not: neither may be one of the plugin's own threads, as a thread a review agent started would lead to its agent.
 */
async function callerFolder(deps: Deps, threadId: string): Promise<{ caller: Thread; folder: Folder; main: Thread | null } | { exitCode: number; stderr: string }> {
  const { bb } = deps;
  let caller: Thread | null;
  try {
    caller = await threadOf(bb, threadId);
  } catch (error) {
    return { exitCode: 1, stderr: `Couldn’t read this thread from BB: ${error instanceof Error ? error.message : String(error)}. Try again in a moment.` };
  }
  if (!caller) return { exitCode: 1, stderr: "BB has no record of this thread. Run `bb review` in a thread that works in a folder." };
  if (!caller.environmentId) return { exitCode: 2, stderr: "This thread has no folder yet. Run `bb review` once it’s working in one." };
  const agents = "This thread is one of Code Review Workspace’s agents, or works under one, so it can’t start a review of its folder. Run it in a thread working on the change.";
  // A hidden subagent of yours may run bb review; the thread it leads to may not be hidden.
  if (await pluginThread(deps, caller, false)) return { exitCode: 2, stderr: agents };
  const folder = await folderOf(bb, caller.environmentId);
  if ("error" in folder) return { exitCode: 1, stderr: folder.error };
  // Unknown, it starts no review, and an existing one keeps its main thread.
  const main = await mainThreadOf(bb, caller).catch(() => null);
  if (main && await pluginThread(deps, main, true)) return { exitCode: 2, stderr: agents };
  return { caller, folder, main };
}

/**
 * `bb review` with no arguments: the review of the folder the calling thread works in, at its branch now, started or
 * opened as it is, addressed to the top thread working there. `ownReview`: a review's own agent ran it, which may not.
 */
export async function runFeatureCommand(deps: Deps, command: FeatureCommand, ctx: Ctx, ownReview?: string) {
  const { bb, store } = deps;
  if (ownReview !== undefined) return { exitCode: 2, stderr: "A review’s own agent can’t start a review of a folder." };
  if (!ctx.threadId) return { exitCode: 2, stderr: "Run `bb review` with no arguments in a bb thread: it reviews the changes in that thread’s folder. Outside a thread, pass a PR or a git ref." };
  const found = await callerFolder(deps, ctx.threadId);
  if ("stderr" in found) return { exitCode: found.exitCode, stderr: found.stderr };
  const { folder, main } = found;
  let started: Awaited<ReturnType<typeof openFolderReview>>;
  try {
    started = await openFolderReview(deps, folder, main, command);
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
  if ("error" in started) return { exitCode: 1, stderr: started.error };
  void started.run?.();
  const { key, created, replaced, main: to, changed } = started.opened;

  const review = (await store.getReview(key))!;
  const identity = identityIn(await placeFacts(bb, [review]), await store.listReviews(), review);
  const which = `${identity.id}${identity.line === identity.id ? "" : ` ${JSON.stringify(identity.name)}`} (${key})`;
  const appUrl = command.inThreads ? bb.server.experimental_appUrl : null;
  const open = appUrl ? `Open ${appUrl.replace(/\/+$/, "")}/plugins/${bb.pluginId}/review/${key}` : "Open the Code Review Workspace panel";
  const where = `${homeShort(folder.env.path)} on ${folder.machine}`;
  const thread = to.title ? `${JSON.stringify(to.title)} (${to.threadId})` : to.threadId;

  const lines = [
    created ? `Started a review of ${where}: ${which}. ${open} to watch it build and review.`
      : `Opened the review of ${where}: ${which}, as it was; nothing was rebuilt. ${open} to review it.`,
    replaced ? `Its main thread is now ${thread}, in place of ${replaced.title ? JSON.stringify(replaced.title) : replaced.threadId}, which is archived or deleted. Comments sent from the review go there.`
      : !main ? `Its main thread is ${thread}, as before: BB couldn’t say which thread leads the work here now. Comments sent from the review go there.`
      : `Its main thread is ${thread}, the top thread working in this folder. Comments sent from the review go there.`,
  ];
  // A subagent in a worktree of its own shares its parent's thread, whose folder this reviews.
  const cwd = ctx.cwd?.replace(/\/+$/, "");
  if (cwd && cwd !== folder.env.path && !cwd.startsWith(`${folder.env.path.replace(/\/+$/, "")}/`)) {
    lines.push(`You ran this in ${cwd}, outside this thread’s folder, so changes made only there aren’t in the review.`);
  }
  if (command.context !== undefined) lines.push(!command.context.trim() ? "Removed the review’s context."
    : created ? "The assistant’s automatic review will include this context." : "Kept the context with the review. Its automatic review has run already, so paste it into Ask agent to have the agent act on it.");
  if (changed) deps.changed(key);
  return { exitCode: 0, stdout: lines.join("\n") };
}

/** What a feature review's page says about its folder. */
export interface FeatureCheck {
  /**
   * current: as the review shows it. changed: `changedFiles` differ. ahead: a PR's review whose folder has `aheadFiles`
   * not on GitHub yet, `aheadPaths`. paused: on `branch`. offline, gone, unavailable: `message`.
   */
  state: "current" | "changed" | "ahead" | "paused" | "offline" | "gone" | "unavailable";
  changedFiles?: number;
  aheadFiles?: number;
  aheadPaths?: string[];
  branch?: string | null;
  message?: string;
  /** Other threads working in the folder: not the main thread, nor its subagents. */
  alsoActive: Array<{ threadId: string; title: string }>;
  /** Files the review keeps out, and committed files that look like secrets you haven't said Got it to. */
  hidden: HiddenFile[];
  flagged: string[];
  /** Paused: the review the folder's branch has already, if any. */
  branchReview?: string;
}

/** How many files differ between two reads' revisions. Without revisions kept, every file counts: it can't be told. */
function changedCount(kept: Record<string, string> | null, now: Record<string, string>): number {
  if (!kept) return Math.max(1, Object.keys(now).length);
  const paths = new Set([...Object.keys(kept), ...Object.keys(now)]);
  return [...paths].filter((path) => kept[path] !== now[path]).length;
}

/** The other threads in the review's folder, by title: not its main thread, its subagents, or this plugin's threads. */
async function alsoActive(bb: BbPluginApi, review: ReviewMeta & { feature: FeatureReview }): Promise<FeatureCheck["alsoActive"]> {
  const main = review.mainThread?.threadId;
  const [listed, below] = await Promise.all([
    bb.sdk.threads.list({ environmentId: review.feature.environmentId }).catch(() => []),
    main ? bb.sdk.threads.experimental_listDescendants?.({ threadIds: [main] }).catch(() => null) : null,
  ]);
  const under = new Set(below?.threads.find((thread) => thread.threadId === main)?.descendantIds ?? []);
  return listed.filter((thread) => thread.id !== main && !under.has(thread.id) && thread.parentThreadId !== main && !thread.archivedAt && !thread.deletedAt
    && thread.visibility !== "hidden" && thread.originPluginId !== bb.pluginId)
    .map((thread) => ({ threadId: thread.id, title: threadTitle(thread) ?? "Untitled thread" }));
}

/**
 * Mark the review's folder gone, in the caller's block. One that became a PR goes on: its next Send starts a fresh
 * thread. A local one goes to Archive, as the sync archives a PR, when no comment is open or sent; otherwise it stays
 * for them. Returns whether anything changed.
 */
async function markFolderGone(tx: AsyncStore, review: ReviewMeta & { feature: FeatureReview }): Promise<boolean> {
  if (review.feature.folderGone) return false;
  const state: ReviewLifecycle = { feature: { ...review.feature, folderGone: true } };
  if (review.kind === "ref" && !review.archivedAt) {
    const { comments } = await tx.getDraft(review.targetKey);
    if (!comments.some((comment) => comment.state === undefined || comment.state === "open" || comment.state === "sent")) state.archivedAt = Date.now();
  }
  await tx.setLifecycle(review.targetKey, state);
  return true;
}

const featureOf = (review: ReviewMeta | null): (ReviewMeta & { feature: FeatureReview }) | null => review?.feature ? review as ReviewMeta & { feature: FeatureReview } : null;

/**
 * The PR a folder's read found, when it's in this review's repo, and open or a draft: a branch used again after its PR
 * merged is new work, not that PR's. PR Status finds it by the branch's upstream, so its head may have another name,
 * as when it was pushed as HEAD:feat/nice.
 */
function prOfBranch(feature: FeatureReview, pr: FolderPr | undefined): { repo: string; number: number } | null {
  const link = pr?.url ? parsePrLink(pr.url) : null;
  if (!link || !pr?.number || !feature.repo || link.repo.toLowerCase() !== feature.repo.toLowerCase()) return null;
  if (pr.state !== undefined && !/^(open|draft)$/i.test(pr.state)) return null;
  return { repo: link.repo, number: pr.number };
}

/**
 * The review of a folder becomes its branch's PR's, `pr`: the same review, now of the PR, its diff the PR's at its head,
 * the comments moved with their lines, and no guide writer. Its folder stays, for what isn't pushed yet; the PR is
 * yours, and the sync reads it at once. A PR opened before the review, whose head the folder doesn't have, waits for
 * your click (`clicked` "pr"), as one GitHub didn't answer for waits for the next check (`prPending`). When the PR has
 * a review of its own already, the two merge (src/merge.ts): this one stays, unless the PR's began as another folder's,
 * and the one that goes is merged in at once when it has nothing of yours, else on your click (`clicked` "merge"), which
 * this review offers (`prOffer`). Returns which, or "skipped" when it can't now.
 */
export async function becomePr(deps: Deps, key: string, pr: { repo: string; number: number }, clicked?: "pr" | "merge"): Promise<"converted" | "merged" | "offered" | "skipped"> {
  const { bb, store, gh } = deps;
  const prKey = await prReviewKey(store, pr);
  // A guide being written goes on: it's checked against the diff as it is when it's done, the PR's.
  const now = featureOf(await store.getReview(key));
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  if (!now || now.mergedInto) return "skipped";
  const other = prKey !== key ? await store.getReview(prKey) : null;
  /**
   * In the caller's block, the merge offered when the review that would go has something of yours, once, as it stands;
   * a 1.8.0 link to the PR's review is offered so too. Null when it has nothing of yours.
   */
  const offerIn = async (tx: AsyncStore, intoPr: boolean) => {
    const [review, theirs] = [featureOf(await tx.getReview(key)), await tx.getReview(prKey)];
    // Keep both: neither offers again, nor merges on its own.
    if (review?.mergeDeclined === prKey) return "kept" as const;
    if (!review || !theirs || !await hasUserContent(tx, intoPr ? review : theirs)) return null;
    const offer = { key: prKey, number: pr.number, url, moves: await movesOf(tx, theirs), ...intoPr ? { intoPr: true as const } : {} };
    if (JSON.stringify(review.prOffer) === JSON.stringify(offer) && !review.feature.prReview) return "kept" as const;
    await tx.setLifecycle(key, { prOffer: offer, feature: { ...review.feature, prReview: undefined } });
    return "saved" as const;
  };
  /** Kept as found and not become, once per PR and why, so a check that finds it again changes nothing. */
  const pending = async (state: NonNullable<ReviewLifecycle["prPending"]>) => {
    const saved = await store.exclusive(async (tx) => {
      const review = featureOf(await tx.getReview(key));
      if (!review || review.kind !== "ref" || review.prPending?.url === state.url && review.prPending.why === state.why) return false;
      await tx.setLifecycle(key, { prPending: state });
      return true;
    });
    if (saved) deps.changed(key);
    return "skipped" as const;
  };
  // PR Status names a folder's PR by its branch's upstream, which a branch made from another's, as a stacked one is,
  // shares until its first push: a PR from a branch that isn't this review's by name waits for your click, merged with
  // nothing before it.
  const notOwn = (head: string | undefined) => !clicked && now.kind === "ref" && !!head && head !== now.feature.branch && head !== now.feature.pushedAs;
  if (now.prPending?.why === "branch" && now.prPending.url.toLowerCase() === url.toLowerCase() && notOwn(now.prPending.head)) return "skipped";
  if (notOwn(other?.head)) return pending({ number: pr.number, url, why: "branch", head: other!.head!, at: Date.now() });
  if (other) {
    // Two folders on one branch: the PR's review that began as the other folder's stays, and this one goes into it.
    const intoPr = !!other.feature;
    const offered = clicked !== "merge" && await store.exclusive((tx) => offerIn(tx, intoPr));
    if (offered === "saved") deps.changed(key);
    if (offered) return "offered";
    if (intoPr || now.kind === "pr") return await mergeReviews(deps, intoPr ? key : prKey, intoPr ? prKey : key) ? "merged" : "skipped";
  }
  if (now.kind !== "ref" || !clicked && now.prPending?.why === "older" && now.prPending.url.toLowerCase() === url.toLowerCase()) return "skipped";
  // One GitHub didn't answer for is read again a minute later, and not while GitHub limits reads or gh is signed out.
  if (!clicked && now.prPending?.why === "error" && now.prPending.url.toLowerCase() === url.toLowerCase()
    && (Date.now() - now.prPending.at < ERROR_RETRY || !!deps.sync && githubWaits(deps.sync.health(), Date.now()))) return "skipped";
  let snapshot: PrSnapshot;
  try {
    snapshot = await readPrSnapshot(gh.runGh, pr.number, pr.repo);
  } catch (error) {
    return pending({ number: pr.number, url, why: "error", error: error instanceof Error ? error.message : String(error), at: Date.now() });
  }
  if (snapshot.pr.state !== undefined && snapshot.pr.state !== "OPEN") return "skipped";
  if (notOwn(snapshot.pr.headRefName)) return pending({ number: pr.number, url: snapshot.pr.url, why: "branch", head: snapshot.pr.headRefName, at: Date.now() });
  // A branch used again may have an open PR from before the review: it's this work's only when the folder has its head.
  const opened = Date.parse(snapshot.pr.createdAt ?? "");
  if (!clicked && opened < now.createdAt && !await folderHas(bb, now.feature.environmentId, snapshot.pr.headRefOid)) {
    return pending({ number: pr.number, url: snapshot.pr.url, why: "older", at: Date.now() });
  }
  if (other?.status === "generating") await stopGuide(bb, store, prKey);
  // What the folder has that the PR's head doesn't, where a comment the PR's diff loses can stay, not on GitHub yet.
  const ahead = await readFeatureDiff(bb, { environmentId: now.feature.environmentId, machine: now.feature.machine, repo: null, baseRef: snapshot.pr.headRefOid, workBranch: folderBranchOf(now.feature) }).catch(() => null);
  const done = await store.exclusive(async (tx) => {
    const review = featureOf(await tx.getReview(key));
    if (!review || review.kind !== "ref") return "skipped" as const;
    // A review of the PR started meanwhile: looked at again.
    if (await prReviewKey(tx, pr) !== prKey) return "again" as const;
    // Something of yours put in the PR's review while GitHub and the folder were read: offered, not merged on its own.
    const offered = other && clicked !== "merge" ? await offerIn(tx, false) : null;
    if (offered) return offered;
    // In one transaction: a merge that fails leaves the review as it was, to become the PR's when it's found again.
    return tx.transaction((db) => convertIn(db, review, pr, snapshot, ahead?.outcome === "available" ? ahead : null, other ? prKey : null));
  });
  if (done === "again") return becomePr(deps, key, pr, clicked);
  if (done === "saved") deps.changed(key);
  if (done === "saved" || done === "kept") return "offered";
  if (done === "converted" || done === "merged") {
    await deps.sync?.one(key, true).catch(() => {});
    await retitleAssistant(bb, store, key).catch(() => {});
    deps.changed(key);
    if (done === "merged") deps.changed(prKey);
  }
  return done;
}

type PrSnapshot = Awaited<ReturnType<typeof readPrSnapshot>>;

/** A Push without Push and open PR's intent, or why it couldn't ask the review agent. */
const withoutOpenPr = ({ thenOpenPr: _intent, openPrError: _why, ...run }: PushRun): PushRun => run;

/** Whether two diffs change the same files the same way, by each file's rebase-proof hash (src/diff-hash.ts). */
function sameChanges(a: string, b: string): boolean {
  const hashes = (patch: string) => new Map(splitPatchByFile(patch).map((file) => [file.path, normalizedFileHash(file.text)]));
  const [before, after] = [hashes(a), hashes(b)];
  return before.size === after.size && [...before].every(([path, hash]) => after.get(path) === hash);
}

/**
 * In the caller's transaction, the review of a folder becomes `pr`'s, as `snapshot` read it: its diff the PR's at its
 * head, the comments moved with their lines, one the PR's diff loses kept on what the folder has that the PR's head
 * doesn't (`ahead`), not on GitHub yet; and, with `mergeFrom`, the PR's own review merged in (src/merge.ts mergeIn).
 */
async function convertIn(db: Store, review: ReviewMeta & { feature: FeatureReview }, pr: { repo: string; number: number }, snapshot: PrSnapshot, ahead: Extract<FeatureDiff, { outcome: "available" }> | null, mergeFrom: string | null): Promise<"converted" | "merged"> {
  const key = review.targetKey;
  const { pr: read } = snapshot;
  // Named as it was, for the notice that says what it became.
  const from = localIdOf(review);
  const previous = await db.patch(key);
  // The files the review showed, as it read them: what Push checks a commit against, never the folder as it is now.
  const shown = await db.getSnapshotFiles(key, diffFilesHead(await db.patchHash(key)));
  const next = ensureGitHeaders(snapshot.patch);
  await db.savePatch(key, next);
  // Your name for it stays; the main thread's title gives way to the PR's.
  await db.saveReview({
    targetKey: key, kind: "pr", number: pr.number, repo: pr.repo, url: read.url, title: read.title, author: read.author?.login,
    base: read.baseRefName, head: read.headRefName, gitRef: `${read.baseRefName}...${read.headRefName}`, headSha: read.headRefOid,
    status: review.status, createdAt: review.createdAt, ...review.projectId ? { projectId: review.projectId } : {},
  });
  await db.saveSnapshot(key, read.headRefOid, next);
  const { comments } = await db.getDraft(key);
  const placed = await reanchorDraft(db, key, previous, next);
  const lost = comments.filter((comment) => !placed.some(({ at }) => sameLocation(at, comment)) && comment.side === "RIGHT" && !comment.startSide);
  // Seen in Not pushed yet: what the folder has that the PR doesn't, at the revisions the review showed, so a file
  // changed since, or never shown, differs. Without them, nothing is: Push asks you to open Not pushed yet first.
  const seen = ahead && shown ? {
    revisions: Object.fromEntries(Object.keys(ahead.revisions).flatMap((path) => path in shown.revisions ? [[path, shown.revisions[path]!]] : [])),
    hidden: shown.hidden.filter((file) => file.path in ahead.revisions),
  } : null;
  if (ahead) await db.saveSnapshot(key, NOT_PUSHED, ahead.patch);
  if (seen) await db.saveSnapshotFiles(key, NOT_PUSHED, seen);
  const local = ahead ? await placeOn(db, key, lost, previous, ahead.patch, "LOCAL") : [];
  // Those on neither keep their lines, on the PR's review's older diff: an open one waits in Needs you.
  const outside = comments.filter((comment) => ![...placed, ...local].some(({ at }) => sameLocation(at, comment)));
  await db.rebaseDraftComments(key, [...placed, ...local]);
  await db.setLifecycle(key, {
    // Pushed under another name: its branch on GitHub. A 1.8.0 link to the PR's review is gone with the merge. A guide
    // written for local changes the PR's diff isn't says so, with Rewrite guide; never rewritten on its own.
    feature: {
      ...review.feature, prReview: undefined, ...read.headRefName !== review.feature.branch ? { remoteBranch: read.headRefName } : {},
      ...sameChanges(previous, next) ? {} : { guideOlderThanDiff: "pr" as const },
    },
    // Yours, until the sync reads it, so Push carries on (lib/push.ts pushTarget).
    ownPr: true, prPending: null, prOffer: null,
    // The PR is open: Push and open PR's intent goes, asked or failed, with Open PR (src/push.ts openPrAfter).
    ...review.push?.thenOpenPr ? { push: withoutOpenPr(review.push) } : {},
    // What the review showed of what the folder has that the PR doesn't: a Push waiting on its commit checks it there.
    ...seen ? { notPushedSeen: { environmentId: review.feature.environmentId, base: read.headRefOid, at: Date.now() } } : {},
    became: { at: Date.now(), number: pr.number, url: read.url, from, carried: comments.length, local: local.length, outside: comments.length - placed.length - local.length,
      needsYou: outside.filter((comment) => !comment.state || comment.state === "open").length },
    // Its agent, mid-conversation, is told once; never by a turn of its own (src/agent.ts takePrNote).
    ...await db.getAssistantThread(key) ? { agentPrNote: { number: pr.number, url: read.url, from } } : {},
    // What gh said of the PR, until the sync reads it (src/start-review.ts recordPrState).
    ...read.state === "OPEN" || read.state === "CLOSED" || read.state === "MERGED" ? { startedPrState: read.state } : {},
  });
  await pruneDiffs(db, (await db.getReview(key))!);
  if (!mergeFrom) return "converted";
  return await mergeIn(db, mergeFrom, key) ? "merged" : "converted";
}

/**
 * Read a feature review's folder and say how it stands: changed since the review read it, on another branch (which
 * pauses it, until it's back), offline, or gone (which ends it, as removal does). A branch whose PR is found makes the
 * review that PR's. Only what changes in the review is saved; the page asks again on its realtime signals.
 */
export async function checkFeature(deps: Deps, key: string): Promise<FeatureCheck> {
  const { bb, store } = deps;
  const review = featureOf(await store.getReview(key));
  const empty: FeatureCheck = { state: "current", alsoActive: [], hidden: [], flagged: [] };
  if (!review) return empty;
  const { feature } = review;
  // Once it's a PR's review, the PR says what changed, and its folder what isn't pushed yet.
  if (review.kind !== "ref") return review.kind === "pr" && !feature.folderGone ? checkPrFolder(deps, review, empty) : empty;
  // A 1.8.0 link to its PR's own review: merged with it now, or offered, unless you kept both.
  const linked = feature.prReview && feature.prReview !== review.mergeDeclined ? await store.getReview(feature.prReview) : null;
  if (linked?.repo && linked.number && await becomePr(deps, key, { repo: linked.repo, number: linked.number }) !== "skipped") return checkFeature(deps, key);
  const kept = await store.exclusive(async (tx) => {
    const hash = await tx.patchHash(key);
    return { hash, files: await tx.getSnapshotFiles(key, diffFilesHead(hash)), knobs: (await tx.getPreferences()).preferences.knobs };
  });
  const included = new Set(review.includeHidden ?? []);
  const hidden = kept.files?.hidden ?? [];
  const seen = new Set(review.flaggedSeen ?? []);
  const flagged = Object.keys(kept.files?.revisions ?? {}).filter((path) => isSecretPath(path) && !included.has(path) && !seen.has(path) && !hidden.some((file) => file.path === path));
  const base: FeatureCheck = { ...empty, hidden, flagged };
  if (feature.folderGone) return { ...base, state: "gone", message: "BB removed this folder." };

  const [read, others, head] = await Promise.all([readFeatureRevisions(bb, feature), alsoActive(bb, review), folderHead(bb, feature.environmentId)]);
  const withOthers: FeatureCheck = { ...base, alsoActive: others };
  // A folder on no branch is on its detached HEAD.
  const pausedOn = read.outcome === "paused" ? read.branch ?? "HEAD" : read.outcome === "available" ? null : undefined;
  if (read.outcome === "gone") {
    if (await store.exclusive(async (tx) => { const now = featureOf(await tx.getReview(key)); return !!now && await markFolderGone(tx, now); })) deps.changed(key);
    return { ...base, state: "gone", message: read.message };
  }
  // The branch the folder is on, or back on its own, as the list shows it; and on its own, its head.
  const onHead = pausedOn === null && head && head !== feature.headSha ? { headSha: head } : {};
  if (pausedOn !== undefined && (feature.pausedOn ?? null) !== pausedOn || "headSha" in onHead) {
    const saved = await store.exclusive(async (tx) => {
      const now = featureOf(await tx.getReview(key));
      if (!now || now.kind !== "ref") return false;
      await tx.setLifecycle(key, { feature: { ...now.feature, pausedOn: pausedOn ?? null, ...onHead } });
      return true;
    });
    if (saved) deps.changed(key);
  }
  if (read.outcome === "paused") {
    const other = read.branch ? reviewOfFolder(await store.listReviews(), feature.environmentId, read.branch)?.targetKey : undefined;
    // Its branch renamed: the branch it was on is gone, and the one it's on has its last commit, which its base hasn't (a
    // branch merged into the base and deleted isn't renamed), or which was its merge base, a branch with no commits of
    // its own, which can't have been merged, while the folder is still at it: a head read before commits made since may
    // be out of date. It follows, and says so.
    if (read.branch && !other && !feature.workBranch && feature.headSha && await folderHasBranch(bb, feature.environmentId, feature.branch) === false
      && await folderHas(bb, feature.environmentId, feature.headSha)
      && (feature.headSha === feature.mergeBaseRef && head === feature.headSha || await folderHasSince(bb, feature.environmentId, feature.baseRef, feature.headSha))
      && await followBranch(deps, key, read.branch, true)) return checkFeature(deps, key);
    return { ...withOthers, state: "paused", branch: read.branch, ...other ? { branchReview: other } : {} };
  }
  if (read.outcome !== "available") return { ...withOthers, state: read.outcome, message: read.message };
  // Its branch has a PR: the review becomes that PR's, merged with the review it has or offering to.
  const pr = prOfBranch(feature, read.pr);
  const became = pr ? await becomePr(deps, key, pr) : "skipped";
  if (became === "converted" || became === "merged") return empty;
  const changed = kept.knobs.localDiffChanges ? changedCount(kept.files?.revisions ?? null, read.revisions) : 0;
  // Kept for the lists' "3 files changed", as of this check.
  if ((feature.changedFiles ?? 0) !== changed) {
    const saved = await store.exclusive(async (tx) => {
      const now = featureOf(await tx.getReview(key));
      if (!now || now.kind !== "ref" || await tx.patchHash(key) !== kept.hash) return false;
      await tx.setLifecycle(key, { feature: { ...now.feature, changedFiles: changed || null } });
      return true;
    });
    if (saved) deps.changed(key);
  }
  return changed ? { ...withOthers, state: "changed", changedFiles: changed } : withOthers;
}

/**
 * A PR's review's folder, read against the PR's head as GitHub last said, with no GitHub call: gone, paused and offline
 * as a local review's, and how many files in it aren't on GitHub yet.
 */
async function checkPrFolder(deps: Deps, review: ReviewMeta & { feature: FeatureReview }, empty: FeatureCheck): Promise<FeatureCheck> {
  const { feature } = review;
  const sha = prHead(review);
  if (!sha) return empty;
  const read = await readFeatureRevisions(deps.bb, { environmentId: feature.environmentId, machine: feature.machine, repo: null, baseRef: sha, workBranch: folderBranchOf(feature) });
  if (read.outcome === "gone") {
    if (await deps.store.exclusive(async (tx) => { const now = featureOf(await tx.getReview(review.targetKey)); return !!now && await markFolderGone(tx, now); })) deps.changed(review.targetKey);
    return { ...empty, state: "gone", message: read.message };
  }
  if (read.outcome === "paused") return { ...empty, state: "paused", branch: read.branch };
  if (read.outcome !== "available") return { ...empty, state: read.outcome, message: read.message };
  const ahead = Object.keys(read.revisions);
  return ahead.length ? { ...empty, state: "ahead", aheadFiles: ahead.length, aheadPaths: ahead } : empty;
}

/**
 * The review follows its folder onto `branch`, under its key, as its branch: renamed, which it says (`said`), or your
 * Follow. Not a fresh thread's worktree's, nor onto a branch with a review of its own. Returns whether it did.
 */
async function followBranch(deps: Deps, key: string, branch: string, said: boolean): Promise<boolean> {
  const followed = await deps.store.exclusive(async (tx) => {
    const review = featureOf(await tx.getReview(key));
    if (!review || review.kind !== "ref" || review.feature.workBranch || reviewOfFolder(await tx.listReviews(), review.feature.environmentId, branch)) return false;
    await tx.saveReview({ ...review, gitRef: branch });
    await tx.setLifecycle(key, {
      feature: { ...review.feature, branch, pausedOn: null, pushedAs: undefined }, formerBranches: [...review.formerBranches ?? [], review.feature.branch],
      ...said ? { followed: { from: review.feature.branch, branch, at: Date.now() } } : {},
    });
    return true;
  });
  if (followed) deps.changed(key);
  return followed;
}

/**
 * Update: read a feature review's folder again and show it, the comments following their lines, without the guide
 * writer; a PR's review with its folder, the PR at its head (updatePr). Not while its guide is being written, and not
 * from another branch: the review waits for its own. A diff that moves is newer than the guide: `why` says what moved
 * it, your Update or Include and Keep out, or on a PR's review, your Push landing.
 */
export async function updateFeature(deps: Deps, key: string, why: "update" | "include" | "push" = "update"): Promise<{ ok: boolean; error?: string }> {
  const { bb, store } = deps;
  const review = featureOf(await store.getReview(key));
  if (review?.kind === "pr" && !review.feature.folderGone) return updatePr(deps, review, why === "push" ? why : "update");
  if (!review || review.kind !== "ref") return { ok: false, error: "Only a local review of a folder updates this way. Use Update guide." };
  if (review.status === "generating") return { ok: false, error: "The guide writer is writing this review’s guide. Update once it’s done." };
  if (review.feature.folderGone) return { ok: false, error: "BB removed this folder, so there’s nothing to update from." };
  const read = await readFeatureDiff(bb, review.feature, review.includeHidden ?? []);
  if (read.outcome === "gone") {
    if (await store.exclusive(async (tx) => { const now = featureOf(await tx.getReview(key)); return !!now && await markFolderGone(tx, now); })) deps.changed(key);
    return { ok: false, error: read.message };
  }
  if (read.outcome === "paused") return { ok: false, error: `The folder is on ${read.branch ?? "no branch"} now, so this review waits until it’s back on ${review.feature.branch}.` };
  if (read.outcome !== "available") return { ok: false, error: read.message };
  if (!read.patch.trim()) return { ok: false, error: `${nothingToReview(read)} The review keeps what it showed.` };
  const saved = await store.exclusive(async (tx) => {
    const now = featureOf(await tx.getReview(key));
    if (!now || now.kind !== "ref") return { ok: false, error: "This review changed meanwhile. Reload it." };
    if (now.status === "generating") return { ok: false, error: "The guide writer is writing this review’s guide. Update once it’s done." };
    // A diff the guide wasn't written for: the review says so, with Rewrite guide.
    const moved = await tx.patch(key) !== read.patch;
    await saveRead(tx, key, moved ? { ...now.feature, guideOlderThanDiff: why } : now.feature, read);
    return { ok: true };
  });
  if (saved.ok) deps.changed(key);
  return saved;
}

/**
 * Update a PR's review with its folder to the PR's head now, without the guide writer: its diff, the comments moved
 * with their lines, and a LOCAL comment whose line is on GitHub now a comment there, with its id, state, Send and
 * report; one whose line another comment has stays LOCAL. A diff that moves is newer than the guide, as `why` says.
 */
async function updatePr(deps: Deps, review: ReviewMeta & { feature: FeatureReview }, why: "update" | "push"): Promise<{ ok: boolean; error?: string }> {
  const key = review.targetKey;
  const writing = "The guide writer is writing this review’s guide. Update once it’s done.";
  if (!review.number || !review.repo) return { ok: false, error: "This review’s PR isn’t known. Reload it." };
  if (review.status === "generating") return { ok: false, error: writing };
  let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
  try {
    snapshot = await readPrSnapshot(deps.gh.runGh, review.number, review.repo);
  } catch (error) {
    return { ok: false, error: `Couldn’t read the PR: ${error instanceof Error ? error.message : String(error)}` };
  }
  const saved = await deps.store.exclusive(async (tx) => {
    const now = featureOf(await tx.getReview(key));
    if (!now || now.kind !== "pr") return { ok: false, error: "This review changed meanwhile. Reload it." };
    if (now.status === "generating") return { ok: false, error: writing };
    const { pr } = snapshot;
    const previous = await tx.patch(key);
    const next = ensureGitHeaders(snapshot.patch);
    const shown = await tx.getSnapshot(key, NOT_PUSHED);
    const placed = [
      ...await reanchorDraft(tx, key, previous, next),
      ...shown ? await placeOn(tx, key, (await tx.getDraft(key)).comments.filter(isLocal), shown, next, "RIGHT") : [],
    ];
    await tx.savePatch(key, next);
    await tx.saveReview({ ...now, title: pr.title, base: pr.baseRefName, head: pr.headRefName, gitRef: `${pr.baseRefName}...${pr.headRefName}`, headSha: pr.headRefOid });
    await tx.saveSnapshot(key, pr.headRefOid, next);
    await tx.rebaseDraftComments(key, placed);
    // A diff the guide wasn't written for: the review says so, with Rewrite guide.
    if (previous !== next) await tx.setLifecycle(key, { feature: { ...now.feature, guideOlderThanDiff: why } });
    await pruneDiffs(tx, (await tx.getReview(key))!);
    return { ok: true };
  });
  if (saved.ok) deps.changed(key);
  return saved;
}

/**
 * A feature review's diff read again for its guide (src/rereview.ts): the patch, and, in the block that rebuilds it,
 * what to keep with it. Null for a review that isn't of a folder.
 */
export async function readForGuide(bb: BbPluginApi, review: ReviewMeta): Promise<{ patch: string; save: (tx: AsyncStore) => Promise<void> } | { error: string } | null> {
  const feature = featureOf(review)?.feature;
  if (!feature || review.kind !== "ref") return null;
  if (feature.folderGone) return { error: "BB removed this folder, so its guide can’t be written again." };
  const read = await readFeatureDiff(bb, feature, review.includeHidden ?? []);
  if (read.outcome === "paused") return { error: `The folder is on ${read.branch ?? "no branch"} now, so this review waits until it’s back on ${feature.branch}.` };
  if (read.outcome !== "available") return { error: read.message };
  return {
    patch: read.patch,
    save: async (tx) => {
      const now = featureOf(await tx.getReview(review.targetKey));
      if (!now) return;
      await tx.setLifecycle(review.targetKey, { feature: { ...now.feature, baseRef: read.base, mergeBaseRef: read.mergeBaseRef, pausedOn: null, changedFiles: null } });
      await tx.saveSnapshotFiles(review.targetKey, diffFilesHead(await tx.patchHash(review.targetKey)), { revisions: read.revisions, hidden: read.hidden });
    },
  };
}

/** The folder's review offering to merge with its PR's own review, from either's page: `targetKey`, or the one offering to merge with it. */
function offeringFolder(reviews: ReviewMeta[], targetKey: string): (ReviewMeta & { feature: FeatureReview }) | null {
  const offering = (review: ReviewMeta) => review.kind === "ref" && !review.archivedAt && !!(review.prOffer || review.feature?.prReview);
  return featureOf(reviews.find((review) => review.targetKey === targetKey && offering(review))
    ?? reviews.find((review) => offering(review) && (review.prOffer?.key ?? review.feature?.prReview) === targetKey) ?? null);
}

export function register(deps: ServeDeps) {
  const { bb, store } = deps;

  const handlers = {
    async checkFeature({ targetKey }) {
      return checkFeature(deps, targetKey);
    },
    async includeHidden({ targetKey, files, included }) {
      const review = featureOf(await store.getReview(targetKey));
      if (!review) return { ok: false, error: "Only a local review of a folder keeps files out." };
      await store.exclusive(async (tx) => {
        const now = (await tx.getReview(targetKey))?.includeHidden ?? [];
        await tx.setLifecycle(targetKey, { includeHidden: included ? [...new Set([...now, ...files])] : now.filter((path) => !files.includes(path)) });
      });
      deps.changed(targetKey);
      // Shown, or kept out again, once the folder is read: now, unless it can't be.
      if (review.kind !== "ref" || review.status === "generating") return { ok: true };
      const updated = await updateFeature(deps, targetKey, "include");
      return updated.ok ? updated : { ok: false, error: `${included ? "Included" : "Kept out"}; it shows once the review updates. ${updated.error ?? ""}`.trim() };
    },
    async dismissFlagged({ targetKey, files }) {
      const found = await store.exclusive(async (tx) => {
        const review = featureOf(await tx.getReview(targetKey));
        if (!review) return false;
        await tx.setLifecycle(targetKey, { flaggedSeen: [...new Set([...review.flaggedSeen ?? [], ...files])] });
        return true;
      });
      if (!found) return { ok: false, error: "Only a local review of a folder flags files." };
      deps.changed(targetKey);
      return { ok: true };
    },
    // Review changes, above a thread's message box: what bb review with no arguments does there, with no output.
    async reviewThreadChanges({ threadId }) {
      // A review's agents and guide writers, hidden, may work in the folder's checkout: never a review's main thread,
      // from their page or their shell (callerFolder).
      const found = await callerFolder(deps, threadId);
      if ("stderr" in found) return { ok: false, error: found.stderr };
      // Its page is a thread you see.
      if (found.caller.visibility === "hidden") return { ok: false, error: "This thread is one of Code Review Workspace’s agents, so it can’t start a review of its folder. Run it in a thread working on the change." };
      let started: Awaited<ReturnType<typeof openFolderReview>>;
      try {
        started = await openFolderReview(deps, found.folder, found.main);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if ("error" in started) return { ok: false, error: started.error };
      void started.run?.();
      if (started.opened.changed) deps.changed(started.opened.key);
      return { ok: true, targetKey: started.opened.key };
    },
    async followFolderBranch({ targetKey }) {
      const review = featureOf(await store.getReview(targetKey));
      if (!review) return { ok: false, error: "This review isn’t of a folder." };
      const folder = await folderOf(bb, review.feature.environmentId);
      if ("error" in folder) return { ok: false, error: folder.error };
      if (folder.env.branchName === review.feature.branch) return { ok: true };
      return await followBranch(deps, targetKey, folder.env.branchName, false) ? { ok: true }
        : { ok: false, error: `This review can’t follow ${folder.env.branchName}: that branch has a review of its own, or this review changed. Reload it.` };
    },
    async dismissFollowed({ targetKey }) {
      if (!await store.getReview(targetKey)) return { ok: false };
      await store.setLifecycle(targetKey, { followed: null });
      deps.changed(targetKey);
      return { ok: true };
    },
    async dismissBecame({ targetKey }) {
      if (!await store.getReview(targetKey)) return { ok: false };
      await store.setLifecycle(targetKey, { became: null });
      deps.changed(targetKey);
      return { ok: true };
    },
    async mergeReviews({ targetKey }) {
      const folder = offeringFolder(await store.listReviews(), targetKey);
      const other = folder && await store.getReview(folder.prOffer?.key ?? folder.feature.prReview!);
      if (!folder || !other?.repo || !other.number) return { ok: false, error: "This review has no other review of its PR to merge with. Reload it." };
      const pr = { repo: other.repo, number: other.number };
      try {
        if (await becomePr(deps, folder.targetKey, pr, "merge") !== "merged") {
          return { ok: false, error: (await store.getReview(folder.targetKey))?.prPending?.error ?? "Couldn’t merge the two reviews. Try again." };
        }
      } catch (error) {
        return { ok: false, error: `Couldn’t merge the two reviews: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, targetKey: await prReviewKey(store, pr) };
    },
    async keepBothReviews({ targetKey }) {
      const kept = await store.exclusive(async (tx) => {
        const folder = offeringFolder(await tx.listReviews(), targetKey);
        if (!folder) return null;
        const other = folder.prOffer?.key ?? folder.feature.prReview!;
        await tx.setLifecycle(folder.targetKey, { mergeDeclined: other });
        return [folder.targetKey, other];
      });
      if (!kept) return { ok: false, error: "This review has no other review of its PR to keep apart from. Reload it." };
      for (const key of kept) deps.changed(key);
      return { ok: true };
    },
    async takePendingPr({ targetKey }) {
      const pending = (await store.getReview(targetKey))?.prPending;
      const link = pending ? parsePrLink(pending.url) : null;
      if (!pending || !link) return { ok: false, error: "This review isn’t waiting on a PR. Reload it." };
      // Opened before it, or from another branch: your click says it's this review's. GitHub didn't answer: asked again.
      const became = await becomePr(deps, targetKey, { repo: link.repo, number: link.number }, pending.why === "error" ? undefined : "pr").catch(() => "skipped" as const);
      if (became === "converted" || became === "merged" || became === "offered") return { ok: true };
      return { ok: false, error: (await store.getReview(targetKey))?.prPending?.error ?? `Couldn’t make it PR #${link.number}’s review. Try again.` };
    },
    async dismissPendingPr({ targetKey }) {
      const declined = await store.exclusive(async (tx) => {
        const pending = (await tx.getReview(targetKey))?.prPending;
        if (!pending) return false;
        await tx.setLifecycle(targetKey, { prPending: { ...pending, declined: true } });
        return true;
      });
      if (declined) deps.changed(targetKey);
      return { ok: declined };
    },
    async reviewFolderBranch({ targetKey }) {
      const review = featureOf(await store.getReview(targetKey));
      if (!review) return { ok: false, error: "This review isn’t of a folder." };
      const folder = await folderOf(bb, review.feature.environmentId);
      if ("error" in folder) return { ok: false, error: folder.error };
      let main: Thread | null;
      try {
        main = review.mainThread ? await threadOf(bb, review.mainThread.threadId) : null;
      } catch {
        return { ok: false, error: "Couldn’t read this review’s main thread from BB. Try again in a moment." };
      }
      if (!main || !main.environmentId || !live(main)) return { ok: false, error: "This review’s main thread is archived or gone. Run bb review in a thread working in the folder." };
      const started = await openFolderReview(deps, folder, main);
      if ("error" in started) return { ok: false, error: started.error };
      void started.run?.();
      deps.changed(started.opened.key);
      return { ok: true, targetKey: started.opened.key };
    },
  } satisfies Partial<RpcHandlers>;

  const events: EventListeners = {
    // bb removed a folder: its reviews end, as markFolderGone says.
    "experimental_environment.removed": [async ({ removal }) => {
      const gone = await store.exclusive(async (tx) => {
        const keys: string[] = [];
        for (const review of (await tx.listReviews()).map(featureOf)) {
          if (review?.feature.environmentId === removal.environmentId && await markFolderGone(tx, review)) keys.push(review.targetKey);
        }
        return keys;
      });
      for (const key of gone) deps.changed(key);
    }],
  };
  return { handlers, events };
}
