import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { linesOf, postedBody, sameLocation, type CommentLocation, type DraftComment } from "./draft";
import { runGh } from "./gh";
import { patchRows, splitPatchByFile } from "./patch";
import { spawnExecution } from "./preferences";
import { assistantReview } from "./draft-comments";
import { isMissingThread } from "./thread-errors";
import { requireReviewRevision } from "./review-revision";
import type { AsyncStore } from "./store-queue";
import { reviewIdentity, threadLine, type ReviewPlace } from "../lib/review-identity";
import { placeFacts, reviewPlaces } from "./review-places";

/** A review with where its code is (src/review-places.ts), as its messages name it. */
type Placed = ReviewMeta & { place?: ReviewPlace | null };

/** `review` with its place among your reviews; read outside the store's lock, as it asks bb. */
async function placed(bb: BbPluginApi, store: AsyncStore, review: ReviewMeta): Promise<Placed> {
  const all = await store.listReviews();
  return { ...review, place: reviewPlaces(await placeFacts(bb, all), all).get(review.targetKey) ?? null };
}

const MAX_CODE_LINES = 40;

/** A comment as the fix thread reads it; a range comment also has its first line. */
type FixComment = Pick<DraftComment, "file" | "line" | "side" | "severity" | "body" | "introduced"> & { startLine?: number; startSide?: "LEFT" | "RIGHT" };

/** Whether you may hand this review's comments to a coding thread: a local review, or your own PR. */
async function isOwnChange(review: ReviewMeta): Promise<boolean> {
  if (review.kind === "ref") return true;
  if (typeof review.ownPr === "boolean") return review.ownPr;
  if (!review.author) return false;
  // The sync knows once it has read the PR; before that, ask gh who you are.
  const login = await runGh(["api", "user", "--jq", ".login"]).then((r) => r.code === 0 ? r.stdout.trim() : "", () => "");
  return !!login && login.toLowerCase() === review.author.toLowerCase();
}

/** The diff lines a comment is on, from its first line to its last, with their +/-/space prefixes. */
function codeAt(patch: string, comment: FixComment): string {
  const file = splitPatchByFile(patch).find((f) => f.path === comment.file);
  if (!file) return "";
  const rows = patchRows(file.text).flatMap((row) => "oldLine" in row ? [row] : []);
  const find = (side: "LEFT" | "RIGHT", line: number) => rows.findIndex((row) => side === "LEFT" ? row.kind !== "+" && row.oldLine === line : row.kind !== "-" && row.newLine === line);
  const end = find(comment.side, comment.line);
  const start = comment.startLine === undefined ? end : find(comment.startSide ?? comment.side, comment.startLine);
  if (start < 0 || end < 0) return "";
  const lines = rows.slice(Math.min(start, end), Math.max(start, end) + 1).map((row) => row.text);
  return [...lines.slice(0, MAX_CODE_LINES), ...(lines.length > MAX_CODE_LINES ? ["…"] : [])].join("\n");
}

/** A fenced block that no backtick run in `code` closes early. */
function fenced(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

/** A PR's title, the author's words, on one line and quoted, so it reads as data: "Fix login race". */
const quoted = (title: string) => JSON.stringify(title.replace(/\s+/g, " ").trim());

/**
 * Which review is talking, first, as the thread may hear from several: 'Review api#4512 "Fix login race", from Code
 * Review Workspace:', by the PR's title, which agents keep, not your name for it.
 */
function header(review: Placed): string {
  const machine = review.kind === "ref" && review.place?.machine;
  return `Review ${reviewIdentity(review).id}${review.title ? ` ${quoted(review.title)}` : ""}${machine ? ` on ${machine}${review.cwd ? ` in \`${review.cwd}\`` : ""}` : ""}, from Code Review Workspace:`;
}

/** The review's header, then where the fix thread works: the PR's branch, or a local review's diff and its head. */
function where(review: Placed): string {
  if (review.kind === "pr") return [header(review),
    `Fix these comments from my review of ${review.repo} PR #${review.number}${review.title ? `, ${quoted(review.title)}` : ""}.`,
    `Check out the branch \`${review.head}\`, or stay on it if it's already checked out.${review.headSha ? ` I reviewed commit \`${review.headSha.slice(0, 7)}\`.` : ""}`,
  ].join("\n");
  const head = review.gitRef?.split(/\.{2,3}/)[1];
  return [
    header(review),
    `Fix these comments from my review of \`git diff ${review.gitRef}\`${review.cwd ? ` in \`${review.cwd}\`` : ""}.`,
    head && head !== "HEAD" ? `Check out \`${head}\`, or stay on it if it's already checked out.` : "Stay on the branch checked out there.",
  ].join("\n");
}

/**
 * The fix thread's first message: where to work, each comment with its lines' code, and what not to do. `preExisting`
 * (Settings' Keep pre-existing problems apart): each comment reads as it would post, a problem the PR didn't introduce
 * marked so. `guard` adds the GitHub limit, for a new thread; the thread that made the change keeps its own rules.
 */
