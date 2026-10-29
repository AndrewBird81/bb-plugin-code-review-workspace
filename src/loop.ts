// The loop with the thread that writes the code (notes/design/E7-plan.md Part 2 §4). Send and Send now take your
// comments to the review's main thread, after its turn if it's busy, each with an id it reports on, and keep the diff
// they went at as that Send's snapshot. Someone else's PR, a main thread that's archived or deleted, and a folder bb
// removed warn first; the same call with your choice sends: anyway, after unarchiving the thread, or to a fresh one.
// The review agent's send_now does what Send now does when the reviewer asks, and "You do it" puts its exact patch on
// that comment's Send, for the main thread to apply as written: the folder keeps one writer.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sameLocation, type CommentLocation, type DraftComment } from "./draft";
import { newCommentIds, type ReviewLifecycle, type ReviewMeta, type SendEntry, type SnapshotFiles } from "./store";
import type { AsyncStore } from "./store-queue";
import { assistantReview } from "./draft-comments";
import { requireReviewRevision } from "./review-revision";
import { isMissingThread } from "./thread-errors";
import { branchLine, commentText, fenced, fixerExecution, fixerTitle, GUARD, GUARD_BUT_PUSH, header, isOwnChange, placed, theirPr, where, type Placed } from "./fix-handoff";
import { homeShort, mainThreadState } from "./feature-review";
import { diffFilesHead } from "./env-diff";
import { pruneDiffs } from "./feedback-view";
import { machineStatus } from "./machines";
import { sendKey } from "../lib/send-baseline";
import { failed, type EventListeners, type RpcHandlers, type ServeDeps } from "./server-modules";
import { ONLY_WITH_THESE_TOOLS } from "./review-agent-tools";
import { settleFixes } from "./fix-tally";

/** The thread a review's Sends go to, as the review shows it, and the machine it works on when that's known. */
export interface MainThreadLink { threadId: string; title: string | null; state: "open" | "archived" | "gone"; machine?: string | null }

/** What a Send that warned offers: send it anyway, unarchive its main thread and send, or send to a fresh thread. */
export type Offer = "anyway" | "unarchive" | "fresh";
/**
 * A Send that didn't go: why, and what the same call with `force`, and with `thread` for unarchive or fresh, does;
 * with fresh offered, where that thread starts.
 */
export interface Warned { ok: false; warning: string; offers: Offer[]; freshWhere?: string }
/** Your choices for a Send: past the warning (`force`), and where it goes when its main thread can't take it (`thread`). */
export interface Choices { force?: boolean; thread?: "unarchive" | "fresh" }
/** What you add to a Send: your own message, and whether the draft's summary goes too. */
export interface SendExtras { message?: string; includeSummary?: boolean }
/** A Send that went: where, whether it waits for the thread's turn to end, its number and the ids of its comments. */
export interface Sent { ok: true; delivery: "sent" | "queued"; threadId: string; title: string | null; sendN: number; ids: string[] }


interface Deps { bb: BbPluginApi; store: AsyncStore; changed(targetKey: string): void }

/** The last line of every Send: how the thread says what it did with each comment. */
const REPORT = "Report each with `bb review report <id> done|declined --note \"…\"`; run `bb review ready` when finished.";
/** What a Send says unless you let the thread push (Let it push when done). */
const NO_PUSH = "Don't push until I say.";
const APPROVED = "Approved";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
const threadTitle = (thread: Pick<Thread, "title" | "titleFallback">) => thread.title ?? thread.titleFallback ?? null;
const error = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

/**
 * The id of the thread a review's Sends go to: its main thread, or for a review from before 1.8.0, the thread bb review
 * ran in. Never one of this plugin's own agents.
 */
async function recipientOf(tx: AsyncStore, review: ReviewMeta): Promise<string | null> {
  const threadId = review.mainThread?.threadId ?? review.sourceThreadId;
  return !threadId || await assistantReview(tx, threadId) || await tx.generationOf(threadId) ? null : threadId;
}

/** The recipient as BB has it now: open, archived, or gone (deleted, or unknown to BB). Any other failure throws. */
async function readRecipient(bb: BbPluginApi, threadId: string): Promise<{ thread: Thread | null; state: MainThreadLink["state"] }> {
  const thread = await bb.sdk.threads.get({ threadId }).catch((failure) => {
    if (isMissingThread(failure)) return null;
    throw new Error(`Couldn’t read the main thread from BB: ${error(failure)}. Try again in a moment.`);
  });
  if (!thread || thread.deletedAt) return { thread: null, state: "gone" };
  return { thread, state: thread.archivedAt ? "archived" : "open" };
}

