// Where a review's Sends stand (src/reports.ts): the comments still out with the thread that fixes them, which it
// reported, what the review agent's check found, and whether the review is Ready to re-review. Pure, so the server, the
// turn and the page agree, and say it in the same words.
import type { Claim, DraftComment } from "../src/draft";
import type { FixTally, ReviewLifecycle, SendEntry } from "../src/store";
import type { AssessmentVerdict } from "./feedback";

/** A comment out with the thread: its id, the Send that carried it, and the thread's report on it, if any. */
export interface OutComment { id: string; sendN: number; claim?: Claim }

/** The comments a review's Sends have out: sent draft comments, and on your own PR, sent GitHub threads. */
export function commentsOut(comments: readonly DraftComment[], threadSends: ReviewLifecycle["threadSends"]): OutComment[] {
  const drafts = comments.flatMap((comment) => comment.state === "sent" && comment.id && comment.sendN !== undefined ? [{ id: comment.id, sendN: comment.sendN, claim: comment.claim }] : []);
  return [...drafts, ...Object.values(threadSends ?? {})];
}

/** A report the thread made, not one a check inferred. */
export const reported = (claim: Claim | undefined) => !!claim && !claim.inferred;

/** The comments out, counted; `verdicts`, by comment id, are the check's of each against the Send it's out with. */
export function tallyOf(out: readonly OutComment[], verdicts: ReadonlyMap<string, AssessmentVerdict> = new Map()): FixTally {
  return {
    sent: out.length, reported: out.filter((comment) => reported(comment.claim)).length, inferred: out.filter((comment) => comment.claim?.inferred).length,
    checked: out.filter((comment) => verdicts.has(comment.id)).length, fixed: out.filter((comment) => verdicts.get(comment.id) === "addressed").length,
  };
}

/**
 * The review's newest Send while comments are out, and whether it's Ready to re-review (`ready`): its thread ran `bb
 * review ready`, or reported the last comment out. Not ready, the review waits for the thread's reports, unless the
 * thread was archived or deleted (`gone`). Null with nothing out: no Send, or every comment resolved, dismissed or open again.
 */
export function fixesState(review: Pick<ReviewLifecycle, "sends" | "fixes">): { send: SendEntry; ready: boolean; gone: "archived" | "deleted" | null; tally: FixTally } | null {
  const send = review.sends?.at(-1);
  const tally = review.fixes;
  if (!send || !tally?.sent) return null;
  const why = send.stopped?.why;
  return { send, ready: send.readyAt !== undefined, gone: why === "archived" || why === "deleted" ? why : null, tally };
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 of 3 reported". */
export const reportedText = ({ sent, reported }: Pick<FixTally, "sent" | "reported">) => `${reported} of ${sent} reported`;

/** "2 of 6 reported, 1 looks done": what the thread reported, and what the check found it did without a report. */
export const countedText = (tally: FixTally) => `${reportedText(tally)}${tally.inferred ? `, ${n(tally.inferred, "looks", "look")} done` : ""}`;

/** "Checked: 5 look fixed, 1 doesn't", once the review agent has checked any; null before. */
export function checkedText({ checked, fixed }: Pick<FixTally, "checked" | "fixed">): string | null {
  if (!checked) return null;
  const rest = checked - fixed;
  if (!fixed) return `Checked: ${n(rest, "doesn't", "don't")} look fixed`;
  return `Checked: ${n(fixed, "looks", "look")} fixed${rest ? `, ${n(rest, "doesn't", "don't")}` : ""}`;
}

/** Who said it's finished: the main thread, another thread by its title, or no one, from a shell. */
const finisher = (by: SendEntry["readyBy"]) => by?.from === "shell" ? null : by?.from === "thread" ? by.title || "Another thread" : "The main thread";

/**
 * Who finished the comments that came back, and how many: "The main thread reported all 6", "‹thread› says it’s
 * finished: 4 of 6 reported", "Marked finished from the command line: …". `yours`: "… all 6 of your comments".
 */
export function finishedText(tally: FixTally, by?: SendEntry["readyBy"], yours = false): string {
  if (tally.reported === tally.sent) return `The main thread reported all ${tally.sent}${yours ? " of your comments" : ""}`;
  const who = finisher(by);
  return who ? `${who} says it’s finished: ${countedText(tally)}` : `Marked finished from the command line: ${countedText(tally)}`;
}

/** Who did what with your comments, then what the check found, as an alert says it: "The main thread reported all 3 of your comments. Checked: 3 look fixed". */
export const cameBackText = (tally: FixTally, by?: SendEntry["readyBy"]) => [finishedText(tally, by, true), checkedText(tally)].filter(Boolean).join(". ");
