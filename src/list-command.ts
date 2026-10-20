import { lastActivity } from "../lib/status-line";
import { GUIDE_STOPPED, needsOrder, reviewState, type ReviewItem } from "../lib/review-state";
import { defaultName, renamedFrom, reviewName } from "../lib/review-name";
import { withStacks } from "../lib/stacks";
import type { TurnGroup } from "../lib/turn";

export const LIST_USAGE = [
  "usage: bb review list [--json]",
  "",
  "Lists your reviews in this bb as All reviews orders them: Needs review first, as it's ordered, then Waiting on author, Reviewed, and Archive, each latest first.",
  "  --json  each review's key, title, the name you gave it, whose turn, and status as JSON",
].join("\n");

/** The refusal a review's own agent gets for `bb review list`, as it may work only on its own review. */
export const NOT_LISTED = "This agent works only on its own review, so it can't list reviews.";

const SECTION: Record<TurnGroup, string> = { needs: "Needs review", waiting: "Waiting on author", reviewed: "Reviewed", archive: "Archive" };
const STATUS: Record<string, string> = { ready: "guide ready", generating: "guide building", error: "guide failed", tracked: "no guide yet" };

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

/** `bb review list`: the reviews, decorated with their turns as the panel gets them, in All reviews' order. */
export function runListCommand(reviews: ReviewItem[], argv: string[]): CliResult {
  let json = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { exitCode: 0, stdout: LIST_USAGE };
    if (arg !== "--json" || json) return { exitCode: 2, stderr: `Unexpected argument: ${arg}\n${LIST_USAGE}` };
    json = true;
  }
  const groups: Record<TurnGroup, ReviewItem[]> = { needs: [], waiting: [], reviewed: [], archive: [] };
  for (const review of reviews) groups[reviewState(review).group].push(review);
  groups.needs.sort(needsOrder);
  for (const group of ["waiting", "reviewed", "archive"] as const) groups[group].sort((a, b) => (lastActivity(b) ?? 0) - (lastActivity(a) ?? 0));
  // Each stack's reviews together, bottom first, where its first one is in the section.
  const rows = (Object.keys(groups) as TurnGroup[]).flatMap((group) => withStacks(groups[group]).flat().map((review) => ({
    key: review.targetKey,
    title: defaultName(review),
    // What the reviewer calls it, once they've renamed it.
    ...(renamedFrom(review) ? { name: reviewName(review) } : {}),
    whoseTurn: SECTION[group],
    turn: reviewState(review).label,
    // A first guide you stopped didn't fail.
    status: review.status === "error" && review.guideError?.text === GUIDE_STOPPED ? "guide stopped" : STATUS[review.status ?? ""] ?? review.status ?? "",
    ...(review.url ? { url: review.url } : {}),
  })));
  if (json) return { exitCode: 0, stdout: JSON.stringify({ reviews: rows }, null, 2) };
  if (!rows.length) return { exitCode: 0, stdout: "No reviews yet. Start one with `bb review <pr-url | git-ref>`." };
  // A PR's title is its author's words, quoted so an agent reads it as data, whatever it says; the name too.
  return { exitCode: 0, stdout: rows.map((row) => `${row.key}  ${JSON.stringify(row.title)}${row.name ? ` named ${JSON.stringify(row.name)}` : ""} · ${row.whoseTurn} (${row.turn}) · ${row.status}`).join("\n") };
}