/** A folder's review whose main thread worked in the folder bb removed: the next Send starts a fresh thread from its branch. */
const folderGone = (review: ReviewMeta) => !!review.feature?.folderGone && (!review.mainThread || review.mainThread.environmentId === review.feature.environmentId);

/** Where a fresh thread for the review starts, as a warning says it; in a new worktree, `from` the branch it's made from. */
interface Fresh { environment: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"]; said: string; from?: string }

/**
 * Where a fresh thread for the review starts: in its folder; with the folder removed, always in a new worktree made from
 * the branch the review reads, which has the work committed there; else in its project.
 */
function freshPlace(review: ReviewMeta): Fresh {
  const feature = review.feature;
  if (feature?.folderGone) {
    const from = feature.workBranch ?? feature.branch;
    return { environment: { type: "host", hostId: feature.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: from } } }, said: `in a new worktree from ${from}`, from };
  }
  if (feature) return { environment: { type: "reuse", environmentId: feature.environmentId }, said: `in ${homeShort(feature.path)}` };
  return { environment: { type: "project-default" }, said: "in the review’s project" };
}

/**
 * Note where the review's fresh main thread works once BB says: its folder, if that wasn't known when it started; and
 * when it took over from a folder bb removed, the review reads that new worktree from then on, on its own branch,
 * keeping its key, and `branch`, which it pushes to. A worktree still being made is tried again at the next read.
 */
async function settleFolder(deps: Deps, targetKey: string, thread: Pick<Thread, "id" | "environmentId">) {
  const { bb, store } = deps;
  if (!thread.environmentId) return;
  const review = await store.getReview(targetKey);
  const main = review?.mainThread;
  if (!review || main?.threadId !== thread.id) return;
  const rehome = !!review.feature?.folderGone && main.origin === "fresh" && thread.environmentId !== review.feature.environmentId;
  if (main.environmentId !== null && !rehome) return;
  const env = rehome ? await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null) : null;
  const folder = env?.path && env.branchName ? { env, path: env.path, branch: env.branchName, machine: (await machineStatus(bb, env.hostId))?.name } : null;
  const changed = await store.exclusive(async (tx) => {
    const now = await tx.getReview(targetKey);
    if (now?.mainThread?.threadId !== thread.id) return false;
    const state: ReviewLifecycle = {};
    if (now.mainThread.environmentId === null) state.mainThread = { ...now.mainThread, environmentId: thread.environmentId };
    if (folder && now.feature?.folderGone) state.feature = {
      ...now.feature, environmentId: folder.env.id, hostId: folder.env.hostId, machine: folder.machine ?? now.feature.machine, path: folder.path,
      workBranch: folder.branch, folderGone: false, pausedOn: null, changedFiles: null,
    };
    if (!state.mainThread && !state.feature) return false;
    await tx.setLifecycle(targetKey, state);
    return true;
  });
  if (changed) deps.changed(targetKey);
}

/** Whether the review's main thread may have a folder still to note, which `thread`, read from BB, may say. */
const unsettled = (review: ReviewMeta, thread: Thread | null) => !!thread?.environmentId && review.mainThread?.threadId === thread.id
  && (review.mainThread.environmentId === null || !!review.feature?.folderGone && review.mainThread.origin === "fresh");

/** The review's main thread as its page shows it, with its machine; null without one. */
export async function mainThreadLink(deps: Deps, targetKey: string): Promise<MainThreadLink | null> {
  const { bb, store } = deps;
  const found = await store.exclusive(async (tx) => {
    const review = await tx.getReview(targetKey);
    return review ? { review, threadId: await recipientOf(tx, review) } : null;
  });
  if (!found?.threadId) return null;
  const { threadId } = found;
  let { review } = found;
  const { thread, state } = await readRecipient(bb, threadId);
  if (unsettled(review, thread)) {
    await settleFolder(deps, targetKey, thread!);
    review = (await store.getReview(targetKey)) ?? review;
  }
  const inFolder = !!review.feature && review.mainThread?.environmentId === review.feature.environmentId;
  const machine = inFolder ? review.feature!.machine : thread?.environmentId
    ? (await machineStatus(bb, (await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null))?.hostId))?.name ?? null
    : null;
  return { threadId, title: thread ? threadTitle(thread) : null, state, machine };
}

