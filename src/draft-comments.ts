// Draft comments as agents and `bb review comment` change them. Everything
// here edits this bb's local draft; only the reviewer submits it to GitHub.
import type { PreviousState, ReviewMeta } from "./store";
import { isSummary, linesOf, postedBody, rangeOf, sameLocation, severityOf, type CommentLocation, type DraftComment, type Severity } from "./draft";
import { diffPositions, rangeProblem } from "./review-positions";
import { asked } from "./asks";
import type { AsyncStore } from "./store-queue";
import { reviewIdentity } from "../lib/review-identity";

/** A comment's location as callers give it; side defaults to RIGHT. */
export interface LocationInput { file: string; line: number; side?: CommentLocation["side"] }
/** A range's first line, when a comment covers several; `line` is its last. Its side defaults to the comment's. */
export interface RangeInput { startLine?: number; startSide?: "LEFT" | "RIGHT" }
export interface NewComment extends LocationInput, RangeInput {
  /** The line's text, which catches a miscounted line number; for a range, its lines' text. */
  code: string;
  /** A label the body starts with sets it instead. */
  severity?: Severity | "none";
  body: string;
  /** How the agent confirmed it, which only the reviewer sees. */
  evidence?: string;
  /** False for a problem in code the PR didn't change. */
  introduced?: boolean;
}
export type DraftResult = { ok: true; text: string } | { ok: false; error: string };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const located = (input: LocationInput): CommentLocation => ({ file: input.file, line: input.line, side: input.side ?? "RIGHT" });
const where = (at: CommentLocation & RangeInput) => isSummary(at) ? "the review summary" : `${at.file}:${linesOf(at)}${at.side === "LEFT" ? " (LEFT side)" : ""}`;

/** The review whose assistant conversation this thread is. */
export async function assistantReview(store: AsyncStore, threadId: string): Promise<string | null> {
  return (await store.listAssistantThreads()).find((thread) => thread.threadId === threadId)?.targetKey ?? null;
}

/** What a review agent's tools answer once its review was merged into another, where the reviewer goes on; null otherwise. */
export async function mergedAway(store: Pick<AsyncStore, "getReview">, targetKey: string | null): Promise<string | null> {
  const review = targetKey ? await store.getReview(targetKey) : null;
  const into = review?.mergedInto ? await store.getReview(review.mergedInto) : null;
  return into ? `This review was merged into \`${reviewIdentity(into).id}\`. The reviewer continues there.` : null;
}

export function unchangeable(review: ReviewMeta | null): string | null {
  if (!review) return "This review no longer exists.";
  if (review.status === "generating") return "The review is being regenerated. Wait until it finishes, then read the new diff.";
  if (review.prState === "MERGED" || review.prState === "CLOSED") return `This PR is ${review.prState.toLowerCase()}, so its draft can't be submitted.`;
  return null;
}

/** The draft's comments, who added each, and whether the diff changed since it was drafted. */
export async function listComments(store: AsyncStore, targetKey: string) {
  return store.exclusive(async (tx) => {
    const stale = await tx.staleDraftComments(targetKey);
    return (await tx.getDraft(targetKey)).comments.map((c) => ({
      file: c.file, ...rangeOf(c), line: c.line, side: c.side, author: c.author ?? "reviewer", severity: c.severity ?? "none", body: c.body,
      ...(c.introduced === false ? { introduced: false } : {}), stale: stale.some((s) => sameLocation(s, c)),
    }));
  });
}

export async function describeComments(store: AsyncStore, targetKey: string): Promise<string> {
  const comments = await listComments(store, targetKey);
  if (!comments.length) return "The draft has no comments.";
  return [
    `${comments.length} draft comment${comments.length === 1 ? "" : "s"}:`,
    ...comments.map((c) => [
      `${c.file}:${linesOf(c)} ${c.startSide ? `${c.startSide}–` : ""}${c.side} · added by ${c.author === "agent" ? "an agent" : "the reviewer"}${c.severity === "none" ? "" : ` · ${c.severity}`}${c.introduced === false ? " · pre-existing" : ""}${c.stale ? " · drafted against an older diff, so Submit warns, and moves it into the summary if submitted anyway" : ""}`,
      ...c.body.split("\n").map((line) => `  ${line}`),
    ].join("\n")),
  ].join("\n");
}

/**
 * Why a comment can't go at a location and range of the current diff, or null: the last line's text must match
 * `code`, or for a range the last line of `code`, its first line the range's first, and GitHub must take the range.
 */
