import type { Store } from "./store";
import { NOT_OWN_REVIEW } from "./review-command";
import { parseTarget, targetKey } from "./targets";
import { addComment, deleteComment, describeComments, editComment, listComments, type DraftResult } from "./draft-comments";
import { SEVERITIES, type Severity } from "./draft";

export const COMMENT_USAGE = [
  "usage: bb review comment list   <review> [--json]",
  "       bb review comment add    <review> <file>:<line> --code <text> --body <text> [--severity <severity>] [--evidence <text>] [--side LEFT|RIGHT]",
  "       bb review comment edit   <review> <file>:<line> --body <text> [--code <text>] [--severity <severity>] [--evidence <text>] [--side LEFT|RIGHT]",
  "       bb review comment delete <review> <file>:<line> [--side LEFT|RIGHT]",
  "",
  "Changes a review's local draft in this bb. Nothing is posted to GitHub; the reviewer submits the draft from Guided Review.",
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
].join("\n");

const ACTIONS = {
  list: { location: false, options: ["json"] },
  add: { location: true, options: ["side", "code", "body", "severity", "evidence"] },
  edit: { location: true, options: ["side", "code", "body", "severity", "evidence"] },
  delete: { location: true, options: ["side"] },
} as const;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };
/** GitHub takes up to 65,536 characters in a comment or review body. */
export const BODY_LIMIT = 65_000;
const usage = (problem: string): CliResult => ({ exitCode: 2, stderr: `${problem}\n${COMMENT_USAGE}` });

/** `bb review comment …`: list and change a review's draft comments. `changed` runs after a successful change.
 * `ownReview`, set when a review's own agent runs it, refuses every other review. */
export function runCommentCommand(store: Store, argv: string[], changed: (targetKey: string) => void, ownReview?: string): CliResult {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
  if (!action || !(action in ACTIONS)) return usage(action ? `Unknown action: ${action}` : "Choose list, add, edit, or delete.");
  const spec = ACTIONS[action as keyof typeof ACTIONS];
  const positional: string[] = [];
  const values: { side?: string; code?: string; body?: string; severity?: string; evidence?: string; json?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: COMMENT_USAGE };
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2) as keyof typeof values;
    if (!(spec.options as readonly string[]).includes(name)) return usage(`${action} doesn't take ${arg}.`);
    if (values[name] !== undefined) return usage(`${arg} is given twice.`);
    if (name === "json") { values.json = ""; continue; }
    if (i + 1 >= rest.length) return usage(`${arg} needs a value.`);
    values[name] = rest[++i];
  }
  if (positional.length !== (spec.location ? 2 : 1)) return usage(spec.location ? "Give the review and the comment's <file>:<line>." : "Give the review.");

  const target = parseTarget(positional[0]);
  const key = target.kind === "pr" && target.repo ? targetKey(target) : positional[0].trim();
  if (ownReview !== undefined && key !== ownReview) return { exitCode: 2, stderr: NOT_OWN_REVIEW };
  if (!store.getReview(key)) return { exitCode: 1, stderr: `No saved review for ${positional[0]}. Pass the PR's URL or the review's key.` };
  if (action === "list") {
    return { exitCode: 0, stdout: values.json === undefined ? describeComments(store, key) : JSON.stringify({ review: key, comments: listComments(store, key) }, null, 2) };
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
  const result: DraftResult = action === "add" ? addComment(store, key, { ...location, ...range, code: values.code!, severity, body: values.body!, evidence })
    : action === "edit" ? editComment(store, key, { ...location, ...range, ...(values.code !== undefined ? { code: values.code } : {}), severity, body: values.body!, evidence })
    : deleteComment(store, key, location);
  if (!result.ok) return { exitCode: 1, stderr: result.error };
  changed(key);
  return { exitCode: 0, stdout: result.text };
}
