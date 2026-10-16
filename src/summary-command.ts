import type { Store } from "./store";
import { NOT_OWN_REVIEW } from "./review-command";
import { BODY_LIMIT } from "./comment-command";
import { verdictPicked, type Verdict } from "./draft";
import { parseTarget, targetKey } from "./targets";
import { describeSummary, writeSummary } from "./draft-summary";

export const SUMMARY_USAGE = [
  "usage: bb review summary <review> [--json]",
  "       bb review summary <review> --body <text> [--suggest APPROVE|COMMENT|REQUEST_CHANGES]",
  "",
  "Shows or writes the review summary in a review's local draft in this bb. Nothing is posted to GitHub; the reviewer picks the verdict and submits the draft from Guided Review.",
  "  <review>   a GitHub PR URL, or a review key (pr-…, ref-…)",
  "  --body     the summary, in GitHub Markdown, up to 65,000 characters; quote it for your shell. A summary the reviewer wrote stays theirs",
  "  --suggest  the verdict you'd suggest; the reviewer picks",
  "  --json     show the summary, who wrote it, and the verdicts as JSON",
].join("\n");

const VERDICTS: readonly string[] = ["APPROVE", "COMMENT", "REQUEST_CHANGES"];

type CliResult = { exitCode: number; stdout?: string; stderr?: string };
const usage = (problem: string): CliResult => ({ exitCode: 2, stderr: `${problem}\n${SUMMARY_USAGE}` });

/** `bb review summary …`: show or write a review's summary as an agent. `changed` runs after a successful change.
 * `ownReview`, set when a review's own agent runs it, refuses every other review. */
export function runSummaryCommand(store: Store, argv: string[], changed: (targetKey: string) => void, ownReview?: string): CliResult {
  const positional: string[] = [];
  const values: { body?: string; suggest?: string; json?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: SUMMARY_USAGE };
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2) as keyof typeof values;
    if (!["body", "suggest", "json"].includes(name)) return usage(`summary doesn't take ${arg}.`);
    if (values[name] !== undefined) return usage(`${arg} is given twice.`);
    if (name === "json") { values.json = ""; continue; }
    if (i + 1 >= argv.length) return usage(`${arg} needs a value.`);
    values[name] = argv[++i];
  }
  if (positional.length !== 1) return usage("Give the review.");
  if (values.json !== undefined && values.body !== undefined) return usage("--json shows the summary; it doesn't take --body.");
  if (values.suggest !== undefined && values.body === undefined) return usage("--suggest goes with --body.");
  if (values.body !== undefined && !values.body.trim()) return usage("--body needs the summary's text.");
  if (values.body !== undefined && values.body.trim().length > BODY_LIMIT) return usage("--body is limited to 65,000 characters.");
  const suggest = values.suggest?.toUpperCase();
  if (suggest !== undefined && !VERDICTS.includes(suggest)) return usage("--suggest is APPROVE, COMMENT, or REQUEST_CHANGES.");

  const target = parseTarget(positional[0]);
  const key = target.kind === "pr" && target.repo ? targetKey(target) : positional[0].trim();
  if (ownReview !== undefined && key !== ownReview) return { exitCode: 2, stderr: NOT_OWN_REVIEW };
  if (!store.getReview(key)) return { exitCode: 1, stderr: `No saved review for ${positional[0]}. Pass the PR's URL or the review's key.` };
  if (values.body === undefined) {
    if (values.json === undefined) return { exitCode: 0, stdout: describeSummary(store, key) };
    const draft = store.getDraft(key);
    return { exitCode: 0, stdout: JSON.stringify({
      review: key, body: draft.body, author: draft.body.trim() ? draft.bodyAuthor ?? "reviewer" : null,
      verdict: draft.verdict, verdictChosen: verdictPicked(draft), suggestedVerdict: draft.suggestedVerdict ?? null,
    }, null, 2) };
  }
  const result = writeSummary(store, key, { body: values.body, ...(suggest ? { verdict: suggest as Verdict } : {}) });
  if (!result.ok) return { exitCode: 1, stderr: result.error };
  changed(key);
  return { exitCode: 0, stdout: result.text };
}
