// Reports on the comments you sent (notes/design/E7-plan.md Part 2 §4). The thread that fixes them says what it did with
// each, `bb review report <id> done|declined`, and `bb review ready` once it's finished, from any thread, attributed to
// it. The review is Ready to re-review once every comment out is reported, or ready ran, and the review agent checks the
// fixes then, once per Send. Idle alone never means done, as a main thread goes idle whenever it hands work to
// subagents: the review shows "N of M reported · Check now" instead. Events missed while the plugin was down aren't
// told again, so it reads the main threads again when it starts.
import type { BbPluginApi, PluginCliContext, PluginCliResult, PluginThreadEventHandler } from "@get-bb/plugin-sdk";
import type { Claim, CommentLocation } from "./draft";
import type { ReviewMeta, SendEntry } from "./store";
import type { AsyncStore } from "./store-queue";
import { fixesState, reportedText } from "../lib/fixes";
import { settleFixes } from "./fix-tally";
import { parseTarget, prReviewKey } from "./targets";
import { identityIn, placeFacts } from "./review-places";
import { checkFeature } from "./feature-review";
import { refusedFromAgents } from "./relays";
import { startVerification } from "./verification";
import { isAssistantAnswering } from "./agent";
import { settleQueued } from "./loop";
import { reReviewCheckPrompt } from "./preferences";
import { isMissingThread } from "./thread-errors";
import { reportCommit } from "./push";
import type { EventListeners, RpcHandlers, ServeDeps, Subcommands } from "./server-modules";

export const REPORT_USAGE = [
  "usage: bb review report <id> done|declined [--note <text>] [--commit <sha>]",
  "       bb review report --commit <sha>",
  "",
  "Says what you did with a comment the reviewer sent you, by the id its Send gave it (c12). Run it from any thread;",
  "the review shows which thread reported. Nothing goes to GitHub.",
  "  done       you fixed it",
  "  declined   you won't fix it; say why with --note",
  "  --note     what you did, or why not, in a line or two (up to 2,000 characters); quote it for your shell",
  "  --commit   the commit with the fix, by its SHA",
  "Run `bb review ready` once you've finished with them all.",
  "",
  "With --commit alone, after the reviewer's Push: the commit with the changes they reviewed. The review checks it, and",
  "says whether to push it.",
].join("\n");

export const READY_USAGE = [
  "usage: bb review ready [<review>]",
  "",
  "Says you've finished with the comments the reviewer sent you: the review goes back to them to re-review, with what",
  "you reported. Without <review>, it's the review whose comments were sent to this thread.",
  "  <review>   the review's id as its Send names it (api:feat-x, web#12), a PR's URL, owner/repo#n, or its key",
].join("\n");

const NOTE_LIMIT = 2_000;
/** The most events bb gives in one page. */
const EVENT_PAGE = 100;
/** How far a request to a thread may seem to come before the Send that queued it, by the two clocks. */
const CLOCK_SLACK = 60_000;
const SHA = /^[0-9a-f]{7,40}$/i;
const usage = (problem: string, text: string): PluginCliResult => ({ exitCode: 2, stderr: `${problem}\n${text}` });
/** A review's own agents check fixes; they don't report them. */
const NOT_FROM_AGENTS = "A review's own agent can't report on fixes: the thread that fixes the code reports, and the review agent checks.";

/** A comment out with a thread, found by its id: a draft comment's place, or the GitHub thread it is on your own PR. */
type Found = { review: ReviewMeta; at: CommentLocation; thread?: never } | { review: ReviewMeta; thread: string; at?: never };

async function findComment(tx: AsyncStore, id: string): Promise<Found | null> {
  for (const review of await tx.listReviews()) {
    if (!review.sends?.length) continue;
    const comment = (await tx.getDraft(review.targetKey)).comments.find((c) => c.id === id);
    if (comment) return { review, at: comment };
    const thread = Object.entries(review.threadSends ?? {}).find(([, sent]) => sent.id === id)?.[0];
    if (thread) return { review, thread };
  }
  return null;
}

/** Whether the review waits on `threadIds`: comments out, not ready, sent to one of them. */
const waitsOn = (review: ReviewMeta, threadIds: ReadonlySet<string>) => {
  const state = fixesState(review);
  return !!state && !state.ready && (review.sends ?? []).some((send) => send.readyAt === undefined && threadIds.has(send.threadId));
};

