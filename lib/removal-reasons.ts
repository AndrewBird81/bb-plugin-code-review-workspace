// Why the reviewer removed an agent's draft comment (Settings → Review agent → Ask why you remove an agent's
// comment): one of four reasons, and an optional line of their own. The agent reads them, and so does Suggest
// instruction changes.

export const REMOVAL_REASONS = ["wrong", "intended", "known", "not-worth-it"] as const;
export type RemovalReasonId = typeof REMOVAL_REASONS[number];

/** The reasons as the Why? popover offers them. */
export const REMOVAL_REASON_LABEL: Record<RemovalReasonId, string> = { wrong: "Wrong", intended: "Intended", known: "Already known", "not-worth-it": "Not worth it" };

/** The reasons inside a sentence: "3 wrong, 2 not worth it", "(why: already known)". */
export const REMOVAL_REASON_WORDS: Record<RemovalReasonId, string> = { wrong: "wrong", intended: "intended", known: "already known", "not-worth-it": "not worth it" };

/** The most a reviewer's line about a removal holds. */
export const REMOVAL_NOTE_LIMIT = 200;

export interface RemovalReason {
  reason: RemovalReasonId;
  /** The reviewer's own line. */
  note?: string;
}
