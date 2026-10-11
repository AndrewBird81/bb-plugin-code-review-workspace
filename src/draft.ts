export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export const VERDICT_LABEL: Record<Verdict, string> = { APPROVE: "Approve", COMMENT: "Comment", REQUEST_CHANGES: "Request changes" };

export interface DraftComment {
  file: string;
  /** The last line, under which GitHub shows the comment. */
  line: number;
  side: "LEFT" | "RIGHT";
  /** The first line, when the comment covers more than one. It's in the same hunk as `line`, and before it. */
  startLine?: number;
  /** The first line's side, when it isn't `side`: a range from a removed line to an added one. */
  startSide?: "LEFT" | "RIGHT";
  chapterId?: string;
  /** Added by an agent, through a tool or `bb review comment`. Absent once the reviewer writes or edits it in the panel. */
  author?: "agent";
  body: string;
}

/** A comment's place in the diff; a draft holds at most one comment per location. */
export type CommentLocation = Pick<DraftComment, "file" | "line" | "side">;

export function sameLocation(a: CommentLocation, b: CommentLocation): boolean {
  return a.file === b.file && a.line === b.line && a.side === b.side;
}

/** Where the review summary's discussion is kept: no line of a diff is here. */
export const SUMMARY_AT: CommentLocation = { file: "", line: 0, side: "RIGHT" };
export const isSummary = (at: CommentLocation) => sameLocation(at, SUMMARY_AT);

type Range = Pick<DraftComment, "line" | "side" | "startLine" | "startSide">;

/** A comment's range as it's kept: a start only for more than one line, and a start side only when it isn't `side`. */
export function rangeOf(c: Range): Pick<DraftComment, "startLine" | "startSide"> {
  const startSide = c.startSide ?? c.side;
  if (c.startLine === undefined || c.startLine === c.line && startSide === c.side) return {};
  return { startLine: c.startLine, ...(startSide !== c.side ? { startSide } : {}) };
}

/** A comment's lines as the reviewer reads them: "15", or "10–15" for a range. */
export const linesOf = (c: Range) => c.startLine === undefined ? `${c.line}` : `${c.startLine}–${c.line}`;

/**
 * A message in a discussion with the review assistant, the assistant's change to the
 * draft comment or summary there, or the reviewer undoing that change ("restored").
 */
export interface DiscussionEntry {
  author: "reviewer" | "agent";
  kind: "message" | "added" | "edited" | "removed" | "restored";
  /** A message's text. For a change, the text the agent left; empty for a removal. */
  body: string;
  createdAt: number;
}

/**
 * The reviewer's discussion with the review assistant at a line, kept apart
 * from the line's draft comment and never sent to GitHub. A line has at most one.
 */
export interface Discussion extends CommentLocation {
  entries: DiscussionEntry[];
  /** The other end of the lines the reviewer first asked about, when they selected several. */
  startLine?: number;
  /** The assistant hasn't answered the reviewer's latest message yet, and may still. */
  waiting: boolean;
  /** The agent's latest change here can still be undone: nothing changed the comment or summary since. */
  undoable?: boolean;
}

export interface Draft {
  targetKey: string;
  verdict: Verdict;
  /** The review summary: the top-level comment GitHub shows with the verdict. */
  body: string;
  comments: DraftComment[];
  /** Written by an agent, through a tool or `bb review summary`. Absent once the reviewer writes or edits it. */
  bodyAuthor?: "agent";
  /** The verdict the assistant suggests. Only the reviewer picks one. */
  suggestedVerdict?: Verdict;
  /** When an agent wrote the summary: the verdict it wrote it for, if any, and commentsKey of the comments then. */
  written?: { verdict: Verdict | null; comments: string };
  /** The reviewer picked the verdict, rather than it being the default. */
  verdictChosen?: true;
}

type Keyed = Pick<DraftComment, "file" | "line" | "side" | "body" | "startLine" | "startSide">;
// A single-line comment's key is as it was before ranges, so drafts saved then still match.
const keyOf = (c: Keyed) => [c.file, c.line, c.side, c.body, ...c.startLine === undefined ? [] : [c.startLine, c.startSide ?? c.side]];

/** A short fingerprint of the comments' places and text, to tell when they changed. */
export function commentsKey(comments: readonly Keyed[]): string {
  // FNV-1a: the same value on the server and in the panel, without crypto.
  let hash = 0x811c9dc5;
  const text = JSON.stringify(comments.map(keyOf));
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${comments.length}:${hash.toString(16)}`;
}

/** Whether the reviewer picked the verdict. Drafts from before verdictChosen only left Comment when they picked another. */
export const verdictPicked = (draft: Draft) => !!draft.verdictChosen || draft.verdict !== "COMMENT";

/**
 * What changed since an agent wrote the summary: the comments, and the verdict, when the
 * reviewer picked one other than the summary was written for. Nothing for a summary the reviewer wrote.
 */
export function summaryChanges(draft: Draft): { comments: boolean; verdict: Verdict | null } {
  const written = draft.bodyAuthor === "agent" && draft.body.trim() ? draft.written : undefined;
  if (!written) return { comments: false, verdict: null };
  return {
    comments: written.comments !== commentsKey(draft.comments),
    verdict: written.verdict && verdictPicked(draft) && draft.verdict !== written.verdict ? written.verdict : null,
  };
}

/** Whether two lists hold the same comments, in the same order. */
export function sameComments(a: readonly DraftComment[], b: readonly Keyed[]): boolean {
  const key = (c: Keyed) => JSON.stringify(keyOf(c));
  return a.length === b.length && a.every((c, i) => key(c) === key(b[i]));
}

export function toGithubReviewPayload(draft: Draft): {
  event: Verdict;
  body: string;
  comments: { path: string; line: number; side: string; start_line?: number; start_side?: string; body: string }[];
} {
  return {
    event: draft.verdict,
    body: draft.body,
    comments: draft.comments.map((c) => ({
      path: c.file, line: c.line, side: c.side,
      ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
      body: c.body,
    })),
  };
}
