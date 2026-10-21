import { NOT_OWN_REVIEW } from "./review-command";
import { parseTarget, prReviewKey } from "./targets";
import { addComment, deleteComment, describeComments, editComment, listComments, type DraftResult } from "./draft-comments";
import { SEVERITIES, type Severity } from "./draft";
import type { AsyncStore } from "./store-queue";

export const COMMENT_USAGE = [
  "usage: bb review comment list   <review> [--json]",
  "       bb review comment add    <review> <file>:<line> --code <text> --body <text> [--severity <severity>] [--evidence <text>] [--pre-existing] [--side LEFT|RIGHT]",
  "       bb review comment edit   <review> <file>:<line> --body <text> [--code <text>] [--severity <severity>] [--evidence <text>] [--pre-existing] [--side LEFT|RIGHT]",
  "       bb review comment delete <review> <file>:<line> [--side LEFT|RIGHT]",
  "",
  "Changes a review's local draft in this bb. Nothing is posted to GitHub; the reviewer submits the draft from Code Review Workspace.",
  "  <review>       a GitHub PR URL, or a review key (pr-…, ref-…)",
  "  <file>:<line>  the line's number in the new file, or with --side LEFT, in the old file;",
  "                 <file>:<start>-<end> for lines in one hunk, where edit sets the comment's first line",
  "  --code         the line's text, without the diff's +, -, or space, or a range's lines, one per line;",
  "                 add, and edit of a range, refuse lines that don't match",
  "  --body         the comment, in GitHub Markdown, up to 65,000 characters; quote it for your shell",
  "  --severity     blocking, should-fix, question, nit, or none; a label the body starts with, such as",
  "                 **Blocking:**, sets it instead. Without either, edit keeps the comment's",
  "  --evidence     how you confirmed it: what you read or ran, with file:line (up to 600 characters). The",
  "                 reviewer sees it under the comment; it's never posted. Without it, edit keeps the comment's",
  "  --pre-existing the problem is in code this PR didn't change. Without it, edit keeps the comment's mark",
].join("\n");

const ACTIONS = {
  list: { location: false, options: ["json"] },
  add: { location: true, options: ["side", "code", "body", "severity", "evidence", "pre-existing"] },
  edit: { location: true, options: ["side", "code", "body", "severity", "evidence", "pre-existing"] },
  delete: { location: true, options: ["side"] },
} as const;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };
/** GitHub takes up to 65,536 characters in a comment or review body. */
export const BODY_LIMIT = 65_000;
const usage = (problem: string): CliResult => ({ exitCode: 2, stderr: `${problem}\n${COMMENT_USAGE}` });

/** Why the draft can't change yet while the review's first guide is written, where unchangeable speaks of a rebuild. */
export async function firstGuideRefusal(store: AsyncStore, targetKey: string): Promise<CliResult | null> {
  return store.exclusive(async (tx) => {
    if ((await tx.getReview(targetKey))?.status !== "generating" || await tx.getGuide(targetKey)) return null;
    const list = (await tx.getPreferences()).preferences.knobs.reviewCommandInThreads;
    return { exitCode: 1, stderr: `The guide is still being written, and the draft waits for it. ${list ? "Run `bb review list` until it says guide ready" : "Wait until it's ready"}, then try again.` };
  });
}

/** `bb review comment …`: list and change a review's draft comments. `changed` runs after a successful change.
 * `ownReview`, set when a review's own agent runs it, refuses every other review. */
export async function runCommentCommand(store: AsyncStore, argv: string[], changed: (targetKey: string) => void, ownReview?: string): Promise<CliResult> {
  return store.exclusive(async (tx) => {
    const [action, ...rest] = argv;
    if (action === "--help" || action === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
    if (!action || !(action in ACTIONS)) return usage(action ? `Unknown action: ${action}` : "Choose list, add, edit, or delete.");
    const spec = ACTIONS[action as keyof typeof ACTIONS];
    const positional: string[] = [];
    const values: { side?: string; code?: string; body?: string; severity?: string; evidence?: string; json?: string; "pre-existing"?: string } = {};
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
      if (!arg.startsWith("--")) { positional.push(arg); continue; }
      const name = arg.slice(2) as keyof typeof values;
      if (!(spec.options as readonly string[]).includes(name)) return usage(`${action} doesn't take ${arg}.`);
      if (values[name] !== undefined) return usage(`${arg} is given twice.`);
      if (name === "json" || name === "pre-existing") { values[name] = ""; continue; }
      if (i + 1 >= rest.length) return usage(`${arg} needs a value.`);
      values[name] = rest[++i];
    }
    if (positional.length !== (spec.location ? 2 : 1)) return usage(spec.location ? "Give the review and the comment's <file>:<line>." : "Give the review.");

    const target = parseTarget(positional[0]);
    const key = target.kind === "pr" && target.repo ? await prReviewKey(tx, { repo: target.repo, number: target.number }) : positional[0].trim();
    if (ownReview !== undefined && key !== ownReview) return { exitCode: 2, stderr: NOT_OWN_REVIEW };
    if (!await tx.getReview(key)) return { exitCode: 1, stderr: `No saved review for ${positional[0]}. Pass the PR's URL or the review's key.` };
    if (action === "list") {
      return { exitCode: 0, stdout: values.json === undefined ? await describeComments(tx, key) : JSON.stringify({ review: key, comments: await listComments(tx, key) }, null, 2) };
    }

    const at = positional[1].match(/^(.+):([1-9]\d*)(?:-([1-9]\d*))?$/);
    if (!at) return usage(`${positional[1]} isn't a <file>:<line> or <file>:<start>-<end>.`);
    const side = values.side?.toUpperCase();
    if (side !== undefined && side !== "LEFT" && side !== "RIGHT") return usage("--side is LEFT or RIGHT.");
    const severity = values.severity?.toLowerCase() as Severity | "none" | undefined;
    if (severity !== undefined && severity !== "none" && !SEVERITIES.includes(severity)) return usage("--severity is blocking, should-fix, question, nit, or none.");
    const ends = [Number(at[2]), Number(at[3] ?? at[2])].sort((a, b) => a - b);
    const location = { file: at[1], line: ends[1], ...(side ? { side: side as "LEFT" | "RIGHT" } : {}) };
    const range = at[3] && action !== "delete" ? { startLine: ends[0] } : {};
    if (action === "add" && values.code === undefined) return usage("add needs --code with the line's text.");
    if (action !== "delete" && !values.body?.trim()) return usage(`${action} needs --body with the comment's text.`);
    if (values.body !== undefined && values.body.trim().length > BODY_LIMIT) return usage("--body is limited to 65,000 characters.");
    const evidence = values.evidence?.trim();
    if (evidence && evidence.length > 600) return usage("--evidence is limited to 600 characters.");
    const introduced = values["pre-existing"] === undefined ? {} : { introduced: false };
    const building = await firstGuideRefusal(tx, key);
    if (building) return building;
    const result: DraftResult = action === "add" ? await addComment(tx, key, { ...location, ...range, code: values.code!, severity, body: values.body!, evidence, ...introduced })
      : action === "edit" ? await editComment(tx, key, { ...location, ...range, ...(values.code !== undefined ? { code: values.code } : {}), severity, body: values.body!, evidence, ...introduced })
      : await deleteComment(tx, key, location);
    if (!result.ok) return { exitCode: 1, stderr: result.error };
    changed(key);
    return { exitCode: 0, stdout: result.text };
  });
}
