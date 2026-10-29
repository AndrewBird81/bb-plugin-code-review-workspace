// A feature review: a local review of a folder and branch, one however many threads work there, addressed to its main
// thread, the top thread working in that folder. `bb review` with no arguments starts it, or opens it as it is. Its page
// checks the folder (changed, on another branch, its machine offline, other threads there); once its branch has a PR
// the same review becomes that PR's; and bb removing the folder ends it, unless comments wait on it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { reanchorDraft, type FeatureReview, type MainThread, type ReviewLifecycle, type ReviewMeta } from "./store";
import type { AsyncStore } from "./store-queue";
import { diffFilesHead, isNotFound, isSecretPath, readFeatureDiff, readFeatureRevisions, type FeatureDiff, type FolderPr, type HiddenFile } from "./env-diff";
import { featureKey, prReviewKey, targetKey } from "./targets";
import { beginGuide, guideWriterUnavailable } from "./generate";
import { pruneDiffs } from "./feedback-view";
import { readPrSnapshot } from "./pr-snapshot";
import { ensureGitHeaders } from "./patch";
import { machineStatus } from "./machines";
import { identityIn, placeFacts, remoteRepo } from "./review-places";
import { defaultName } from "../lib/review-name";
import { parsePrLink } from "../lib/pr-link";
import type { EventListeners, RpcHandlers, ServeDeps } from "./server-modules";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
interface Deps { bb: BbPluginApi; store: AsyncStore; gh: ServeDeps["gh"]; changed(targetKey: string): void }

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
export function mainThreadState(review: Pick<ReviewMeta, "mainThread" | "implementers"> | null, main: Pick<Thread, "id" | "environmentId">, now: number, origin: MainThread["origin"] = "adopted"): ReviewLifecycle {
  const mainThread: MainThread = { threadId: main.id, environmentId: main.environmentId ?? null, origin, since: now };
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
  const key = featureKey(env.id, env.branchName);
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

/** The parts of `bb review`'s output the no-argument form takes. */
interface FeatureCommand { name?: string; context?: string; inThreads: boolean }
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

/**
 * `bb review` with no arguments: the review of the folder the calling thread works in, at its branch now, started or
 * opened as it is, addressed to the top thread working there. `ownReview`: a review's own agent ran it, which may not.
 */
export async function runFeatureCommand(deps: Deps, command: FeatureCommand, ctx: Ctx, ownReview?: string) {
  const { bb, store } = deps;
  if (ownReview !== undefined) return { exitCode: 2, stderr: "A review’s own agent can’t start a review of a folder." };
  if (!ctx.threadId) return { exitCode: 2, stderr: "Run `bb review` with no arguments in a bb thread: it reviews the changes in that thread’s folder. Outside a thread, pass a PR or a git ref." };
  let caller: Thread | null;
  try {
    caller = await threadOf(bb, ctx.threadId);
  } catch (error) {
    return { exitCode: 1, stderr: `Couldn’t read this thread from BB: ${error instanceof Error ? error.message : String(error)}. Try again in a moment.` };
  }
  if (!caller) return { exitCode: 1, stderr: "BB has no record of this thread. Run `bb review` in a thread that works in a folder." };
  if (!caller.environmentId) return { exitCode: 2, stderr: "This thread has no folder yet. Run `bb review` once it’s working in one." };
  const folder = await folderOf(bb, caller.environmentId);
  if ("error" in folder) return { exitCode: 1, stderr: folder.error };
  // Unknown, it starts no review, and an existing one keeps its main thread.
  const main = await mainThreadOf(bb, caller).catch(() => null);
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

/** What a feature review's page says about its folder, and the review its PR had already, if any. */
export interface FeatureCheck {
  /** current: as the review shows it. changed: `changedFiles` differ. paused: on `branch`. offline, gone, unavailable: `message`. */
  state: "current" | "changed" | "paused" | "offline" | "gone" | "unavailable";
  changedFiles?: number;
  branch?: string | null;
  message?: string;
  /** Other threads working in the folder: not the main thread, nor its subagents. */
  alsoActive: Array<{ threadId: string; title: string }>;
  /** Files the review keeps out, and committed files that look like secrets you haven't said Got it to. */
  hidden: HiddenFile[];
  flagged: string[];
  prReview?: string;
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
 * The PR a folder's read found, when it's this review's branch's in this review's repo, and open: a branch used again
 * after its PR merged is new work, not that PR's.
 */
function prOfBranch(feature: FeatureReview, pr: FolderPr | undefined): { repo: string; number: number } | null {
  const link = pr?.url ? parsePrLink(pr.url) : null;
  if (!link || !pr?.number || pr.headRefName !== feature.branch || !feature.repo || link.repo.toLowerCase() !== feature.repo.toLowerCase()) return null;
  if (pr.state !== undefined && !/^open$/i.test(pr.state)) return null;
  return { repo: link.repo, number: pr.number };
}

/**
 * The review of a folder becomes its branch's PR's, `pr`: the same review, now of the PR, its diff the PR's at its head,
 * the comments moved with their lines, and no guide writer. Its folder stays, for what isn't pushed yet. When the PR
 * already has a review of its own, this one links to it instead. Returns which, or "skipped" when it can't now.
 */
export async function becomePr(deps: Deps, key: string, pr: { repo: string; number: number }): Promise<"converted" | "linked" | "skipped"> {
  const { store, gh } = deps;
  const link = async (prKey: string) => {
    const linked = await store.exclusive(async (tx) => {
      const review = featureOf(await tx.getReview(key));
      if (!review || review.feature.prReview === prKey) return false;
      await tx.setLifecycle(key, { feature: { ...review.feature, prReview: prKey } });
      return true;
    });
    if (linked) deps.changed(key);
    return "linked" as const;
  };
  const prKey = await prReviewKey(store, pr);
  if (prKey !== key && await store.getReview(prKey)) return link(prKey);
  // A guide being written is for the folder's diff: it becomes the PR's once that's done.
  const now = featureOf(await store.getReview(key));
  if (!now || now.kind !== "ref" || now.status === "generating") return "skipped";
  let snapshot: Awaited<ReturnType<typeof readPrSnapshot>>;
  try {
    snapshot = await readPrSnapshot(gh.runGh, pr.number, pr.repo);
  } catch {
    return "skipped";
  }
  if (snapshot.pr.state !== undefined && snapshot.pr.state !== "OPEN") return "skipped";
  const done = await store.exclusive(async (tx) => {
    const review = featureOf(await tx.getReview(key));
    if (!review || review.kind !== "ref" || review.status === "generating") return "skipped" as const;
    // A review of the PR started meanwhile.
    if (await tx.getReview(targetKey({ kind: "pr", ...pr }))) return "link" as const;
    const { pr: read } = snapshot;
    const previous = await tx.patch(key);
    const next = ensureGitHeaders(snapshot.patch);
    await tx.savePatch(key, next);
    // Your name for it stays; the main thread's title gives way to the PR's.
    await tx.saveReview({
      targetKey: key, kind: "pr", number: pr.number, repo: pr.repo, url: read.url, title: read.title, author: read.author?.login,
      base: read.baseRefName, head: read.headRefName, gitRef: `${read.baseRefName}...${read.headRefName}`, headSha: read.headRefOid,
      status: review.status, createdAt: review.createdAt, ...review.projectId ? { projectId: review.projectId } : {},
    });
    await tx.saveSnapshot(key, read.headRefOid, next);
    await tx.rebaseDraftComments(key, await reanchorDraft(tx, key, previous, next));
    // What gh said of the PR, until the sync reads it (src/start-review.ts recordPrState).
    if (read.state === "OPEN" || read.state === "CLOSED" || read.state === "MERGED") await tx.setLifecycle(key, { startedPrState: read.state });
    await pruneDiffs(tx, (await tx.getReview(key))!);
    return "converted" as const;
  });
  if (done === "link") return link(targetKey({ kind: "pr", ...pr }));
  if (done === "converted") deps.changed(key);
  return done;
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
  const linked = feature.prReview ? { prReview: feature.prReview } : {};
  // Once it's a PR's review, the PR says what changed.
  if (review.kind !== "ref") return { ...empty, ...linked };
  const kept = await store.exclusive(async (tx) => {
    const hash = await tx.patchHash(key);
    return { hash, files: await tx.getSnapshotFiles(key, diffFilesHead(hash)), knobs: (await tx.getPreferences()).preferences.knobs };
  });
  const included = new Set(review.includeHidden ?? []);
  const hidden = kept.files?.hidden ?? [];
  const seen = new Set(review.flaggedSeen ?? []);
  const flagged = Object.keys(kept.files?.revisions ?? {}).filter((path) => isSecretPath(path) && !included.has(path) && !seen.has(path) && !hidden.some((file) => file.path === path));
  const base: FeatureCheck = { ...empty, hidden, flagged, ...linked };
  if (feature.folderGone) return { ...base, state: "gone", message: "BB removed this folder." };

  const [read, others] = await Promise.all([readFeatureRevisions(bb, feature), alsoActive(bb, review)]);
  const withOthers: FeatureCheck = { ...base, alsoActive: others };
  // A folder on no branch is on its detached HEAD.
  const pausedOn = read.outcome === "paused" ? read.branch ?? "HEAD" : read.outcome === "available" ? null : undefined;
  if (read.outcome === "gone") {
    if (await store.exclusive(async (tx) => { const now = featureOf(await tx.getReview(key)); return !!now && await markFolderGone(tx, now); })) deps.changed(key);
    return { ...base, state: "gone", message: read.message };
  }
  // The branch the folder is on, or back on its own, as the list shows it.
  if (pausedOn !== undefined && (feature.pausedOn ?? null) !== pausedOn) {
    const saved = await store.exclusive(async (tx) => {
      const now = featureOf(await tx.getReview(key));
      if (!now || now.kind !== "ref") return false;
      await tx.setLifecycle(key, { feature: { ...now.feature, pausedOn } });
      return true;
    });
    if (saved) deps.changed(key);
  }
  if (read.outcome === "paused") {
    const other = read.branch ? featureKey(feature.environmentId, read.branch) : null;
    return { ...withOthers, state: "paused", branch: read.branch, ...other && await store.getReview(other) ? { branchReview: other } : {} };
  }
  if (read.outcome !== "available") return { ...withOthers, state: read.outcome, message: read.message };
  // Its branch has a PR: the review becomes that PR's, or links to the review it has.
  const pr = prOfBranch(feature, read.pr);
  const became = pr ? await becomePr(deps, key, pr) : "skipped";
  if (became === "converted") return empty;
  if (became === "linked") withOthers.prReview = featureOf(await store.getReview(key))?.feature.prReview;
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
 * Update: read a feature review's folder again and show it, the comments following their lines, without the guide
 * writer. Not while its guide is being written, and not from another branch: the review waits for its own. A diff that
 * moves is newer than the guide: `why` says what moved it, your Update or Include and Keep out.
 */
export async function updateFeature(deps: Deps, key: string, why: "update" | "include" = "update"): Promise<{ ok: boolean; error?: string }> {
  const { bb, store } = deps;
  const review = featureOf(await store.getReview(key));
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

export function register(deps: ServeDeps) {
  const { bb, store } = deps;
  /** The feature reviews of this folder, or whose main thread this is. */
  const reviewsOf = async (match: (review: ReviewMeta & { feature: FeatureReview }) => boolean) =>
    (await store.listReviews()).map(featureOf).filter((review): review is ReviewMeta & { feature: FeatureReview } => !!review && match(review));

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
    // A main thread that stops may have changed the folder: its reviews check, and their open pages ask again.
    "thread.idle": [async ({ thread }) => {
      if (!thread.environmentId || thread.visibility === "hidden") return;
      for (const review of await reviewsOf((review) => review.kind === "ref" && review.mainThread?.threadId === thread.id && !review.feature.folderGone)) {
        await checkFeature(deps, review.targetKey).catch(() => {});
        bb.realtime.publish(`folder:${review.targetKey}`, { ts: Date.now() });
      }
    }],
  };
  return { handlers, events };
}