async function placeProblem(store: AsyncStore, targetKey: string, at: CommentLocation, range: RangeInput, input: string): Promise<string | null> {
  return store.exclusive(async (tx) => {
    const positions = (await tx.diffPositions(targetKey)).get(at.file);
    const lines = positions?.[at.side === "RIGHT" ? "right" : "left"];
    if (!positions || !lines) return `${at.file} isn't in this review's diff. Use the path exactly as the diff shows it.`;
    const sent = input.split("\n");
    const text = lines.get(at.line);
    // A trailing newline isn't a blank last line unless the last line is blank.
    if (sent.length > 1 && !sent[sent.length - 1].trim() && text?.trim()) sent.pop();
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
    return rangeProblem(await tx.patch(targetKey), { ...at, ...range });
  });
}

/** Add an agent's comment. It must sit on lines of the current diff whose text matches `code`, where the draft has no comment yet. */
export async function addComment(store: AsyncStore, targetKey: string, input: NewComment): Promise<DraftResult> {
  return store.exclusive(async (tx) => {
    const refused = unchangeable(await tx.getReview(targetKey));
    if (refused) return { ok: false, error: refused };
    const at = located(input);
    const range = rangeOf({ ...at, startLine: input.startLine, startSide: input.startSide });
    const problem = await placeProblem(tx, targetKey, at, range, input.code);
    if (problem) return { ok: false, error: `${problem} Nothing was added.` };
    const existing = (await tx.getDraft(targetKey)).comments.find((c) => sameLocation(c, at));
    if (existing) return { ok: false, error: `${where(at)} already has a draft comment: "${existing.body.slice(0, 300)}". Edit it instead, or make your point elsewhere. Nothing was added.` };
    const { body, severity } = severityOf(input.body.trim(), input.severity);
    const evidence = input.evidence?.trim();
    await tx.upsertDraftComment(targetKey, { ...at, ...range, author: "agent", ...(severity ? { severity } : {}), body, ...(evidence ? { evidence } : {}), ...(input.introduced === false ? { introduced: false as const } : {}) });
    await tx.noteDiscussionChange(targetKey, at, "added", { body: postedBody({ body, severity }), previous: null });
    return { ok: true, text: `Added a draft comment on ${where({ ...at, ...range })}. It stays in bb until the reviewer submits the review.` };
  });
}

const before = (comment: DraftComment, startCode?: string): PreviousState => ({ body: comment.body, ...(comment.author ? { author: comment.author } : {}), ...(comment.severity ? { severity: comment.severity } : {}), ...(comment.evidence ? { evidence: comment.evidence } : {}), ...(comment.introduced === false ? { introduced: false as const } : {}), ...(comment.chapterId ? { chapterId: comment.chapterId } : {}), ...rangeOf(comment), ...(startCode === undefined ? {} : { startCode }) });

export const REVIEWERS = "The reviewer wrote this comment. Suggest the change in chat; they can ask on the comment to have you apply it. Nothing was changed.";

/**
 * Replace a comment's text, and with `startLine` its range's first line. Its severity changes with a label or `severity`,
 * how the agent checked it with `evidence`, and whether the PR introduced it with `introduced`. Its last line, author, and the diff it was drafted against stay. An agent's comment changes freely; the reviewer's only in the turn on `threadId` that carries their ask on it, or
 * (`inChat`) in a turn the reviewer asked for it in chat, and it's then marked as the agent's edit.
 */