export function fixMessage(review: Placed, comments: readonly FixComment[], patch: string, stale: readonly CommentLocation[], preExisting = false, guard = true): string {
  const items = comments.map((comment) => {
    const cross = comment.startLine !== undefined && (comment.startSide ?? comment.side) !== comment.side;
    const at = `\`${comment.file}:${linesOf(comment)}\`${cross ? ` (old line ${comment.startLine} to new line ${comment.line})` : comment.side === "LEFT" ? " (old line)" : ""}`;
    if (stale.some((s) => sameLocation(s, comment))) return `${at}, written against an older diff, so the line may have moved:\n${postedBody(comment, preExisting)}`;
    const code = codeAt(patch, comment);
    return code ? `${at}\n${fenced(code, "diff")}\n${postedBody(comment, preExisting)}` : `${at}\n${postedBody(comment, preExisting)}`;
  });
  return [where(review), ...items, ...(guard ? ["Don't push, open or update a PR, or change anything on GitHub unless I ask in this thread."] : [])].join("\n\n");
}

/**
 * Start a visible thread in the review's project that fixes the draft comments at `picked`, on the
 * review agent's execution or else the project's. Only for your own PR or a local review; the draft
 * stays as it is.
 */
export async function startFixThread(bb: BbPluginApi, store: AsyncStore, targetKey: string, picked: readonly CommentLocation[]): Promise<{ threadId: string; title: string }> {
  const review = await store.getReview(targetKey);
  if (!review) throw new Error("This review no longer exists.");
  if (!(await isOwnChange(review))) throw new Error("Fix in a new thread is only for your own PR or a local review.");
  if (!review.projectId) throw new Error("This review has no associated project; re-run `bb review` inside a project.");
  // What the message says, read in one turn.
  const { comments, agent, patch, stale, preExistingFindings, guideTitle } = await store.exclusive(async (tx) => {
    const { preferences } = await tx.getPreferences();
    return {
      comments: (await tx.getDraft(targetKey)).comments.filter((comment) => picked.some((at) => sameLocation(at, comment))),
      agent: preferences.assistantAgent, patch: await tx.patch(targetKey), stale: await tx.staleDraftComments(targetKey),
      preExistingFindings: preferences.knobs.preExistingFindings, guideTitle: (await tx.getGuide(targetKey))?.title,
    };
  });
  if (!comments.length) throw new Error("Those comments are no longer in the draft.");
  if (!agent && !(await bb.sdk.projects.defaultExecutionOptions({ projectId: review.projectId }).catch(() => null))) throw new Error("bb has no default agent for the review's project. Choose an agent for the Review agent in Review settings.");
  const shown = await placed(bb, store, review);
  // Named as you named the review, its id first, so its notifications say which review: "Fixes for api#4512 · Fix
  // login race", on one line and cut to 80 characters. Its message names the PR by its title.
  const title = `Fixes for ${threadLine(reviewIdentity(shown, guideTitle))}`;
  try {
    const thread = await bb.sdk.threads.spawn({
      projectId: review.projectId, environment: { type: "project-default" },
      prompt: fixMessage(shown, comments, patch, stale, preExistingFindings),
      title,
      ...spawnExecution(agent),
    });
    return { threadId: thread.id, title };
  } catch (error) {
    throw new Error(`Couldn’t start the thread: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What Send to thread asks for after the comments: a reply per comment, and no push. */
const REPORT_BACK = "Reply in this thread with what you changed for each comment, as `file:line — done` or `not done (why)`.";

/** The thread `bb review` ran in for the review, as Finish review offers it. */
export interface SourceThread { threadId: string; title: string | null; state: "open" | "archived" | "gone" }

/** The review's source thread: open, archived, or gone. Null without one, and for one of this plugin's own agents. */
export async function sourceThread(bb: BbPluginApi, store: AsyncStore, targetKey: string): Promise<SourceThread | null> {
  const threadId = await store.exclusive(async (tx) => {
    const threadId = (await tx.getReview(targetKey))?.sourceThreadId;
    return !threadId || await assistantReview(tx, threadId) || await tx.generationOf(threadId) ? null : threadId;
  });
  if (!threadId) return null;
  const thread = await bb.sdk.threads.get({ threadId }).catch((error) => {
    if (isMissingThread(error)) return null;
    throw error;
  });
  if (!thread || thread.deletedAt) return { threadId, title: null, state: "gone" };
  return { threadId, title: thread.title ?? null, state: thread.archivedAt ? "archived" : "open" };
}

/** What you add to what Send to thread sends: your own message, and whether the draft's summary goes too. */
export interface SendExtras { message?: string; includeSummary?: boolean }

/** Your message and the draft's summary, trimmed, as Send to thread adds them; empty ones are left out. */
function extras(draftBody: string, { message, includeSummary }: SendExtras): { message: string; summary: string } {
  return { message: message?.trim() ?? "", summary: includeSummary ? draftBody.trim() : "" };
}

/**
 * Send the draft comments at `picked` to the review's source thread, the one that made the change, after its current
 * turn if it's busy, and record them as sent. Your message leads, and the summary follows the comments. Only for your
 * own PR or a local review; the draft stays as it is.
 */
export async function sendToSourceThread(bb: BbPluginApi, store: AsyncStore, targetKey: string, picked: readonly CommentLocation[], add: SendExtras = {}): Promise<{ ok: true; delivery: "sent" | "queued"; title: string | null }> {
  const { review, source } = await openSourceThread(bb, store, targetKey);
  const shown = await placed(bb, store, review);
  // What the message says, read in one turn.
  const { comments, text } = await store.exclusive(async (tx) => {
    const draft = await tx.getDraft(targetKey);
    const comments = draft.comments.filter((comment) => picked.some((at) => sameLocation(at, comment)));
    if (!comments.length) return { comments, text: "" };
    const { message, summary } = extras(draft.body, add);
    const fix = fixMessage(shown, comments, await tx.patch(targetKey), await tx.staleDraftComments(targetKey), (await tx.getPreferences()).preferences.knobs.preExistingFindings, false);
    return { comments, text: [message, fix, summary, REPORT_BACK].filter(Boolean).join("\n\n") };
  });
  if (!comments.length) throw new Error("Those comments are no longer in the draft.");
  const delivery = await sendText(bb, source.threadId, text);
  const at = Date.now();
  // Comments sent to this thread before stay marked; one sent again is marked now. Each keeps its words, so an edit unmarks it.
  const earlier = review.sent?.threadId === source.threadId ? review.sent.comments.filter((comment) => !comments.some((sent) => sameLocation(sent, comment))) : [];
  // The comments supersede an approval sent before them.
  await store.setLifecycle(targetKey, { sent: { at, threadId: source.threadId, title: source.title, comments: [...earlier, ...comments.map(({ file, line, side, body }) => ({ file, line, side, body, at }))] }, approvalSent: null });
  return { ok: true, delivery, title: source.title };
}

/** An approval says this, then your message and the draft's summary if you add them; what it means is up to the thread that receives it. */
const APPROVED = "Approved";

/**
 * Tell the review's source thread you approve the change as is, while the draft has no comments, after its current
 * turn if it's busy, and record it against the diff you approved, `revision`, the one your page shows, which it tells
 * once. Only for your own PR or a local review.
 */
export async function sendApprovalToSourceThread(bb: BbPluginApi, store: AsyncStore, targetKey: string, revision: string | undefined, add: SendExtras = {}): Promise<{ ok: true; delivery: "sent" | "queued"; title: string | null }> {
  const { review, source } = await openSourceThread(bb, store, targetKey);
  const { count, message, summary } = await store.exclusive(async (tx) => {
    // Only the diff you saw, as submit checks it: not one that changed since, or a guide still rebuilding.
    await requireReviewRevision(tx, targetKey, revision);
    const draft = await tx.getDraft(targetKey);
    return { count: draft.comments.length, ...extras(draft.body, add) };
  });
  if (count) throw new Error("Your draft has comments. Send them instead.");
  if (review.approvalSent?.threadId === source.threadId && review.approvalSent.revision === revision) throw new Error(`You already told ${source.title ?? "the thread"} you approve this diff.`);
  const delivery = await sendText(bb, source.threadId, [`${header(await placed(bb, store, review))}\n${APPROVED}`, message, summary].filter(Boolean).join("\n\n"));
  // The check passed, so `revision` is set.
  await store.setLifecycle(targetKey, { approvalSent: { at: Date.now(), threadId: source.threadId, title: source.title, revision: revision! } });
  return { ok: true, delivery, title: source.title };
}

/** The review and its source thread, while you may send to it: your own PR or a local review, and the thread open. */
async function openSourceThread(bb: BbPluginApi, store: AsyncStore, targetKey: string): Promise<{ review: ReviewMeta; source: SourceThread }> {
  const review = await store.getReview(targetKey);
  if (!review) throw new Error("This review no longer exists.");
  if (!(await isOwnChange(review))) throw new Error("Send to thread is only for your own PR or a local review.");
  const source = await sourceThread(bb, store, targetKey);
  if (!source) throw new Error("This review has no thread to send to. Run `bb review` in the thread that made the change.");
  if (source.state === "gone") throw new Error("The thread that started this review was deleted.");
  if (source.state === "archived") throw new Error(`${source.title ?? "The thread that started this review"} is archived.`);
  return { review, source };
}

/** Send `text` to the thread after its current turn, if it's busy. */
async function sendText(bb: BbPluginApi, threadId: string, text: string): Promise<"sent" | "queued"> {
  try {
    const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    return sent?.delivery === "queued" ? "queued" : "sent";
  } catch (error) {
    throw new Error(`Couldn’t send to the thread: ${error instanceof Error ? error.message : String(error)}`);
  }
}