/**
 * Where a Send goes once it's past its warnings: the recipient, unarchived first; a fresh thread; or, for an approval,
 * which never starts one, no thread at all: it's only recorded.
 */
type Route = { to: { threadId: string; title: string | null }; unarchive?: boolean } | { fresh: Fresh } | { none: { threadId: string; title: string | null } };

/**
 * Where a Send goes, or the warning that needs your choice first: someone else's PR (`own` false) and the Send's own
 * `notes`, which `force` passes, and the main thread's state, which `thread` answers. An approval (`spawn` false) starts
 * no thread: where a Send would, it offers to record the approval anyway. Throws when there's nowhere to send.
 */
async function route(deps: Deps, review: ReviewMeta, own: boolean, notes: string[], { force, thread: choice }: Choices, spawn = true): Promise<Route | Warned> {
  const { bb, store } = deps;
  const said = force ? [] : [...own ? [] : [theirPr(review)], ...notes];
  const offers: Offer[] = [];
  const fresh = freshPlace(review);
  const threadId = await store.exclusive((tx) => recipientOf(tx, review));
  const unsent = "so no thread gets your approval. Send anyway records it.";
  let routed: Route;
  if (folderGone(review)) {
    const { path, machine } = review.feature!;
    const lost = `BB removed the folder ${homeShort(path)} on ${machine}, and any uncommitted work in it`;
    if (!spawn) {
      if (!force) said.push(`${lost}, ${unsent}`);
      routed = { none: { threadId: threadId ?? "", title: null } };
    } else {
      if (choice !== "fresh") { said.push(`${lost}. Send starts a fresh thread ${fresh.said}.`); offers.push("fresh"); }
      routed = { fresh };
    }
  } else {
    if (!threadId) throw new Error("This review has no main thread to send to. Run bb review in the thread working on the change, or use Fix in a new thread.");
    const { thread, state } = await readRecipient(bb, threadId);
    if (unsettled(review, thread)) await settleFolder(deps, review.targetKey, thread!);
    const title = thread ? threadTitle(thread) : null;
    if (state === "gone") {
      if (!spawn) {
        if (!force) said.push(`${title ?? "The main thread"} was deleted, ${unsent}`);
        routed = { none: { threadId, title } };
      } else {
        if (choice !== "fresh") { said.push(`${title ?? "The main thread"} was deleted. Send starts a fresh thread ${fresh.said}.`); offers.push("fresh"); }
        routed = { fresh };
      }
    } else if (state === "archived") {
      if (!spawn) {
        if (!choice && !force) { said.push(`${title ?? "The main thread"} is archived. Unarchive it and send, or Send anyway to record your approval without telling it.`); offers.push("unarchive", "anyway"); }
        routed = choice === "unarchive" ? { to: { threadId, title }, unarchive: true } : { none: { threadId, title } };
      } else {
        if (!choice) { said.push(`${title ?? "The main thread"} is archived. Unarchive it and send, or start a fresh thread ${fresh.said}.`); offers.push("unarchive", "fresh"); }
        routed = choice === "fresh" ? { fresh } : { to: { threadId, title }, unarchive: true };
      }
    } else routed = { to: { threadId, title } };
  }
  if (!said.length) return routed;
  return { ok: false, warning: said.join(" "), offers: offers.length ? offers : ["anyway"], ...offers.includes("fresh") ? { freshWhere: fresh.said } : {} };
}

/** How a fresh thread in a new worktree learns where it is: not the folder that's gone, nor on the branch it was made from. */
const newWorktree = (shown: Placed, from: string) => ({
  shown: { ...shown, place: shown.place ? { ...shown.place, path: undefined } : shown.place },
  branch: `You're in a new worktree on a branch made from \`${from}\`; commit there.`,
});

/**
 * Send `text` on its route: to the thread after its turn if it's busy, unarchived first, or as a fresh thread's first
 * message; for an approval with no thread to tell, nowhere: it's only recorded.
 */