export async function editComment(store: AsyncStore, targetKey: string, input: LocationInput & RangeInput & { body: string; code?: string; severity?: Severity | "none"; evidence?: string; introduced?: boolean }, threadId?: string, inChat = false): Promise<DraftResult> {
  return store.exclusive(async (tx) => {
    const refused = unchangeable(await tx.getReview(targetKey));
    if (refused) return { ok: false, error: refused };
    const at = located(input);
    const comment = (await tx.getDraft(targetKey)).comments.find((c) => sameLocation(c, at));
    if (!comment) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
    const reviewers = comment.author !== "agent";
    if (reviewers && !inChat && !await asked(tx, targetKey, at, threadId)) return { ok: false, error: REVIEWERS };
    const { body, severity } = severityOf(input.body.trim(), input.severity ?? comment.severity);
    // How the agent checked is for its own comments.
    const evidence = reviewers ? undefined : input.evidence?.trim() || comment.evidence;
    // New lines replace the code the old first line was drafted on, which undoing them checks.
    const previous = before(comment, await tx.draftCommentCode(targetKey, at, "start"));
    let range = rangeOf(comment);
    if (input.startLine !== undefined) {
      range = rangeOf({ ...at, startLine: input.startLine, startSide: input.startSide });
      if (input.code === undefined) return { ok: false, error: `Give code, the text of lines ${input.startLine} to ${at.line}, to change the comment's lines. Nothing was changed.` };
      // New lines bind it to the current diff, which a comment drafted against an older one wasn't checked against.
      if ((await tx.staleDraftComments(targetKey)).some((c) => sameLocation(c, at))) return { ok: false, error: `The comment on ${where(at)} was drafted against an older diff. Delete it and add it again on the current one. Nothing was changed.` };
      const problem = await placeProblem(tx, targetKey, at, range, input.code);
      if (problem) return { ok: false, error: `${problem} Nothing was changed.` };
      await tx.upsertDraftComment(targetKey, { ...comment, startLine: undefined, startSide: undefined, severity, ...range, body, evidence, ...(input.introduced === undefined ? {} : { introduced: input.introduced ? undefined : false }) });
    } else if (!await tx.editDraftComment(targetKey, at, body, severity ?? null, evidence ?? null, input.introduced)) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
    // Undo puts old lines back only when this edit set new ones; a re-review may move them on its own.
    await tx.noteDiscussionChange(targetKey, at, "edited", { body: postedBody({ body, severity }), previous: previous && input.startLine !== undefined ? { ...previous, relined: true } : previous });
    if (reviewers) await tx.trackComments(targetKey, [{ at, editedBy: "agent" }]);
    const lines = where({ ...at, ...range });
    return { ok: true, text: reviewers ? `Updated the reviewer's draft comment on ${lines}, as they asked.` : `Updated the draft comment on ${lines}.` };
  });
}

/** Delete a comment: an agent's freely, the reviewer's only in the turn on `threadId` that carries their ask on it, or (`inChat`) one they asked for it in chat. */
export async function deleteComment(store: AsyncStore, targetKey: string, input: LocationInput, threadId?: string, inChat = false): Promise<DraftResult> {
  return store.exclusive(async (tx) => {
    const refused = unchangeable(await tx.getReview(targetKey));
    if (refused) return { ok: false, error: refused };
    const at = located(input);
    const comment = (await tx.getDraft(targetKey)).comments.find((c) => sameLocation(c, at));
    if (!comment) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
    if (comment.author !== "agent" && !inChat && !await asked(tx, targetKey, at, threadId)) return { ok: false, error: REVIEWERS };
    if (!await tx.deleteDraftComment(targetKey, at)) return { ok: false, error: `There's no draft comment on ${where(at)}.` };
    await tx.noteDiscussionChange(targetKey, at, "removed", { body: "", previous: before(comment) });
    return { ok: true, text: `Deleted the draft comment on ${where({ ...at, ...rangeOf(comment) })}.` };
  });
}

/** The comment's text at a location as GitHub would get it, so with its severity, or the summary's; null when there's none. */
async function textAt(store: AsyncStore, targetKey: string, at: CommentLocation): Promise<string | null> {
  const draft = await store.getDraft(targetKey);
  if (isSummary(at)) return draft.body.trim() ? draft.body : null;
  const comment = draft.comments.find((c) => sameLocation(c, at));
  return comment ? postedBody(comment) : null;
}

type Positions = () => Promise<ReturnType<typeof diffPositions>>;
const positionsOf = (store: AsyncStore, targetKey: string): Positions => {
  let positions: ReturnType<typeof diffPositions> | undefined;
  return async () => positions ??= await store.diffPositions(targetKey);
};

/** The comment at a location, when the agent's edit there set its lines. */
async function relined(store: AsyncStore, targetKey: string, at: CommentLocation, previous: PreviousState): Promise<DraftComment | null> {
  if (!previous?.relined) return null;
  return (await store.getDraft(targetKey)).comments.find((c) => sameLocation(c, at)) ?? null;
}

/**
 * Why the agent's latest change in a discussion can't be undone, or null when it can: the draft can still
 * change, nothing changed its comment or the summary since, and a removed comment's lines, or an edited one's
 * old lines, still hold the code they were drafted on.
 */