export function register(deps: ServeDeps) {
  const { bb, store, sync, changed } = deps;

  /** The reviews' ids as the reviewer sees them, `api:feat-x`, by key. */
  const idsOf = async (reviews: readonly ReviewMeta[]) => {
    const all = await store.listReviews();
    const facts = await placeFacts(bb, all);
    return new Map(reviews.map((review) => [review.targetKey, identityIn(facts, all, review).id]));
  };
  /** The calling thread and the threads above it: a subagent reports for the thread it works under. */
  const callerAndAbove = async (threadId: string | undefined): Promise<Set<string>> => {
    if (!threadId) return new Set();
    const listed = await bb.sdk.threads.experimental_listAncestors?.({ threadIds: [threadId] }).catch(() => null);
    return new Set([threadId, ...listed?.threads.find((thread) => thread.threadId === threadId)?.ancestorIds ?? []]);
  };
  /** Why a command can't run from here: a review's own agent, or a thread one of them started; one bb can't place fails closed. */
  const refused = (ownReview: string | undefined, threadId: string | undefined) => refusedFromAgents(deps, ownReview, threadId, NOT_FROM_AGENTS);

  /** Tell the review's pages, and once it's ready, the sync: it alerts you and starts Check fixes. */
  const settled = (key: string, ready: boolean) => {
    changed(key);
    bb.realtime.publish(`draft:${key}`, {});
    if (ready) void sync.evaluate(key).catch((error) => bb.log.warn(`Could not tell the reviewer ${key} is ready to re-review: ${String(error)}`));
  };

  async function report(args: string[], ctx: PluginCliContext, ownReview: string | undefined): Promise<PluginCliResult> {
    const positional: string[] = [];
    const values: { note?: string; commit?: string } = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: REPORT_USAGE };
      if (!arg.startsWith("--")) { positional.push(arg); continue; }
      const name = arg.slice(2);
      if (name !== "note" && name !== "commit") return usage(`report doesn't take ${arg}.`, REPORT_USAGE);
      if (values[name] !== undefined) return usage(`${arg} is given twice.`, REPORT_USAGE);
      if (i + 1 >= args.length) return usage(`${arg} needs a value.`, REPORT_USAGE);
      values[name] = args[++i];
    }
    // After Push: the commit to push, with no comment's id.
    if (!positional.length && values.commit !== undefined) {
      if (values.note !== undefined) return usage("--note goes with a comment's id.", REPORT_USAGE);
      if (!SHA.test(values.commit.trim())) return usage(`${values.commit} isn't a commit's SHA.`, REPORT_USAGE);
      const denied = await refused(ownReview, ctx.threadId);
      if (denied) return denied;
      return reportCommit(deps, values.commit.trim().toLowerCase(), await callerAndAbove(ctx.threadId));
    }
    const [id, outcome] = positional;
    if (positional.length !== 2 || !id) return usage("Give the comment's id and done or declined.", REPORT_USAGE);
    if (outcome !== "done" && outcome !== "declined") return usage(`${outcome} isn't done or declined.`, REPORT_USAGE);
    const note = values.note?.trim();
    if (note && note.length > NOTE_LIMIT) return usage(`--note is ${note.length.toLocaleString("en-US")} characters; keep it to ${NOTE_LIMIT.toLocaleString("en-US")}.`, REPORT_USAGE);
    if (values.commit !== undefined && !SHA.test(values.commit.trim())) return usage(`${values.commit} isn't a commit's SHA.`, REPORT_USAGE);
    const denied = await refused(ownReview, ctx.threadId);
    if (denied) return denied;

    const claim: Claim = { outcome, ...note ? { note } : {}, ...values.commit ? { commit: values.commit.trim().toLowerCase() } : {}, threadId: ctx.threadId ?? null, at: Date.now() };
    const result = await store.exclusive(async (tx) => {
      const found = await findComment(tx, id.trim());
      if (!found) return null;
      const key = found.review.targetKey;
      const wasReady = (found.review.sends ?? []).every((send) => send.readyAt !== undefined);
      if (found.at) await tx.trackComments(key, [{ at: found.at, claim }]);
      else {
        const threadSends = found.review.threadSends!;
        await tx.setLifecycle(key, { threadSends: { ...threadSends, [found.thread]: { ...threadSends[found.thread]!, claim } } });
      }
      return { review: found.review, wasReady, ...(await settleFixes(tx, key, "report"))! };
    });
    if (!result) return { exitCode: 1, stderr: await unknownId(id.trim(), ctx.threadId) };
    const { review, wasReady, ready, tally } = result;
    const key = review.targetKey;
    settled(key, ready);
    const named = (await idsOf([review])).get(key)!;
    // Once it's back with the reviewer, there's nothing left to run.
    const next = ready ? "That was the last one: the review goes back to the reviewer to re-review."
      : tally.reported < tally.sent && !wasReady ? `${reportedText(tally)}. Report the rest, then run \`bb review ready\`.` : `${reportedText(tally)}.`;
    return { exitCode: 0, stdout: `Reported ${id.trim()} ${outcome} on ${named}. ${next}` };
  }

  /** What a report on an unknown id says: the comments sent and still out, the calling thread's reviews first. */
  async function unknownId(id: string, threadId: string | undefined): Promise<string> {
    const mine = await callerAndAbove(threadId);
    const out = await store.exclusive(async (tx) => {
      const found: Array<{ review: ReviewMeta; ids: string[]; theirs: boolean }> = [];
      for (const review of await tx.listReviews()) {
        if (!review.sends?.length) continue;
        const draft = await tx.getDraft(review.targetKey);
        const ids = [...draft.comments.filter((c) => c.state === "sent" && c.id).map((c) => c.id!), ...Object.values(review.threadSends ?? {}).map((t) => t.id)];
        if (ids.length) found.push({ review, ids, theirs: (review.sends ?? []).some((send) => mine.has(send.threadId)) });
      }
      return found.sort((a, b) => Number(b.theirs) - Number(a.theirs));
    });
    if (!out.length) return `No sent comment has the id ${id}, and no review here has comments out. Check the id in the message that sent it.`;
    const ids = await idsOf(out.map(({ review }) => review));
    const shown = out.slice(0, 5).map(({ review, ids: sent }) => `${sent.slice(0, 10).join(", ")}${sent.length > 10 ? ` and ${sent.length - 10} more` : ""} on ${ids.get(review.targetKey)}`);
    return `No sent comment has the id ${id}. Comments sent: ${shown.join("; ")}${out.length > 5 ? `; and comments on ${out.length - 5} more reviews` : ""}.`;
  }

  async function ready(args: string[], ctx: PluginCliContext, ownReview: string | undefined): Promise<PluginCliResult> {
    if (args.includes("--help") || args.includes("-h")) return { exitCode: 0, stdout: READY_USAGE };
    const option = args.find((arg) => arg.startsWith("--"));
    if (option) return usage(`ready doesn't take ${option}.`, READY_USAGE);
    if (args.length > 1) return usage("Give one review, or none.", READY_USAGE);
    const denied = await refused(ownReview, ctx.threadId);
    if (denied) return denied;
    const all = await store.listReviews();
    let review: ReviewMeta | undefined;
    if (args[0]) {
      const given = args[0].trim();
      const target = parseTarget(given);
      const key = target.kind === "pr" && target.repo ? await prReviewKey(store, { repo: target.repo, number: target.number }) : given;
      // Or by its id, as the Send's first line names it.
      const sent = all.filter((r) => r.sends?.length);
      const ids = await idsOf(sent);
      review = all.find((r) => r.targetKey === key) ?? sent.find((r) => ids.get(r.targetKey)?.toLowerCase() === given.toLowerCase());
      if (!review) {
        const out = sent.filter((r) => fixesState(r));
        return { exitCode: 1, stderr: `No review ${given}. ${out.length ? `Reviews with comments out: ${out.map((r) => ids.get(r.targetKey)).join(", ")}.` : "No review has comments out."} Give its id as the message that sent you its comments names it, or its key.` };
      }
    } else {
      const mine = await callerAndAbove(ctx.threadId);
      const waiting = all.filter((r) => waitsOn(r, mine));
      if (waiting.length !== 1) {
        if (!waiting.length) return { exitCode: 1, stderr: "No review's comments are waiting on this thread. Pass the review: bb review ready <review>." };
        const ids = await idsOf(waiting);
        return { exitCode: 2, stderr: `Comments from ${waiting.length} reviews wait on this thread: ${waiting.map((r) => ids.get(r.targetKey)).join(", ")}. Pass one: bb review ready <review>.` };
      }
      review = waiting[0];
    }
    const key = review.targetKey;
    const by = await readyBy(review, ctx.threadId);
    const result = await store.exclusive((tx) => settleFixes(tx, key, "ready", by));
    const named = (await idsOf([review])).get(key)!;
    if (!result?.tally.sent) return { exitCode: 0, stdout: `No comments from ${named} are out with a thread, so there's nothing to finish.` };
    if (!result.ready) return { exitCode: 0, stdout: `${named} is already back with the reviewer to re-review: ${reportedText(result.tally)}.` };
    settled(key, true);
    return { exitCode: 0, stdout: `Sent ${named} back to the reviewer to re-review: ${reportedText(result.tally)}.` };
  }

  /**
   * Who runs `bb review ready` on `review`, as the review names them: its main thread, or a thread under one its Sends
   * wait on; another thread, by its title; or a shell outside any thread.
   */
  async function readyBy(review: ReviewMeta, threadId: string | undefined): Promise<NonNullable<SendEntry["readyBy"]>> {
    if (!threadId) return { from: "shell" };
    const mine = await callerAndAbove(threadId);
    if ((review.sends ?? []).some((send) => send.readyAt === undefined && mine.has(send.threadId))) return { from: "main" };
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const title = thread?.title ?? thread?.titleFallback;
    return { from: "thread", ...title ? { title } : {} };
  }

  /** Main threads a Send waits on that stopped: thread.active reads the reviews only for these. Filled again at start. */
  const stoppedThreads = new Set<string>();
  type Stop = NonNullable<SendEntry["stopped"]>["why"];
  /**
   * How the Sends waiting on `threadId` stand with it: `why` it stopped, idle or failed (not with a Send still queued for
   * it), or archived or deleted, which each says, "N of M reported · Check now"; or, null, it's working again.
   */
  async function stoppedOn(reviews: readonly ReviewMeta[], threadId: string, why: Stop | null) {
    const waiting = (send: SendEntry) => send.threadId === threadId && send.readyAt === undefined;
    // Idle with a Send still queued for it, it isn't idle on that Send, which it takes next.
    const next = (send: SendEntry, at: number): SendEntry["stopped"] => !why || why === "idle" && send.queued ? undefined : send.stopped?.why === why ? send.stopped : { at, why };
    const changes = (send: SendEntry) => waiting(send) && next(send, 0)?.why !== send.stopped?.why;
    const keys = reviews.filter((review) => review.sends?.some(changes)).map((review) => review.targetKey);
    if (why && reviews.some((review) => review.sends?.some(waiting))) stoppedThreads.add(threadId);
    if (!why) stoppedThreads.delete(threadId);
    if (!keys.length) return;
    const marked = await store.exclusive(async (tx) => {
      const at = Date.now();
      const marked: string[] = [];
      for (const key of keys) {
        const sends = (await tx.getReview(key))?.sends ?? [];
        if (!sends.some(changes)) continue;
        await tx.setLifecycle(key, { sends: sends.map((send) => changes(send) ? { ...send, stopped: next(send, at) } : send) });
        marked.push(key);
      }
      return marked;
    });
    for (const key of marked) changed(key);
  }

  // A main thread that stops may have changed the folder, and may have stopped short of reporting: its reviews check
  // their folders and say so. One read of the reviews, for both (1.4's folder check, taken over here).
  const stopped: PluginThreadEventHandler<"thread.idle"> = async ({ thread }) => {
    // The plugin's own agents are hidden, and never a main thread.
    if (thread.visibility === "hidden") return;
    const reviews = await store.listReviews();
    if (thread.environmentId) {
      for (const review of reviews) {
        if (review.kind !== "ref" || !review.feature || review.mainThread?.threadId !== thread.id || review.feature.folderGone) continue;
        await checkFeature(deps, review.targetKey).catch(() => {});
        bb.realtime.publish(`folder:${review.targetKey}`, { ts: Date.now() });
      }
    }
    await stoppedOn(reviews, thread.id, "idle");
  };
  /** Archived or deleted, a main thread won't report the rest; back from the archive, it's idle until it works. */
  const ended = (why: Stop) => async ({ thread }: { thread: { id: string; visibility?: string } }) => {
    if (thread.visibility === "hidden") return;
    await stoppedOn(await store.listReviews(), thread.id, why);
  };
  // Working again, as when its subagents finish, a main thread isn't stopped.
  const resumed: PluginThreadEventHandler<"thread.active"> = async ({ thread }) => {
    if (stoppedThreads.has(thread.id)) await stoppedOn(await store.listReviews(), thread.id, null);
  };

  /**
   * Whether `threadId` took Send `send`'s message: a request to it since, with the line every Send ends with and each of
   * its comments' ids. Null when bb's events can't say, as when a full page of them doesn't reach back to the Send.
   */
  async function tookSend(threadId: string, send: SendEntry): Promise<boolean | null> {
    type Requested = { createdAt: number; data: { input?: Array<{ text?: string }> } };
    const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: String(EVENT_PAGE) }).catch(() => null) as unknown as Requested[] | null;
    if (!events) return null;
    const carries = (event: Requested) => {
      const text = (event.data.input ?? []).map((part) => part.text ?? "").join("\n");
      return text.includes("bb review report") && send.ids.every((id) => text.includes(`${id} · `));
    };
    if (events.some((event) => event.createdAt >= send.at - CLOCK_SLACK && carries(event))) return true;
    return events.length >= EVENT_PAGE && (events.at(-1)?.createdAt ?? 0) > send.at - CLOCK_SLACK ? null : false;
  }

  /**
   * At start, as the review-state service starts: what happened to the main threads while the plugin was down. A queued
   * Send whose message has left the queue was taken, or deleted from it; a Send waiting on a thread that's idle, failed,
   * archived, deleted or gone stops waiting for it, and one on a thread that's working again waits on it.
   */
  async function reconcile() {
    const reviews = (await store.listReviews()).filter((review) => review.sends?.some((send) => send.readyAt === undefined));
    const threads = new Set(reviews.flatMap((review) => review.sends!.filter((send) => send.readyAt === undefined).map((send) => send.threadId)));
    for (const threadId of threads) {
      let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>> | null;
      try {
        thread = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        if (!isMissingThread(error)) continue;
        thread = null;
      }
      const gone = !thread || !!thread.archivedAt || !!thread.deletedAt;
      const queued = reviews.flatMap((review) => review.sends!.filter((send) => send.threadId === threadId && send.queued));
      const listed = thread && !gone && queued.length ? await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => null) : null;
      // A queued Send whose message left the queue: the thread took it, if it's in the thread; else it was deleted from
      // the queue, as message.cancelled says live, and its comments are open again. One bb can't say of stays queued.
      for (const send of listed ? queued.filter((send) => !listed.some((entry) => entry.id === send.queued)) : []) {
        const took = await tookSend(threadId, send);
        if (took !== null) await settleQueued(deps, { id: send.queued!, threadId }, took);
      }
      const idle = !!thread && ["idle", "error"].includes(thread.status) && thread.queuedMessageCount === 0;
      await stoppedOn(await store.listReviews(), threadId, !thread || thread.deletedAt ? "deleted" : thread.archivedAt ? "archived" : idle ? "idle" : null);
    }
  }

  const handlers = {
    // Your click, Check fixes or Check now: the review agent checks each comment out against its Send's diff.
    async checkFixes({ targetKey }) {
      const read = await store.exclusive(async (tx) => {
        const review = await tx.getReview(targetKey);
        return review ? { review, prompt: reReviewCheckPrompt((await tx.getPreferences()).preferences), settled: await settleFixes(tx, targetKey) } : null;
      });
      if (!read) return { ok: false, error: "This review no longer exists." };
      if (!read.settled?.tally.sent) return { ok: false, error: "No comments are out with the main thread to check." };
      if (!read.prompt) return { ok: false, error: "The re-review check is off. Turn it on in Review settings." };
      // As Check again does: not into your own conversation with it.
      if (await isAssistantAnswering(bb, store, targetKey)) return { ok: false, error: "The assistant is still answering. Try again when it finishes." };
      if (!await startVerification(bb, store, targetKey, "the reviewer asked to check the fixes of the comments they sent", "ask", { fixes: true })) return { ok: false, error: "The review agent couldn't start. Open Ask agent to choose its agent." };
      changed(targetKey);
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;

  const events: EventListeners = {
    "thread.idle": [stopped],
    "thread.active": [resumed],
    "thread.failed": [({ thread }) => stopped({ thread, lastAssistantText: null })],
    "thread.archived": [ended("archived")],
    "thread.unarchived": [ended("idle")],
    "thread.deleted": [ended("deleted")],
  };
  const commands = { report, ready } satisfies Subcommands;
  return { handlers, events, commands, reconcile };
}