async function go(deps: Deps, review: Placed, routed: Route, text: string): Promise<{ threadId: string; title: string | null; delivery: "sent" | "queued"; queued?: string; fresh?: Pick<Thread, "id" | "environmentId">; recorded?: true }> {
  const { bb, store } = deps;
  if ("none" in routed) return { ...routed.none, delivery: "sent", recorded: true };
  if ("fresh" in routed) {
    if (!review.projectId) throw new Error("This review has no project to start a thread in; re-run `bb review` inside a project.");
    const execution = await fixerExecution(bb, store, review.projectId);
    const title = fixerTitle(review);
    try {
      const thread = await bb.sdk.threads.spawn({ projectId: review.projectId, environment: routed.fresh.environment, prompt: text, title, ...execution });
      return { threadId: thread.id, title: threadTitle(thread) ?? title, delivery: "sent", fresh: thread };
    } catch (failure) {
      throw new Error(`Couldn’t start the thread: ${error(failure)}`);
    }
  }
  const { threadId, title } = routed.to;
  if (routed.unarchive) await bb.sdk.threads.unarchive({ threadId }).catch((failure) => { throw new Error(`Couldn’t unarchive ${title ?? "the main thread"}: ${error(failure)}`); });
  try {
    const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    const queued = sent?.delivery === "queued" ? sent.queuedMessage?.id : undefined;
    return { threadId, title, delivery: sent?.delivery === "queued" ? "queued" : "sent", ...queued ? { queued } : {} };
  } catch (failure) {
    throw new Error(`Couldn’t send to the thread: ${error(failure)}`);
  }
}

/** Your message and the draft's summary, trimmed, as a Send adds them; empty ones are left out. */
function extras(draftBody: string, { message, includeSummary }: SendExtras): { message: string; summary: string } {
  return { message: message?.trim() ?? "", summary: includeSummary ? draftBody.trim() : "" };
}

/** A unified diff, as `git apply` takes it: file headers and at least one hunk. */
const isPatch = (patch: string) => /^(diff --git |--- )/m.test(patch) && /^\+\+\+ /m.test(patch) && /^@@ /m.test(patch);

/**
 * Send the draft comments at `picked` to the review's main thread, after its current turn if it's busy: each gets an
 * id it reports on, and goes as sent in Send n, whose diff, and a folder's revisions and hidden files, are kept as
 * `send:<n>`. Your message leads, the summary follows the comments, then "Don't push until I say" unless the thread may
 * push (`letPush`, else the review's Let it push when done); a fresh thread gets Fix in a new thread's limits on GitHub
 * too. `patch`, for one comment, is the review agent's exact fix, kept on the Send, which the thread applies as written.
 * The draft is otherwise as it was.
 */