async function undoProblem(store: AsyncStore, targetKey: string, at: CommentLocation, positions: Positions): Promise<string | null> {
  return store.exclusive(async (tx) => {
    const refused = unchangeable(await tx.getReview(targetKey));
    if (refused) return refused;
    const change = await tx.lastDiscussionChange(targetKey, at);
    if (!change) return "There's no change of the agent's to undo there.";
    const text = await textAt(tx, targetKey, at);
    if (change.kind === "removed" ? text !== null : text !== change.body) return "It changed since the agent's edit, so there's nothing to undo. Edit it instead.";
    if (isSummary(at)) return null;
    const lines = change.kind === "edited" && await relined(tx, targetKey, at, change.previous) !== null;
    if (change.kind !== "removed" && !lines) return null;
    const code = (await positions()).get(at.file)?.[at.side === "RIGHT" ? "right" : "left"].get(at.line);
    // Putting it back binds it to the current diff, so the line must still hold the code it was drafted on.
    const drafted = await tx.draftCommentCode(targetKey, at);
    if (code === undefined) return `${where(at)} isn't in the diff anymore, so the comment can't go back there.`;
    if (drafted === undefined) return `bb didn't keep the code the comment on ${where(at)} was drafted on, so it can't go back there. Add it again instead.`;
    if (code !== drafted) return `The code at ${where(at)} changed since the comment was drafted, so it can't go back there.`;
    const start = change.previous?.startLine;
    if (start === undefined) return null;
    const startCode = (await positions()).get(at.file)?.[(change.previous?.startSide ?? at.side) === "RIGHT" ? "right" : "left"].get(start);
    const startDrafted = lines ? change.previous?.startCode : await tx.draftCommentCode(targetKey, at, "start");
    if (startCode === undefined || startCode !== startDrafted) return `The code at ${at.file}:${start} changed since the comment was drafted, so it can't go back there.`;
    return null;
  });
}

/** Which discussions' latest change of the agent's can be undone. Reads the diff at most once. */
export function undoable(store: AsyncStore, targetKey: string): (at: CommentLocation) => Promise<boolean> {
  const positions = positionsOf(store, targetKey);
  return async (at) => await undoProblem(store, targetKey, at, positions) === null;
}

/** Put back what the agent's latest change in a discussion replaced: a comment's text, a removed comment, or the summary. */
export async function undoChange(store: AsyncStore, targetKey: string, at: CommentLocation): Promise<DraftResult> {
  return store.exclusive(async (tx) => {
    const problem = await undoProblem(tx, targetKey, at, positionsOf(tx, targetKey));
    if (problem) return { ok: false, error: problem };
    const { kind, previous } = (await tx.lastDiscussionChange(targetKey, at))!;
    if (isSummary(at)) {
      // The suggested verdict goes back only if this change suggested it and nothing suggested another since.
      const verdict = previous?.suggested && (await tx.getDraft(targetKey)).suggestedVerdict === previous.suggested ? { suggestedVerdict: previous.suggestedVerdict ?? undefined } : {};
      await tx.updateSummary(targetKey, { body: previous?.body ?? "", bodyAuthor: previous?.author, written: previous?.written, ...verdict });
    } else if (!previous) {
      await tx.deleteDraftComment(targetKey, at);
    } else if (kind === "removed") {
      await tx.upsertDraftComment(targetKey, { ...at, ...rangeOf({ ...at, ...previous }), body: previous.body, ...(previous.author ? { author: previous.author } : {}), ...(previous.severity ? { severity: previous.severity } : {}), ...(previous.chapterId ? { chapterId: previous.chapterId } : {}), ...(previous.evidence ? { evidence: previous.evidence } : {}), ...(previous.introduced === false ? { introduced: false as const } : {}) });
    } else {
      const comment = await relined(tx, targetKey, at, previous);
      if (comment) await tx.upsertDraftComment(targetKey, { ...comment, startLine: undefined, startSide: undefined, severity: previous.severity, ...rangeOf({ ...at, ...previous }), body: previous.body, evidence: previous.evidence, introduced: previous.introduced });
      else await tx.editDraftComment(targetKey, at, previous.body, previous.severity ?? null, previous.evidence ?? null, previous.introduced ?? true);
    }
    await tx.noteDiscussionRestored(targetKey, at);
    return { ok: true, text: isSummary(at) ? "Put the summary back." : `Put the comment on ${where(at)} back.` };
  });
}

/** Answer the reviewer in the discussion they started at a line, or on the summary (SUMMARY_AT). */
export async function replyInDiscussion(store: AsyncStore, targetKey: string, input: LocationInput & { body: string }): Promise<DraftResult> {
  return store.exclusive(async (tx) => {
    if (!await tx.getReview(targetKey)) return { ok: false, error: "This review no longer exists." };
    const at = located(input);
    if (!(await tx.listDiscussions(targetKey)).some((d) => sameLocation(d, at))) return { ok: false, error: `There's no discussion on ${where(at)}. The reviewer starts discussions; answer other messages in the chat.` };
    await tx.addDiscussionMessage(targetKey, at, "agent", input.body.trim());
    return { ok: true, text: `Replied in the discussion on ${where(at)}. The reviewer reads it there.` };
  });
}
