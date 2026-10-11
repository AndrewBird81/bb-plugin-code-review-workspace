// Draft comments as agents and `bb review comment` change them. Everything
// here edits this bb's local draft; only the reviewer submits it to GitHub.
import type { PreviousState, ReviewMeta, Store } from "./store";
import { isSummary, linesOf, rangeOf, sameLocation, type CommentLocation, type DraftComment } from "./draft";
import { diffPositions, rangeProblem } from "./review-positions";
import { asked } from "./asks";

/** A comment's location as callers give it; side defaults to RIGHT. */
export interface LocationInput { file: string; line: number; side?: "LEFT" | "RIGHT" }
/** A range's first line, when a comment covers several; `line` is its last. Its side defaults to the comment's. */
export interface RangeInput { startLine?: number; startSide?: "LEFT" | "RIGHT" }
export interface NewComment extends LocationInput, RangeInput {
  /** The line's text, which catches a miscounted line number; for a range, its lines' text. */
  code: string;
  body: string;
}
export type DraftResult = { ok: true; text: string } | { ok: false; error: string };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const located = (input: LocationInput): CommentLocation => ({ file: input.file, line: input.line, side: input.side ?? "RIGHT" });
const where = (at: CommentLocation & RangeInput) => isSummary(at) ? "the review summary" : `${at.file}:${linesOf(at)}${at.side === "LEFT" ? " (LEFT side)" : ""}`;

/** The review whose assistant conversation this thread is. */
export function assistantReview(store: Store, threadId: string): string | null {
  return store.listAssistantThreads().find((thread) => thread.threadId === threadId)?.targetKey ?? null;
}

export function unchangeable(review: ReviewMeta | null): string | null {
  if (!review) return "This review no longer exists.";
  if (review.status === "generating") return "The review is being regenerated. Wait until it finishes, then read the new diff.";
  if (review.prState === "MERGED" || review.prState === "CLOSED") return `This PR is ${review.prState.toLowerCase()}, so its draft can't be submitted.`;
  return null;
}

/** The draft's comments, who added each, and whether the diff changed since it was drafted. */
export function listComments(store: Store, targetKey: string) {
  const stale = store.staleDraftComments(targetKey);
  return store.getDraft(targetKey).comments.map((c) => ({
    file: c.file, ...rangeOf(c), line: c.line, side: c.side, author: c.author ?? "reviewer", body: c.body,
    stale: stale.some((s) => sameLocation(s, c)),
  }));
}

export function describeComments(store: Store, targetKey: string): string {
  const comments = listComments(store, targetKey);
  if (!comments.length) return "The draft has no comments.";
  return [
    `${comments.length} draft comment${comments.length === 1 ? "" : "s"}:`,
    ...comments.map((c) => [
      `${c.file}:${linesOf(c)} ${c.startSide ? `${c.startSide}–` : ""}${c.side} · added by ${c.author === "agent" ? "an agent" : "the reviewer"}${c.stale ? " · drafted against an older diff, so submitting refuses it" : ""}`,
      ...c.body.split("\n").map((line) => `  ${line}`),
    ].join("\n")),
  ].join("\n");
}

/**
 * Why a comment can't go at a location and range of the current diff, or null: the last line's text must match
 * `code`, or for a range the last line of `code`, its first line the range's first, and GitHub must take the range.
 */
function placeProblem(patch: string, at: CommentLocation, range: RangeInput, input: string): string | null {
  const positions = diffPositions(patch).get(at.file);
  const lines = positions?.[at.side === "RIGHT" ? "right" : "left"];
  if (!positions || !lines) return `${at.file} isn't in this review's diff. Use the path exactly as the diff shows it.`;
  const sent = input.split("\n").filter((line) => line.trim());
  const text = lines.get(at.line);
  const code = normalize(range.startLine === undefined ? input : sent[sent.length - 1] ?? "");
  if (text === undefined || normalize(text) !== code) {
    const actual = text === undefined
      ? `Line ${at.line} isn't on the ${at.side} side of ${at.file} in this diff.`
      : `Line ${at.line} on the ${at.side} side of ${at.file} is \`${text.trim().slice(0, 500)}\`.`;
    const matches = [...lines].filter(([, line]) => normalize(line) === code).map(([number]) => number);
    const hint = matches.length ? ` The code you sent is on line ${matches.slice(0, 5).join(", ")}.` : ` The code you sent isn't on the ${at.side} side of ${at.file}.`;
    return `${actual}${hint}`;
  }
  if (range.startLine === undefined) return null;
  const startSide = range.startSide ?? at.side;
  const start = positions[startSide === "RIGHT" ? "right" : "left"].get(range.startLine);
  if (start === undefined) return `Line ${range.startLine} isn't on the ${startSide} side of ${at.file} in this diff.`;
  if (normalize(start) !== normalize(sent[0] ?? "")) return `Line ${range.startLine} on the ${startSide} side of ${at.file} is \`${start.trim().slice(0, 500)}\`, not the first line of the code you sent.`;
  return rangeProblem(patch, { ...at, ...range });
}