export async function send(deps: Deps, targetKey: string, picked: readonly CommentLocation[], add: SendExtras & Choices & { letPush?: boolean; patch?: string } = {}): Promise<Sent | Warned> {
  const { bb, store } = deps;
  const review = await store.getReview(targetKey);
  if (!review) throw new Error("This review no longer exists.");
  if (add.patch !== undefined && (picked.length !== 1 || !isPatch(add.patch))) throw new Error("A patch goes with one comment, as a unified diff with file headers and hunks, as git apply takes it.");
  const own = await isOwnChange(review);
  const routed = await route(deps, review, own, [], add);
  if ("warning" in routed) return routed;
  const shown = await placed(bb, store, review);
  // Someone else's code reads as theirs.
  const theirs = own ? undefined : review.author ?? null;
  const letPush = add.letPush ?? review.letPush ?? false;
  const fresh = "fresh" in routed ? routed.fresh : null;
  const moved = fresh?.from ? newWorktree(shown, fresh.from) : null;
  // A fresh thread is told GitHub's limits as Fix in a new thread is: all of them, or, let push, all but the push.
  const limits = fresh ? [letPush ? GUARD_BUT_PUSH : GUARD] : letPush ? [] : [NO_PUSH];
  // What the message says, and what the Send keeps, read in one turn; the comments get their ids now.
  const composed = await store.exclusive(async (tx) => {
    const draft = await tx.getDraft(targetKey);
    const comments = draft.comments.filter((comment) => picked.some((at) => sameLocation(at, comment)));
    if (!comments.length) return null;
    const unnamed = comments.filter((comment) => !comment.id);
    const ids = unnamed.length ? await newCommentIds(tx, bb.storage.kv, unnamed.length) : [];
    if (unnamed.length) await tx.trackComments(targetKey, unnamed.map((comment, i) => ({ at: comment, id: ids[i] })));
    const named = comments.map((comment) => ({ ...comment, id: comment.id ?? ids[unnamed.indexOf(comment)] })) as Array<DraftComment & { id: string }>;
    const patch = await tx.patch(targetKey);
    const stale = await tx.staleDraftComments(targetKey);
    const preExisting = (await tx.getPreferences()).preferences.knobs.preExistingFindings;
    const files: SnapshotFiles | null = review.feature ? await tx.getSnapshotFiles(targetKey, diffFilesHead(await tx.patchHash(targetKey))) : null;
    const { message, summary } = extras(draft.body, add);
    const items = named.map((comment) => commentText(comment, patch, stale, preExisting, { id: comment.id, author: theirs }));
    const apply = add.patch === undefined ? [] : [
      `I asked the review agent to fix ${named[0].id} itself. Apply its patch as written, with \`git apply\`, and change nothing else for it; if it doesn't apply cleanly, report ${named[0].id} declined with why.`,
      fenced(add.patch, "diff"),
    ];
    const text = [message, moved ? where(moved.shown, moved.branch) : where(shown), ...items, ...apply, summary, ...limits, REPORT].filter(Boolean).join("\n\n");
    return { comments: named, patch, files, text };
  });
  if (!composed) throw new Error("Those comments are no longer in the draft.");
  const went = await go(deps, shown, routed, composed.text);
  const n = await store.exclusive(async (tx) => {
    const now = (await tx.getReview(targetKey)) ?? review;
    const n = Math.max(0, ...(now.sends ?? []).map((entry) => entry.n)) + 1;
    await tx.saveSnapshot(targetKey, sendKey(n), composed.patch);
    if (composed.files) await tx.saveSnapshotFiles(targetKey, sendKey(n), composed.files);
    // Each comment as it went, with no report yet; one edited meanwhile is open again, for the next Send.
    const { comments } = await tx.getDraft(targetKey);
    const unchanged = composed.comments.filter((sent) => comments.some((comment) => sameLocation(comment, sent) && comment.body === sent.body));
    await tx.trackComments(targetKey, unchanged.map((comment) => ({ at: comment, state: "sent" as const, sendN: n, claim: undefined })));
    const at = Date.now();
    const entry: SendEntry = { n, at, threadId: went.threadId, ids: composed.comments.map((comment) => comment.id), ...add.patch === undefined ? {} : { patch: add.patch }, ...went.queued ? { queued: went.queued } : {} };
    // 1.7.0's record, which its Send to thread reads: comments sent to this thread before stay marked, one sent again is marked now.
    const earlier = now.sent?.threadId === went.threadId ? now.sent.comments.filter((comment) => !composed.comments.some((sent) => sameLocation(sent, comment))) : [];
    await tx.setLifecycle(targetKey, {
      sends: [...now.sends ?? [], entry],
      sent: { at, threadId: went.threadId, title: went.title, comments: [...earlier, ...composed.comments.map(({ file, line, side, body }) => ({ file, line, side, body, at }))] },
      // The comments supersede an approval sent before them.
      approvalSent: null,
      ...went.fresh ? mainThreadState(now, went.fresh, at, "fresh") : {},
    });
    await settleFixes(tx, targetKey);
    await pruneDiffs(tx, (await tx.getReview(targetKey))!);
    return n;
  });
  if (went.fresh) await settleFolder(deps, targetKey, went.fresh);
  deps.changed(targetKey);
  bb.realtime.publish(`draft:${targetKey}`, {});
  return { ok: true, delivery: went.delivery, threadId: went.threadId, title: went.title, sendN: n, ids: composed.comments.map((comment) => comment.id) };
}

/**
 * Tell the review's main thread you approve the change as is, after its current turn if it's busy, and record it against
 * the diff you approved, `revision`, the one your page shows. With comments not yet sent, or once told for this diff,
 * it warns first. It starts no thread: with none to tell, it's only recorded, once you say so.
 */
