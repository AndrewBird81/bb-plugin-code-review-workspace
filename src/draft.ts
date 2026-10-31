export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
/** What holds a Submit back until you submit anyway (src/submit-review.ts). */
export const SUBMIT_WARNINGS = ["revision", "closed", "generating", "no-head", "older-diff", "outside-diff", "new-commits", "base-changed"] as const;
export const VERDICT_LABEL: Record<Verdict, string> = { APPROVE: "Approve", COMMENT: "Comment", REQUEST_CHANGES: "Request changes" };

/** How much a comment matters to the author. A comment without one has none. */
export const SEVERITIES = ["blocking", "should-fix", "question", "nit"] as const;
export type Severity = typeof SEVERITIES[number];
export const SEVERITY_LABEL: Record<Severity, string> = { blocking: "Blocking", "should-fix": "Should fix", question: "Question", nit: "Nit" };

// "**Blocking:**", "**Blocking**:", or "Blocking:", in any case, and the space after it.
const LABEL = /^\s*(\*\*|__)?(blocking|should[ -]fix|question|nit)(?:\1:|:\1)\s*/i;

/**
 * A comment's text and severity as they're kept: a label the text starts with sets the severity, and
 * leaves the text; otherwise `severity`, where "none" is none.
 */
export function severityOf(body: string, severity?: Severity | "none"): { body: string; severity?: Severity } {
  const label = body.match(LABEL);
  const rest = label ? body.slice(label[0].length) : "";
  if (label && rest.trim()) return { severity: label[2].toLowerCase().replace(/[ -]/, "-") as Severity, body: rest };
  return { body, ...(severity && severity !== "none" ? { severity } : {}) };
}

/**
 * The text GitHub gets: the severity's label, then the comment. A block, such as a suggestion, starts on its own line.
 * With `preExisting` (Settings' Keep pre-existing problems apart), a problem the PR didn't introduce starts "**Pre-existing:**".
 */
export function postedBody(c: Pick<DraftComment, "body" | "severity" | "introduced">, preExisting = false): string {
  const labels = [...preExisting && c.introduced === false ? ["**Pre-existing:**"] : [], ...c.severity ? [`**${SEVERITY_LABEL[c.severity]}:**`] : []];
  if (!labels.length) return c.body;
  return `${labels.join(" ")}${/^(```|~~~|#|>|[-*+] |\d+[.)] |\|)/.test(c.body) ? "\n\n" : " "}${c.body}`;
}

/** A problem in code the PR didn't change, as the agent or the reviewer marked it. */
export const isPreExisting = (c: Pick<DraftComment, "introduced">) => c.introduced === false;

/** "2 blocking · 3 should fix · 1 nit": how many comments have each severity. Empty when none has one. */
export function severityCounts(comments: readonly Pick<DraftComment, "severity">[]): string {
  return SEVERITIES.flatMap((severity) => {
    const n = comments.filter((c) => c.severity === severity).length;
    const plural = n > 1 && (severity === "question" || severity === "nit") ? "s" : "";
    return n ? [`${n} ${SEVERITY_LABEL[severity].toLowerCase()}${plural}`] : [];
  }).join(" · ");
}

export interface DraftComment {
  file: string;
  /** The last line, under which GitHub shows the comment. */
  line: number;
  /** LOCAL: a line only in the folder of a PR's review, Not pushed yet's new side (src/own-pr.ts), which GitHub doesn't have. */
  side: "LEFT" | "RIGHT" | "LOCAL";
  /** The first line, when the comment covers more than one. It's in the same hunk as `line`, and before it. */
  startLine?: number;
  /** The first line's side, when it isn't `side`: a range from a removed line to an added one. */
  startSide?: "LEFT" | "RIGHT";
  chapterId?: string;
  /** Added by an agent, through a tool or `bb review comment`. Absent once the reviewer writes or edits it in the panel. */
  author?: "agent";
  severity?: Severity;
  /** The text, without its severity's label. */
  body: string;
  /** How the agent confirmed it: what it read or ran, with file:line. Shown in BB only; never posted. Gone once the reviewer edits the comment. */
  evidence?: string;
  /** False for a problem in code the PR didn't change: it shows as Pre-existing and doesn't count against Approve. */
  introduced?: false;
  /** `c<n>`, given when the comment is first sent (src/store.ts newCommentIds): unique across reviews, so a report names one comment. */
  id?: string;
  /** Where its fix stands. Absent reads as open: comments from before 1.8.0 have none. Only the reviewer's click resolves or dismisses one. */
  state?: CommentState;
  /** The Send that last carried it, whose diff is kept as the snapshot `send:<sendN>`. */
  sendN?: number;
  /** What the thread it was sent to reported for it. */
  claim?: Claim;
  /** The review agent changed the reviewer's comment, as they asked. Only the server sets it; an edit of its text or lines clears it. */
  editedBy?: "agent";
}

