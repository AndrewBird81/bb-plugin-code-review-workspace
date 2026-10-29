import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta } from "./store";
import { linesOf, postedBody, sameLocation, type CommentLocation, type DraftComment } from "./draft";
import { runGh } from "./gh";
import { patchRows, splitPatchByFile } from "./patch";
import { spawnExecution } from "./preferences";
import type { AsyncStore } from "./store-queue";
import { untrusted } from "./untrusted";
import { reviewIdentity, threadLine, type ReviewPlace } from "../lib/review-identity";
import { placeFacts, reviewPlaces } from "./review-places";

/** A review with where its code is (src/review-places.ts), as its messages name it. */
export type Placed = ReviewMeta & { place?: ReviewPlace | null };

/** `review` with its place among your reviews; read outside the store's lock, as it asks bb. */
export async function placed(bb: BbPluginApi, store: AsyncStore, review: ReviewMeta): Promise<Placed> {
  const all = await store.listReviews();
  return { ...review, place: reviewPlaces(await placeFacts(bb, all), all).get(review.targetKey) ?? null };
}

const MAX_CODE_LINES = 40;

/** A comment as the fix thread reads it; a range comment also has its first line. */
export type FixComment = Pick<DraftComment, "file" | "line" | "side" | "severity" | "body" | "introduced"> & { startLine?: number; startSide?: "LEFT" | "RIGHT" };

/** Whether the change is yours: a local review, a folder's review that became its PR, or your own PR. */
export async function isOwnChange(review: ReviewMeta): Promise<boolean> {
  if (review.kind === "ref" || review.feature) return true;
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
export function fenced(code: string, lang: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

/** A PR's title, the author's words, on one line and quoted, so it reads as data: "Fix login race". */
const quoted = (title: string) => JSON.stringify(title.replace(/\s+/g, " ").trim());

/**
 * Which review is talking, first, as the thread may hear from several: 'Review api#4512 "Fix login race", from Code
 * Review Workspace:', by the PR's title, which agents keep, not your name for it. A local review's adds its machine
 * and folder: a folder's review its own, a checkout's the bb server's.
 */
export function header(review: Placed): string {
  const machine = review.kind === "ref" && review.place?.machine;
  const path = review.place?.path ?? review.cwd;
  return `Review ${reviewIdentity(review).id}${review.title ? ` ${quoted(review.title)}` : ""}${machine ? ` on ${machine}${path ? ` in \`${path}\`` : ""}` : ""}, from Code Review Workspace:`;
}

/**
 * The review's header, then where the fix thread works: the PR's branch, a folder's branch with its uncommitted and new
 * files, or a local review's diff and its head.
 */
export function where(review: Placed, branch = branchLine(review)): string {
  const what = review.kind === "pr" ? `${review.repo} PR #${review.number}${review.title ? `, ${quoted(review.title)}` : ""}`
    : review.feature ? `the changes on \`${review.feature.branch}\` against \`${review.feature.baseRef}\`, uncommitted and new files included`
    : `\`git diff ${review.gitRef}\`${review.cwd ? ` in \`${review.cwd}\`` : ""}`;
  return [header(review), `Fix these comments from my review of ${what}.`, branch].join("\n");
}

/** Which branch to work on: the PR's, and the commit reviewed; a folder's; or a local review's diff's head. */
export function branchLine(review: Placed): string {
  if (review.kind === "pr") return `Check out the branch \`${review.head}\`, or stay on it if it's already checked out.${review.headSha ? ` I reviewed commit \`${review.headSha.slice(0, 7)}\`.` : ""}`;
  if (review.feature) return `Stay on \`${review.feature.branch}\`.`;
  const head = review.gitRef?.split(/\.{2,3}/)[1];
  return head && head !== "HEAD" ? `Check out \`${head}\`, or stay on it if it's already checked out.` : "Stay on the branch checked out there.";
}

/**
 * One comment as a fix thread reads it: where it is, its lines' code, and its words as they would post (`preExisting`,
 * Settings' Keep pre-existing problems apart, marks a problem the PR didn't introduce). With `id`, it leads with the id
 * the thread reports on; with `author`, someone else's code is fenced as theirs, to read as data.
 */
