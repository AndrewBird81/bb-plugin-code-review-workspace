// Move to summary (Settings → Comments and Finish review): a comment drafted against an older diff, whose lines left
// it, becomes a line of the review summary, which then is yours. The server writes the line; Finish review shows it.
import { linesOf, postedBody, type DraftComment } from "../src/draft";

/**
 * "- On `src/a.ts:42` (an earlier diff): **Nit:** Rename it.", its later lines indented to stay in the item. With
 * `preExisting`, a problem the PR didn't introduce is marked as it would post.
 */
export function summaryLine(comment: DraftComment, preExisting = false): string {
  const where = `${comment.file}:${linesOf(comment)}`;
  const [first, ...rest] = postedBody(comment, preExisting).trim().split("\n");
  return [`- On \`${where}\` (an earlier diff${comment.side === "LEFT" ? ", old line" : ""}): ${first}`, ...rest.map((line) => line ? `  ${line}` : "")].join("\n");
}

/** The summary with `line` added at its end: under its list, or after a blank line. */
export function withSummaryLine(summary: string, line: string): string {
  const text = summary.trimEnd();
  if (!text) return line;
  const last = text.split("\n").at(-1)!;
  return `${text}${/^(\s*[-*+] |\s{2,})/.test(last) ? "\n" : "\n\n"}${line}`;
}
