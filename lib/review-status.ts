// Where a review stands for another plugin (src/review-status.ts): who it waits on, whether you've approved the code as
// it is now, and since when. Read from the review's turn (lib/turn.ts), so it says what All reviews, the alerts and
// `bb review list` say. Pure, for the server.
import type { PushRun, SendEntry } from "../src/store";
import { approvalHolds, type Turn, type TurnInput } from "./turn";

/**
 * Who the review waits on: you (`user`), a thread working on it (`agent`), fixing the comments you sent or committing and
 * pushing for Push, the PR's author, on a PR you requested changes on or commented on with threads open, or no one.
 */
export type WaitsOn = "user" | "agent" | "author" | "nobody";

export interface Standing {
  waitsOn: WaitsOn;
  /** With `agent`: the thread it waits on. */
  thread: string | null;
  /** You've approved the code as it is now: on GitHub, at the PR's head, or in the main thread, while that covers it. */
  approved: boolean;
  /** In Archive: merged, closed, archived by you, or merged into another review. */
  archived: boolean;
}

/** Where the review stands, by its turn. */
export function standingOf(review: TurnInput & { push?: Pick<PushRun, "state" | "at" | "threadId"> | null; sends?: Pick<SendEntry, "threadId">[] }, turn: Turn): Standing {
  const waitsOn: WaitsOn = turn.group === "needs" ? "user"
    : turn.reason === "pushing" || turn.reason === "fixes-sent" ? "agent"
    : turn.reason === "waiting" ? "author"
    : "nobody";
  const thread = turn.reason === "pushing" ? review.push?.threadId ?? null : turn.reason === "fixes-sent" ? review.sends?.at(-1)?.threadId ?? null : null;
  // On someone else's PR your approval is your review on GitHub; on your own change, the one you sent its main thread.
  const github = review.kind === "pr" && review.ownPr !== true && review.submittedVerdict === "APPROVE" && !turn.updated;
  return { waitsOn, thread, approved: github || approvalHolds(review), archived: turn.group === "archive" };
}

/** What `since` keeps to: who it waits on, and whether it's approved or archived. */
export const standingKey = ({ waitsOn, approved, archived }: Standing) => [waitsOn, ...approved ? ["approved"] : [], ...archived ? ["archived"] : []].join("+");

/** When a review came to stand as it does, as kept on the review. */
export interface Since { key: string; at: number }

/**
 * When the review came to stand as it does (`key`), as kept with it: the time of the event behind its turn (`at`,
 * Turn.at) when that's no earlier than the last standing began, else `now`, when it's first seen so, as a review that
 * falls back to Ready once your approval no longer covers the code; a newer event behind it moves it on.
 */
export function sinceOf(kept: Since | null | undefined, key: string, at: number | null, now: number): Since {
  const event = at === null ? null : Math.min(at, now);
  if (kept?.key === key) return { key, at: Math.max(kept.at, event ?? 0) };
  return { key, at: event !== null && event >= (kept?.at ?? 0) ? event : now };
}