export async function sendApproval(deps: Deps, targetKey: string, revision: string | undefined, add: SendExtras & Choices = {}): Promise<{ ok: true; delivery: "sent" | "queued"; title: string | null; threadId: string; recorded?: true } | Warned> {
  const { bb, store } = deps;
  const { review, open, body } = await store.exclusive(async (tx) => {
    // Only the diff you saw, as submit checks it: not one that changed since, or a guide still rebuilding.
    await requireReviewRevision(tx, targetKey, revision);
    const draft = await tx.getDraft(targetKey);
    return { review: await tx.getReview(targetKey), open: draft.comments.filter((comment) => !comment.state || comment.state === "open").length, body: draft.body };
  });
  if (!review) throw new Error("This review no longer exists.");
  const notes = [
    ...open ? [`Your draft has ${open} comment${open === 1 ? "" : "s"} you haven’t sent. Send ${open === 1 ? "it" : "them"} instead, or send Approved anyway?`] : [],
    ...review.approvalSent && review.approvalSent.revision === revision ? [`You already told ${review.approvalSent.title ?? "the thread"} you approve this diff.`] : [],
  ];
  const routed = await route(deps, review, await isOwnChange(review), notes, add, false);
  if ("warning" in routed) return routed;
  const shown = await placed(bb, store, review);
  const { message, summary } = extras(body, add);
  const went = await go(deps, shown, routed, [`${header(shown)}\n${APPROVED}`, message, summary].filter(Boolean).join("\n\n"));
  // The page shows `revision`, or the check above refused.
  await store.setLifecycle(targetKey, { approvalSent: { at: Date.now(), threadId: went.threadId, title: went.title, revision: revision! } });
  deps.changed(targetKey);
  return { ok: true, delivery: went.delivery, title: went.title, threadId: went.threadId, ...went.recorded ? { recorded: true as const } : {} };
}

/** Send to `threadId` from now on, one working in the review's folder while it's there: not archived, and not one of this plugin's agents. */
export async function setMainThread(deps: Deps, targetKey: string, threadId: string): Promise<{ ok: boolean; error?: string }> {
  const { bb, store } = deps;
  const review = await store.getReview(targetKey);
  if (!review) return { ok: false, error: "This review no longer exists." };
  const { thread, state } = await readRecipient(bb, threadId).catch(() => ({ thread: null, state: "unread" as const }));
  if (state === "unread") return { ok: false, error: "Couldn’t read that thread from BB. Try again in a moment." };
  if (!thread || state === "gone") return { ok: false, error: "That thread was deleted. Choose another." };
  if (state === "archived") return { ok: false, error: `${threadTitle(thread) ?? "That thread"} is archived. Unarchive it in BB first, or choose another.` };
  // A review's agents and guide writers are hidden; a fix thread the plugin started is yours to send to.
  if (thread.visibility === "hidden" || await store.exclusive(async (tx) => !!await assistantReview(tx, threadId) || !!await tx.generationOf(threadId))) {
    return { ok: false, error: "That thread is one of Code Review Workspace’s agents. Choose a thread working on the change." };
  }
  if (review.feature && !review.feature.folderGone && thread.environmentId !== review.feature.environmentId) return { ok: false, error: `That thread works in another folder. Choose one working in ${homeShort(review.feature.path)}.` };
  await store.exclusive(async (tx) => {
    const now = await tx.getReview(targetKey);
    if (now && now.mainThread?.threadId !== threadId) await tx.setLifecycle(targetKey, mainThreadState(now, thread, Date.now()));
  });
  deps.changed(targetKey);
  return { ok: true };
}

/**
 * Start a fresh thread to be the review's main thread, in its folder (or from its branch in a new worktree, the folder
 * gone; or in its project), told what it's for: your Sends come there.
 */
export async function startMainThread(deps: Deps, targetKey: string): Promise<{ ok: boolean; error?: string }> {
  const { bb, store } = deps;
  const review = await store.getReview(targetKey);
  if (!review) return { ok: false, error: "This review no longer exists." };
  const fresh = freshPlace(review);
  const placedNow = await placed(bb, store, review);
  const moved = fresh.from ? newWorktree(placedNow, fresh.from) : null;
  const shown = moved?.shown ?? placedNow;
  const text = [`${header(shown)}\nYou're this review's main thread now: I'll send my comments here, each with an id and how to report on it.`,
    moved?.branch ?? branchLine(shown), review.letPush ? GUARD_BUT_PUSH : GUARD].join("\n\n");
  let went: Awaited<ReturnType<typeof go>>;
  try {
    went = await go(deps, shown, { fresh }, text);
  } catch (failure) {
    return { ok: false, error: error(failure) };
  }
  await store.exclusive(async (tx) => {
    const now = await tx.getReview(targetKey);
    if (now && went.fresh) await tx.setLifecycle(targetKey, mainThreadState(now, went.fresh, Date.now(), "fresh"));
  });
  if (went.fresh) await settleFolder(deps, targetKey, went.fresh);
  deps.changed(targetKey);
  return { ok: true };
}