export function commentText(comment: FixComment, patch: string, stale: readonly CommentLocation[], preExisting = false, { id, author }: { id?: string; author?: string | null } = {}): string {
  const cross = comment.startLine !== undefined && (comment.startSide ?? comment.side) !== comment.side;
  const at = `${id ? `${id} · ` : ""}\`${comment.file}:${linesOf(comment)}\`${cross ? ` (old line ${comment.startLine} to new line ${comment.line})` : comment.side === "LEFT" ? " (old line)" : ""}`;
  if (stale.some((s) => sameLocation(s, comment))) return `${at}, written against an older diff, so the line may have moved:\n${postedBody(comment, preExisting)}`;
  const code = codeAt(patch, comment);
  if (!code) return `${at}\n${postedBody(comment, preExisting)}`;
  const block = fenced(code, "diff");
  return `${at}\n${author !== undefined ? untrusted(`${author ? `@${author}` : "the author"}'s code`, block) : block}\n${postedBody(comment, preExisting)}`;
}

/** What a fresh thread is told about GitHub; one let push when done, all but the push. */
export const GUARD = "Don't push, open or update a PR, or change anything on GitHub unless I ask in this thread.";
export const GUARD_BUT_PUSH = "Don't open or update a PR, or change anything else on GitHub, unless I ask in this thread.";

/**
 * A new fix thread's first message: where to work, each comment with its lines' code, and what not to do. `preExisting`
 * (Settings' Keep pre-existing problems apart): each comment reads as it would post, a problem the PR didn't introduce
 * marked so.
 */
export function fixMessage(review: Placed, comments: readonly FixComment[], patch: string, stale: readonly CommentLocation[], preExisting = false): string {
  return [where(review), ...comments.map((comment) => commentText(comment, patch, stale, preExisting)), GUARD].join("\n\n");
}

/** What a thread the plugin starts to fix comments runs on: the review agent's execution, or else the project's defaults. */
export async function fixerExecution(bb: BbPluginApi, store: AsyncStore, projectId: string) {
  const agent = (await store.getPreferences()).preferences.assistantAgent;
  if (!agent && !(await bb.sdk.projects.defaultExecutionOptions({ projectId }).catch(() => null))) throw new Error("bb has no default agent for the review's project. Choose an agent for the Review agent in Review settings.");
  return spawnExecution(agent);
}

/** A fix thread's title, as you named the review, its id first, so its notifications say which review: "Fixes for api#4512 · Fix login race", on one line and cut to 80 characters. */
export const fixerTitle = (review: Placed, guideTitle?: string | null) => `Fixes for ${threadLine(reviewIdentity(review, guideTitle))}`;

/** Why a Send or a fix thread for someone else's PR asks first: it's theirs, and your review on GitHub isn't touched. */
export const theirPr = (review: ReviewMeta) => `This is ${review.author ? `@${review.author}’s` : "someone else’s"} PR, not yours. Your review on GitHub stays as it is.`;

/**
 * Start a visible thread in the review's project that fixes the draft comments at `picked`, on the
 * review agent's execution or else the project's. On someone else's PR it warns first, and `force` starts it. The draft
 * stays as it is.
 */
export async function startFixThread(bb: BbPluginApi, store: AsyncStore, targetKey: string, picked: readonly CommentLocation[], force = false): Promise<{ ok: true; threadId: string; title: string } | { ok: false; warning: string; offers: ["anyway"] }> {
  const review = await store.getReview(targetKey);
  if (!review) throw new Error("This review no longer exists.");
  if (!force && !(await isOwnChange(review))) return { ok: false, warning: `${theirPr(review)} Start a thread to fix it anyway?`, offers: ["anyway"] };
  if (!review.projectId) throw new Error("This review has no associated project; re-run `bb review` inside a project.");
  // What the message says, read in one turn.
  const { comments, patch, stale, preExistingFindings, guideTitle } = await store.exclusive(async (tx) => {
    const { preferences } = await tx.getPreferences();
    return {
      comments: (await tx.getDraft(targetKey)).comments.filter((comment) => picked.some((at) => sameLocation(at, comment))),
      patch: await tx.patch(targetKey), stale: await tx.staleDraftComments(targetKey),
      preExistingFindings: preferences.knobs.preExistingFindings, guideTitle: (await tx.getGuide(targetKey))?.title,
    };
  });
  if (!comments.length) throw new Error("Those comments are no longer in the draft.");
  const execution = await fixerExecution(bb, store, review.projectId);
  const shown = await placed(bb, store, review);
  // Its message names the PR by its title.
  const title = fixerTitle(shown, guideTitle);
  try {
    const thread = await bb.sdk.threads.spawn({
      projectId: review.projectId, environment: { type: "project-default" },
      prompt: fixMessage(shown, comments, patch, stale, preExistingFindings),
      title,
      ...execution,
    });
    return { ok: true, threadId: thread.id, title };
  } catch (error) {
    throw new Error(`Couldn’t start the thread: ${error instanceof Error ? error.message : String(error)}`);
  }
}