/** Add an agent's comment. It must sit on lines of the current diff whose text matches `code`, where the draft has no comment yet. */
export function addComment(store: Store, targetKey: string, input: NewComment): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  const range = rangeOf({ ...at, startLine: input.startLine, startSide: input.startSide });
  const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
  const problem = placeProblem(patch, at, range, input.code);
  if (problem) return { ok: false, error: `${problem} Nothing was added.` };
  const existing = store.getDraft(targetKey).comments.find((c) => sameLocation(c, at));
  if (existing) return { ok: false, error: `${where(at)} already has a draft comment: "${existing.body.slice(0, 300)}". Edit it instead, or make your point elsewhere. Nothing was added.` };
  store.upsertDraftComment(targetKey, { ...at, ...range, author: "agent", body: input.body.trim() });
  store.noteDiscussionChange(targetKey, at, "added", { body: input.body.trim(), previous: null });
  return { ok: true, text: `Added a draft comment on ${where({ ...at, ...range })}. It stays in bb until the reviewer submits the review.` };
}

const before = (comment: DraftComment): PreviousState => ({ body: comment.body, ...(comment.author ? { author: comment.author } : {}), ...(comment.chapterId ? { chapterId: comment.chapterId } : {}), ...rangeOf(comment) });

const REVIEWERS = "The reviewer wrote this comment. Suggest the change in chat; they can ask on the comment to have you apply it. Nothing was changed.";

/**
 * Replace a comment's text, and with `startLine` its range's first line. Its last line, author, and the diff it was
 * drafted against stay. An agent's comment changes freely; the reviewer's only in the turn on `threadId` that carries their ask on it.
 */
export function editComment(store: Store, targetKey: string, input: LocationInput & RangeInput & { body: string; code?: string }, threadId?: string): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  const comment = store.getDraft(targetKey).comments.find((c) => sameLocation(c, at));
  if (!comment) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  const reviewers = comment.author !== "agent";
  if (reviewers && !asked(store, targetKey, at, threadId)) return { ok: false, error: REVIEWERS };
  const body = input.body.trim();
  let range = rangeOf(comment);
  if (input.startLine !== undefined) {
    range = rangeOf({ ...at, startLine: input.startLine, startSide: input.startSide });
    if (input.code === undefined) return { ok: false, error: `Give code, the text of lines ${input.startLine} to ${at.line}, to change the comment's lines. Nothing was changed.` };
    // New lines bind it to the current diff, which a comment drafted against an older one wasn't checked against.
    if (store.staleDraftComments(targetKey).some((c) => sameLocation(c, at))) return { ok: false, error: `The comment on ${where(at)} was drafted against an older diff. Delete it and add it again on the current one. Nothing was changed.` };
    const problem = placeProblem(store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text, at, range, input.code);
    if (problem) return { ok: false, error: `${problem} Nothing was changed.` };
    store.upsertDraftComment(targetKey, { ...comment, startLine: undefined, startSide: undefined, ...range, body });
  } else if (!store.editDraftComment(targetKey, at, body)) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  store.noteDiscussionChange(targetKey, at, "edited", { body, previous: before(comment) });
  const lines = where({ ...at, ...range });
  return { ok: true, text: reviewers ? `Updated the reviewer's draft comment on ${lines}, as they asked.` : `Updated the draft comment on ${lines}.` };
}

/** Delete a comment: an agent's freely, the reviewer's only in the turn on `threadId` that carries their ask on it. */
export function deleteComment(store: Store, targetKey: string, input: LocationInput, threadId?: string): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const at = located(input);
  const comment = store.getDraft(targetKey).comments.find((c) => sameLocation(c, at));
  if (!comment) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  if (comment.author !== "agent" && !asked(store, targetKey, at, threadId)) return { ok: false, error: REVIEWERS };
  if (!store.deleteDraftComment(targetKey, at)) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
  store.noteDiscussionChange(targetKey, at, "removed", { body: "", previous: before(comment) });
  return { ok: true, text: `Deleted the draft comment on ${where({ ...at, ...rangeOf(comment) })}.` };
}