/**
 * A Send's message that waited in its thread's queue: taken, it's no longer queued; deleted from the queue before the
 * thread took it, its comments were never sent, so they're open again for the next Send, and the Send is dropped.
 */
export async function settleQueued(deps: Deps, entry: { id: string; threadId: string }, taken: boolean) {
  const { store } = deps;
  const changed = await store.exclusive(async (tx) => {
    const keys: string[] = [];
    for (const review of await tx.listReviews()) {
      const send = review.sends?.find((s) => s.queued === entry.id && s.threadId === entry.threadId);
      if (!send) continue;
      if (!taken) {
        const { comments } = await tx.getDraft(review.targetKey);
        await tx.trackComments(review.targetKey, comments.filter((comment) => comment.state === "sent" && comment.sendN === send.n).map((comment) => ({ at: comment, state: "open" as const, sendN: undefined })));
      }
      await tx.setLifecycle(review.targetKey, { sends: taken ? review.sends!.map((s) => s === send ? { ...s, queued: undefined } : s) : review.sends!.filter((s) => s !== send) });
      if (!taken) await settleFixes(tx, review.targetKey);
      keys.push(review.targetKey);
    }
    return keys;
  });
  for (const key of changed) {
    deps.changed(key);
    deps.bb.realtime.publish(`draft:${key}`, {});
  }
}

const off = "Send to thread is off in Review settings.";

