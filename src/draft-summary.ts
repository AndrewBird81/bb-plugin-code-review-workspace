// The review summary as agents and `bb review summary` write it. Like the draft
// comments, it stays in this bb's local draft until the reviewer submits it.
import type { Store } from "./store";
import { commentsKey, SUMMARY_AT, VERDICT_LABEL, verdictPicked, type Verdict } from "./draft";
import { describeComments, unchangeable, type DraftResult } from "./draft-comments";
import { asked } from "./asks";

/**
 * Write the summary as an agent, and suggest a verdict. An agent writes an empty summary or
 * an agent's; the reviewer's only when they asked on the summary, and then it stays theirs.
 */
export function writeSummary(store: Store, targetKey: string, input: { body: string; verdict?: Verdict }, threadId?: string): DraftResult {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) return { ok: false, error: refused };
  const draft = store.getDraft(targetKey);
  const body = input.body.trim();
  const reviewers = !draft.bodyAuthor && !!draft.body.trim();
  // Asking on the summary opens it to the turn that carries the ask, replies and all, on that conversation.
  if (reviewers && !asked(store, targetKey, SUMMARY_AT, threadId)) {
    return { ok: false, error: "The reviewer wrote the review summary, so it stays as they wrote it. Put your suggested summary in your reply instead; the reviewer can ask on the summary (Ask agent on the review summary, in Finish review) to apply it. Nothing was changed." };
  }
  const suggested = input.verdict ? { suggestedVerdict: input.verdict } : {};
  store.updateSummary(targetKey, reviewers ? { body, ...suggested } : {
    body, bodyAuthor: "agent", ...suggested,
    written: { verdict: input.verdict ?? (verdictPicked(draft) ? draft.verdict : null), comments: commentsKey(draft.comments) },
  });
  store.noteDiscussionChange(targetKey, SUMMARY_AT, draft.body.trim() ? "edited" : "added", {
    body, previous: {
      body: draft.body, ...(draft.bodyAuthor ? { author: draft.bodyAuthor } : {}), ...(draft.written ? { written: draft.written } : {}),
      ...(input.verdict ? { suggested: input.verdict, suggestedVerdict: draft.suggestedVerdict ?? null } : {}),
    },
  });
  const verdict = input.verdict ? ` Your suggested verdict, ${VERDICT_LABEL[input.verdict]}, is marked for the reviewer, who picks the verdict.` : "";
  return { ok: true, text: `${reviewers ? "Updated the reviewer's review summary, as they asked." : "Wrote the review summary."}${verdict} It stays in bb until the reviewer submits the review.` };
}

/** The summary and who wrote it, the verdict, and the assistant's suggestion. */
export function describeSummary(store: Store, targetKey: string): string {
  const draft = store.getDraft(targetKey);
  return [
    draft.body.trim()
      ? [`Review summary · written by ${draft.bodyAuthor === "agent" ? "an agent" : "the reviewer"}`, ...draft.body.trim().split("\n").map((line) => `  ${line}`)].join("\n")
      : "The draft has no review summary yet.",
    verdictPicked(draft) ? `Verdict: the reviewer picked ${VERDICT_LABEL[draft.verdict]}.` : "Verdict: the reviewer hasn't picked one, so it's Comment by default.",
    ...(draft.suggestedVerdict ? [`An agent's suggested verdict: ${VERDICT_LABEL[draft.suggestedVerdict]}.`] : []),
  ].join("\n");
}

/** list_draft_comments: the summary, the verdicts, then the comments. */
export function describeDraft(store: Store, targetKey: string): string {
  return `${describeSummary(store, targetKey)}\n${describeComments(store, targetKey)}`;
}