/** The comment's text at a location, or the summary's; null when there's none. */
function textAt(store: Store, targetKey: string, at: CommentLocation): string | null {
  const draft = store.getDraft(targetKey);
  if (isSummary(at)) return draft.body.trim() ? draft.body : null;
  return draft.comments.find((c) => sameLocation(c, at))?.body ?? null;
}

type Positions = () => ReturnType<typeof diffPositions>;
const positionsOf = (store: Store, targetKey: string): Positions => {
  let positions: ReturnType<typeof diffPositions> | undefined;
  return () => positions ??= diffPositions(store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text);
};

/**
 * Why the agent's latest change in a discussion can't be undone, or null when it can: the draft can still
 * change, nothing changed its comment or the summary since, and a removed comment's line still holds the code it was drafted on.
 */
function undoProblem(store: Store, targetKey: string, at: CommentLocation, positions: Positions): string | null {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return refused;
  const change = store.lastDiscussionChange(targetKey, at);
  if (!change) return "There's no change of the agent's to undo there.";
  const text = textAt(store, targetKey, at);
  if (change.kind === "removed" ? text !== null : text !== change.body) return "It changed since the agent's edit, so there's nothing to undo. Edit it instead.";
  if (change.kind !== "removed" || isSummary(at)) return null;
  const code = positions().get(at.file)?.[at.side === "RIGHT" ? "right" : "left"].get(at.line);
  // Putting it back binds it to the current diff, so the line must still hold the code it was drafted on.
  const drafted = store.draftCommentCode(targetKey, at);
  if (code === undefined) return `${where(at)} isn't in the diff anymore, so the comment can't go back there.`;
  if (drafted === undefined) return `bb didn't keep the code the comment on ${where(at)} was drafted on, so it can't go back there. Add it again instead.`;
  if (code !== drafted) return `The code at ${where(at)} changed since the comment was drafted, so it can't go back there.`;
  const start = change.previous?.startLine;
  if (start === undefined) return null;
  const startCode = positions().get(at.file)?.[(change.previous?.startSide ?? at.side) === "RIGHT" ? "right" : "left"].get(start);
  if (startCode === undefined || startCode !== store.draftCommentCode(targetKey, at, "start")) return `The code at ${at.file}:${start} changed since the comment was drafted, so it can't go back there.`;
  return null;
}

/** Which discussions' latest change of the agent's can be undone. Reads the diff at most once. */
export function undoable(store: Store, targetKey: string): (at: CommentLocation) => boolean {
  const positions = positionsOf(store, targetKey);
  return (at) => undoProblem(store, targetKey, at, positions) === null;
}

/** Put back what the agent's latest change in a discussion replaced: a comment's text, a removed comment, or the summary. */
export function undoChange(store: Store, targetKey: string, at: CommentLocation): DraftResult {
  const problem = undoProblem(store, targetKey, at, positionsOf(store, targetKey));
  if (problem) return { ok: false, error: problem };
  const { kind, previous } = store.lastDiscussionChange(targetKey, at)!;
  if (isSummary(at)) {
    // The suggested verdict goes back only if this change suggested it and nothing suggested another since.
    const verdict = previous?.suggested && store.getDraft(targetKey).suggestedVerdict === previous.suggested ? { suggestedVerdict: previous.suggestedVerdict ?? undefined } : {};
    store.updateSummary(targetKey, { body: previous?.body ?? "", bodyAuthor: previous?.author, written: previous?.written, ...verdict });
  } else if (!previous) {
    store.deleteDraftComment(targetKey, at);
  } else if (kind === "removed") {
    store.upsertDraftComment(targetKey, { ...at, ...rangeOf({ ...at, ...previous }), body: previous.body, ...(previous.author ? { author: previous.author } : {}), ...(previous.chapterId ? { chapterId: previous.chapterId } : {}) });
  } else {
    store.editDraftComment(targetKey, at, previous.body);
  }
  store.noteDiscussionRestored(targetKey, at);
  return { ok: true, text: isSummary(at) ? "Put the summary back." : `Put the comment on ${where(at)} back.` };
}

/** Answer the reviewer in the discussion they started at a line, or on the summary (SUMMARY_AT). */
export function replyInDiscussion(store: Store, targetKey: string, input: LocationInput & { body: string }): DraftResult {
  if (!store.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
  const at = located(input);
  if (!store.listDiscussions(targetKey).some((d) => sameLocation(d, at))) return { ok: false, error: `There's no discussion on ${where(at)}. The reviewer starts discussions; answer other messages in the chat.` };
  store.addDiscussionMessage(targetKey, at, "agent", input.body.trim());
  return { ok: true, text: `Replied in the discussion on ${where(at)}. The reviewer reads it there.` };
}