export function register(deps: ServeDeps) {
  // Who's asking in the review agent's turn (src/asking.ts): a turn the plugin started never sends.
  const { bb, store, changed, classify } = deps;
  const sendOn = async () => (await store.getPreferences()).preferences.knobs.sendToThread;
  const handlers = {
    async getSourceThread({ targetKey }) {
      if (!await sendOn()) return { thread: null };
      return { thread: await mainThreadLink(deps, targetKey) };
    },
    async sendToSourceThread({ targetKey, comments, message, includeSummary, letPush, force, thread }) {
      if (!await sendOn()) throw new Error(off);
      const sent = await send(deps, targetKey, comments, { message, includeSummary, letPush, force, thread });
      return sent.ok ? { ok: true, delivery: sent.delivery, title: sent.title, threadId: sent.threadId, sendN: sent.sendN } : sent;
    },
    async sendApprovalToSourceThread({ targetKey, revision, message, includeSummary, force, thread }) {
      if (!await sendOn()) throw new Error(off);
      return sendApproval(deps, targetKey, revision, { message, includeSummary, force, thread });
    },
    async sendNow({ targetKey, comment, letPush, force, thread }) {
      if (!await sendOn()) return { ok: false, error: off };
      // Step 4.2 sends a thread on GitHub.
      if (!("file" in comment)) return { ok: false, error: "Send now on a thread on GitHub isn’t available yet." };
      try {
        const sent = await send(deps, targetKey, [comment], { letPush, force, thread });
        return sent.ok ? { ok: true, sent: { id: sent.ids[0], sendN: sent.sendN, threadId: sent.threadId, title: sent.title, delivery: sent.delivery } } : sent;
      } catch (failure) {
        return { ok: false, error: error(failure) };
      }
    },
    async setLetPush({ targetKey, letPush }) {
      if (!await sendOn()) return { ok: false, error: off };
      const found = await store.exclusive(async (tx) => {
        if (!await tx.getReview(targetKey)) return false;
        await tx.setLifecycle(targetKey, { letPush });
        return true;
      });
      if (!found) return { ok: false, error: "This review no longer exists." };
      changed(targetKey);
      return { ok: true };
    },
    async setMainThread(input) {
      if (!await sendOn()) return { ok: false, error: off };
      return "fresh" in input ? startMainThread(deps, input.targetKey) : setMainThread(deps, input.targetKey, input.threadId);
    },
  } satisfies Partial<RpcHandlers>;

  const events: EventListeners = {
    "message.dispatched": [({ entry }) => settleQueued(deps, entry, true)],
    "message.cancelled": [({ entry }) => settleQueued(deps, entry, false)],
  };

  bb.agents.registerTool({
    name: "send_now",
    description: "Send one of the reviewer's draft comments to the review's main thread now, the thread that writes the code, to fix: it gets an id the thread reports on, and goes after the thread's current turn. With patch, your exact fix goes with it, for the thread to apply as written. Nothing goes to GitHub.",
    instructions: `When the reviewer asks to have a comment fixed ("fix this", "send it"), send it with send_now and say so; add the comment with add_draft_comment first if the line has none. When they say you do it, write the exact unified diff that fixes it, against the code as it is now, and pass it as patch: the main thread applies it as written, so the folder keeps one writer. Don't change the code yourself. If it comes back with a warning, tell the reviewer in a line, and call again only as they choose: force: true to send anyway, with thread: "unarchive" or "fresh" when it offers those. In a turn the reviewer didn't start, it sends nothing: suggest it instead. ${ONLY_WITH_THESE_TOOLS}`,
    parameters: z.object({
      file: z.string().describe("The draft comment's file, exactly as the diff shows it."),
      line: z.number().int().min(1).max(2_147_483_647).describe("The draft comment's line (a range's last)."),
      side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT, the default, or LEFT for a comment on a removed line."),
      patch: z.string().max(200_000).optional().describe("When the reviewer said you do it: the exact unified diff that fixes this comment, with file headers and hunks, as git apply takes it."),
      force: z.boolean().optional().describe("Send past the warning the last call gave, once the reviewer says so."),
      thread: z.enum(["unarchive", "fresh"]).optional().describe("When the main thread is archived or deleted, as the warning offered: unarchive it, or start a fresh thread."),
    }),
    execute: async ({ file, line, side = "RIGHT", patch, force, thread }, { threadId }) => {
      const targetKey = await store.exclusive((tx) => assistantReview(tx, threadId));
      if (!targetKey) return failed("This conversation is no longer a review's assistant, so it has no comments to send.");
      const { knobs } = (await store.getPreferences()).preferences;
      // Settings' switch holds at once, though a running agent keeps the tools it started with.
      if (!knobs.reviewAgentActs) return failed("Settings has the review agent only draft now, so nothing was sent. The reviewer can send it with Send now on the comment.");
      if (!knobs.sendToThread) return failed(`${off} Nothing was sent; the reviewer can turn it on there.`);
      const turn = await classify(threadId).catch(() => ({ asking: "unattended" as const, message: null }));
      if (turn.asking === "unattended") return failed("Not sent: no one asked for it in this turn, and a turn the reviewer didn't start never sends. Suggest it in your reply; the reviewer sends it with Send now on the comment.");
      let sent: Sent | Warned;
      try {
        sent = await send(deps, targetKey, [{ file, line, side }], { force, thread, ...patch === undefined ? {} : { patch } });
      } catch (failure) {
        return failed(`Not sent: ${error(failure)}`);
      }
      if (!sent.ok) return { content: [{ type: "text", text: `Not sent yet. ${sent.warning} Tell the reviewer, and call send_now again only as they choose: ${sent.offers.map((offer) => offer === "anyway" ? "force: true" : `force: true, thread: "${offer}"`).join(", or ")}.` }] };
      const to = sent.title ?? "the main thread";
      // In the review's activity, with the thread that asked, as the review agent's other actions are.
      const from = turn.message?.senderThreadId ?? null;
      const fromTitle = from ? await bb.sdk.threads.get({ threadId: from }).then((asker) => asker.title ?? undefined, () => undefined) : undefined;
      await store.exclusive(async (tx) => {
        const now = await tx.getReview(targetKey);
        if (now) await tx.setLifecycle(targetKey, { activity: [...now.activity ?? [], { at: Date.now(), text: `Sent ${sent.ids[0]} on ${file}:${line} to ${to}${patch === undefined ? "" : ", with a patch"}`, asking: turn.asking, ...from ? { from } : {}, ...fromTitle ? { fromTitle } : {} }] });
      });
      changed(targetKey);
      return { content: [{ type: "text", text: `Sent as ${sent.ids[0]} in Send ${sent.sendN} to ${to}${sent.delivery === "queued" ? ", which is busy: it gets it when its current turn ends" : ""}.${patch === undefined ? "" : " It applies your patch as written."} Tell the reviewer.` }] };
    },
  });
  return { handlers, events };
}
