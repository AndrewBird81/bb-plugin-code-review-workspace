import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewMeta, Store } from "./store";
import { linesOf, sameLocation, type CommentLocation, type DraftComment } from "./draft";
import { runGh } from "./gh";
import { patchRows, splitPatchByFile } from "./patch";
import { spawnExecution } from "./preferences";

const MAX_CODE_LINES = 40;

/** A comment as the fix thread reads it; a range comment also has its first line. */
type FixComment = Pick<DraftComment, "file" | "line" | "side" | "body"> & { startLine?: number; startSide?: "LEFT" | "RIGHT" };

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

/** Where the fix thread works: the PR's branch, or a local review's diff and its head. */
function where(review: ReviewMeta): string {
  if (review.kind === "pr") return [
    `Fix these comments from my review of ${review.repo} PR #${review.number}${review.title ? ` (${review.title})` : ""}.`,
    `Check out the branch \`${review.head}\`, or stay on it if it's already checked out.${review.headSha ? ` I reviewed commit \`${review.headSha.slice(0, 7)}\`.` : ""}`,
  ].join("\n");
  const head = review.gitRef?.split(/\.{2,3}/)[1];
  return [
    `Fix these comments from my review of \`git diff ${review.gitRef}\`${review.cwd ? ` in \`${review.cwd}\`` : ""}.`,
    head && head !== "HEAD" ? `Check out \`${head}\`, or stay on it if it's already checked out.` : "Stay on the branch checked out there.",
  ].join("\n");
}

/** The fix thread's first message: where to work, each comment with its lines' code, and what not to do. */
export function fixMessage(review: ReviewMeta, comments: readonly FixComment[], patch: string, stale: readonly CommentLocation[]): string {
  const items = comments.map((comment) => {
    const cross = comment.startLine !== undefined && (comment.startSide ?? comment.side) !== comment.side;
    const at = `\`${comment.file}:${linesOf(comment)}\`${cross ? ` (old line ${comment.startLine} to new line ${comment.line})` : comment.side === "LEFT" ? " (old line)" : ""}`;
    if (stale.some((s) => sameLocation(s, comment))) return `${at}, written against an older diff, so the line may have moved:\n${comment.body}`;
    const code = codeAt(patch, comment);
    return code ? `${at}\n${fenced(code, "diff")}\n${comment.body}` : `${at}\n${comment.body}`;
  });
  return [where(review), ...items, "Don't push, open or update a PR, or change anything on GitHub unless I ask in this thread."].join("\n\n");
}

/**
 * Start a visible thread in the review's project that fixes the draft comments at `picked`, on the
 * review agent's execution or else the project's. Only for your own PR or a local review; the draft
 * stays as it is.
 */
export async function startFixThread(bb: BbPluginApi, store: Store, targetKey: string, picked: readonly CommentLocation[]): Promise<{ threadId: string; title: string }> {
  const review = store.getReview(targetKey);
  if (!review) throw new Error("This review no longer exists.");
  if (!(await isOwnChange(review))) throw new Error("Fix in a new thread is only for your own PR or a local review.");
  if (!review.projectId) throw new Error("This review has no associated project; re-run `bb review` inside a project.");
  const comments = store.getDraft(targetKey).comments.filter((comment) => picked.some((at) => sameLocation(at, comment)));
  if (!comments.length) throw new Error("Those comments are no longer in the draft.");
  const agent = store.getPreferences().preferences.assistantAgent;
  if (!agent && !(await bb.sdk.projects.defaultExecutionOptions({ projectId: review.projectId }).catch(() => null))) throw new Error("bb has no default agent for the review's project. Choose a Review assistant agent in Review settings.");
  const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
  const title = `Fix review comments: ${review.kind === "pr" ? `#${review.number} ${review.title ?? ""}`.trim() : review.gitRef}`;
  try {
    const thread = await bb.sdk.threads.spawn({
      projectId: review.projectId, environment: { type: "project-default" },
      prompt: fixMessage(review, comments, patch, store.staleDraftComments(targetKey)),
      title,
      ...spawnExecution(agent),
    });
    return { threadId: thread.id, title };
  } catch (error) {
    throw new Error(`Couldn’t start the thread: ${error instanceof Error ? error.message : String(error)}`);
  }
}