/** open: not sent, or edited or reopened since; sent: with the main thread or a fixer; resolved: fixed; dismissed: won't be. */
export const COMMENT_STATES = ["open", "sent", "resolved", "dismissed"] as const;
export type CommentState = typeof COMMENT_STATES[number];

/**
 * Whether a comment posts with Submit. On your own change (`own`) only an open one does: a Send took it to the thread
 * that fixes it. On someone else's PR a Send never changes what posts: all but the ones you resolved or dismissed.
 */
export const postable = (c: Pick<DraftComment, "state" | "side">, own: boolean) => !isLocal(c) && (own ? !c.state || c.state === "open" : c.state !== "resolved" && c.state !== "dismissed");

/** A comment on a line only in the folder, not on GitHub yet: it goes with Send, never with Submit, until it's pushed. */
export const isLocal = (c: Pick<DraftComment, "side">) => c.side === "LOCAL";

/** Where a comment sorts among others on its line: LEFT, then RIGHT, then LOCAL. */
export const sideOrder = (side: DraftComment["side"]) => side === "LEFT" ? 0 : side === "RIGHT" ? 1 : 2;

/** The side of its diff a line is on: a LOCAL one's is the new side of Not pushed yet's diff, never the PR's. */
export const diffSide = (side: DraftComment["side"]): "LEFT" | "RIGHT" => side === "LEFT" ? "LEFT" : "RIGHT";

/** A thread's report on a comment it was sent: with `bb review report`, or inferred by Check fixes. */
export interface Claim {
  outcome: "done" | "declined";
  note?: string;
  /** The commit it says has the fix. */
  commit?: string;
  /** The thread that reported it, as its caller said; null for a shell outside any thread. */
  threadId: string | null;
  at: number;
  /** Check fixes read it from the thread's last reply and the changes since the Send: the thread didn't report it. */
  inferred?: true;
}

/** A comment's place in the diff; a draft holds at most one comment per location. */
export type CommentLocation = Pick<DraftComment, "file" | "line" | "side">;

export function sameLocation(a: CommentLocation, b: CommentLocation): boolean {
  return a.file === b.file && a.line === b.line && a.side === b.side;
}

/** Where the review summary's discussion is kept: no line of a diff is here. */
export const SUMMARY_AT: CommentLocation = { file: "", line: 0, side: "RIGHT" };
export const isSummary = (at: CommentLocation) => sameLocation(at, SUMMARY_AT);

type Range = Pick<DraftComment, "line" | "side" | "startLine"> & { startSide?: DraftComment["side"] };

/** A comment's range as it's kept: a start only for more than one line, and a start side only when it isn't `side`. */
export function rangeOf(c: Range): Pick<DraftComment, "startLine" | "startSide"> {
  const startSide = c.startSide ?? c.side;
  if (c.startLine === undefined || c.startLine === c.line && startSide === c.side) return {};
  return { startLine: c.startLine, ...(c.startSide && c.startSide !== c.side ? { startSide: diffSide(c.startSide) } : {}) };
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
  /** What the agent says it didn't read or run, shown beside its verdict; never posted. */
  unchecked?: string[];
}

type Keyed = Pick<DraftComment, "file" | "line" | "side" | "body" | "startLine" | "startSide" | "severity" | "introduced">;
// A single-line comment's key is as it was before ranges, severities and pre-existing marks, so drafts saved then still match.
const keyOf = (c: Keyed) => [c.file, c.line, c.side, c.body, ...c.startLine === undefined ? [] : [c.startLine, c.startSide ?? c.side], ...c.severity ? [{ severity: c.severity }] : [], ...c.introduced === false ? [{ introduced: false }] : []];

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

/** An inline comment as GitHub's review API takes it. */
export type GithubReviewComment = { path: string; line: number; side: string; start_line?: number; start_side?: string; body: string };

/**
 * `preExisting`: mark the problems the PR didn't introduce, as postedBody does. `own`: your own change, as postable reads
 * it: always said, as a caller that forgot it would post comments sent to fix.
 */
export function toGithubReviewPayload(draft: Draft, preExisting: boolean, own: boolean): {
  event: Verdict;
  body: string;
  comments: GithubReviewComment[];
} {
  return {
    event: draft.verdict,
    body: draft.body,
    comments: draft.comments.filter((c) => postable(c, own)).map((c) => ({
      path: c.file, line: c.line, side: c.side,
      ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
      body: postedBody(c, preExisting),
    })),
  };
}
