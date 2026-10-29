// The review assistant's tools on its own review's local draft: its comments, the summary, and replies in your discussions.
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { addComment, assistantReview, deleteComment, editComment, replyInDiscussion, REVIEWERS, type DraftResult } from "./draft-comments";
import { SEVERITIES, SUMMARY_AT } from "./draft";
import { describeDraft, writeSummary } from "./draft-summary";
import { describeRemovals, removalWarning } from "./learning";
import type { AsyncStore } from "./store-queue";
import { failed, type ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, classify } = deps;
  /**
   * A change to a comment, which on one the reviewer wrote may go ahead when they asked for it in chat, with the review
   * agent acting when asked; never in a turn they didn't start. Who's asking is read only for theirs, outside the store's
   * turn, and the change is then checked again in one.
   */
  async function reviewersToo(threadId: string, change: (tx: AsyncStore, targetKey: string, inChat: boolean) => Promise<DraftResult>): Promise<PluginAgentToolResult> {
    const first = await assistantDraft(threadId, true, (tx, targetKey) => change(tx, targetKey, false));
    if (typeof first === "string" || first.content[0]?.type !== "text" || first.content[0].text !== REVIEWERS) return first;
    if ((await classify(threadId)).asking !== "direct") return first;
    return await assistantDraft(threadId, true, async (tx, targetKey) => await change(tx, targetKey, (await tx.getPreferences()).preferences.knobs.reviewAgentActs));
  }
  // The review assistant's draft tools act only on its own review's local draft, checked in the same turn as the change.
  async function assistantDraft(threadId: string, changes: boolean, act: (tx: AsyncStore, targetKey: string) => Promise<DraftResult>): Promise<PluginAgentToolResult> {
    const { targetKey, result } = await store.exclusive(async (tx) => {
      const targetKey = await assistantReview(tx, threadId);
      const result: DraftResult = targetKey ? await act(tx, targetKey) : { ok: false, error: "This conversation is no longer a review's assistant, so it has no draft." };
      return { targetKey, result };
    });
    if (!result.ok) return failed(result.error);
    if (changes) bb.realtime.publish(`draft:${targetKey}`, {});
    return result.text;
  }
  const location = {
    file: z.string().describe("Repo-relative path, exactly as the diff shows it."),
    line: z.number().int().min(1).max(2_147_483_647).describe("The line's number in the new file (side RIGHT) or the old file (side LEFT)."),
    side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT, the default, for an added or unchanged line; LEFT for a removed line."),
  };
  // GitHub takes up to 65,536 characters in a comment or review body.
  const body = z.string().trim().min(1).max(65_000).describe("The comment, in GitHub Markdown.");
  const evidence = z.string().trim().max(600).optional().describe("How you confirmed it, in Markdown, under 600 characters: what you read or ran, with file:line, and repro steps. Only what you actually did. The reviewer sees it folded under the comment; it's never posted to GitHub.");
  const introduced = z.boolean().optional().describe("false when the problem is in code this PR didn't change.");
  const severity = z.enum([...SEVERITIES, "none"]).optional().describe("How much it matters: blocking, should-fix, question, nit, or none. Without it, a label the body starts with (**Blocking:**, **Should fix:**, **Question:**, **Nit:**) sets it; on edit, it otherwise stays. The label is kept apart from the text, and GitHub shows it in front.");
  const range = {
    startLine: z.number().int().min(1).max(2_147_483_647).optional().describe("For a comment on several lines, the first; line is the last. Both in one hunk of the diff."),
    startSide: z.enum(["RIGHT", "LEFT"]).optional().describe("The first line's side, when it isn't side: LEFT for a range from a removed line to an added one."),
  };
  bb.agents.registerTool({
    name: "list_draft_comments",
    description: "Show the reviewer's local draft for this review: the review summary and who wrote it (an agent or the reviewer), the verdict the reviewer picked and the one suggested, then each comment's location, who added it, and text, and the agents' comments the reviewer removed.",
    parameters: z.object({}),
    execute: async (_input, { threadId }) => await assistantDraft(threadId, false, async (tx, targetKey) => ({ ok: true, text: await describeDraft(tx, targetKey) + await describeRemovals(tx, targetKey) })),
  });
  bb.agents.registerTool({
    name: "add_draft_comment",
    description: "Add an inline comment to the reviewer's local draft for this review, on a line of the current diff, or with startLine on lines startLine to line. It reaches GitHub only when the review is submitted. Refuses a line that already has a draft comment.",
    instructions: "During a review pass, or when the reviewer asks, add each verified issue with add_draft_comment on the line it concerns, or the lines (startLine to line). In ordinary chat, answer in chat. Put one issue in each comment. Give its severity (blocking, should-fix, question, or nit), then say concretely what fails and the fix. Put how you confirmed it in evidence, with file:line: only what you read or ran. Prefer a ```suggestion block for a small, mechanical fix: it holds the exact replacement, indentation included, for exactly the commented lines, line alone or startLine to line, and the author applies it with one click. Give a range that covers every line the suggestion replaces, and no more. Points about the change as a whole go in the review summary, with set_review_summary. list_draft_comments shows the draft and who added each comment, and the comments the reviewer removed: don't raise those again unless their code changed. edit_draft_comment and delete_draft_comment change it. Change or delete the reviewer's own comments only when they ask. The draft is the reviewer's: they edit and remove it, and it's submitted only when they say so.",
    parameters: z.object({
      ...location,
      ...range,
      code: z.string().describe("The line's text, without the diff's leading +, -, or space. It must match the line. For a range, the lines' text, one per line: its first and last must match startLine and line."),
      severity,
      body,
      evidence,
      introduced,
    }),
    execute: async (input, { threadId }) => await assistantDraft(threadId, true, async (tx, targetKey) => {
      const added = await addComment(tx, targetKey, input);
      return added.ok ? { ok: true, text: added.text + await removalWarning(tx, targetKey, input) } : added;
    }),
  });
  bb.agents.registerTool({
    name: "edit_draft_comment",
    description: "Replace the text of the draft comment at a file, line, and side in the reviewer's local draft; line is a range's last line. With startLine and code, it also sets the range's first line, for example to fit a suggestion block. Its last line stays; to move a comment, delete it and add it again. Nothing reaches GitHub. Refuses a comment the reviewer wrote, unless they asked for the change.",
    parameters: z.object({ ...location, ...range, code: z.string().optional().describe("With startLine: the lines' text, one per line, as add_draft_comment takes it."), severity, body, evidence: evidence.describe("Replaces how you confirmed it, under 600 characters; without it, that stays."), introduced: introduced.describe("false when the problem is in code this PR didn't change; true when it's from this PR. Without it, that stays.") }),
    execute: async (input, { threadId }) => {
      return await reviewersToo(threadId, (tx, targetKey, inChat) => editComment(tx, targetKey, input, threadId, inChat));
    },
  });
  bb.agents.registerTool({
    name: "delete_draft_comment",
    description: "Delete the draft comment at a file, line, and side from the reviewer's local draft. Nothing reaches GitHub. Refuses a comment the reviewer wrote, unless they asked for it.",
    parameters: z.object(location),
    execute: async (input, { threadId }) => {
      return await reviewersToo(threadId, (tx, targetKey, inChat) => deleteComment(tx, targetKey, input, threadId, inChat));
    },
  });
  bb.agents.registerTool({
    name: "set_review_summary",
    description: "Write the review summary in the reviewer's local draft for this review: the top-level comment GitHub shows with the verdict and the line comments. Optionally suggest a verdict; the reviewer picks it. Nothing reaches GitHub. Refuses a summary the reviewer wrote, unless they asked on the summary for the change.",
    instructions: "Write the review summary with set_review_summary: the overall assessment, what blocks merging and what doesn't, and points that have no line. Don't repeat your line comments, since GitHub shows them with the review; refer to them by file:line. Keep it short, in GitHub Markdown. Name anything you didn't read. Give the verdict you'd suggest: APPROVE only if nothing blocks and you read every non-generated file, REQUEST_CHANGES only for a verified blocking issue, otherwise COMMENT. The reviewer picks the verdict, and yours is marked on it. Without verdict, your earlier suggestion stays marked. Messages from the summary's discussion ask for changes to it: make them with set_review_summary, and answer with reply_in_discussion (summary: true).",
    parameters: z.object({
      body: z.string().trim().min(1).max(65_000).describe("The summary, in GitHub Markdown."),
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional().describe("The verdict you'd suggest; the reviewer picks."),
      unchecked: z.array(z.string().max(120)).max(5).optional().describe("Up to 5 things you didn't read or run, such as files you skipped or tests you couldn't run, each under 120 characters. The reviewer sees them beside your verdict; they're never posted. Without it, what you said before stays."),
    }),
    execute: async (input, { threadId }) => await assistantDraft(threadId, true, async (tx, targetKey) => await writeSummary(tx, targetKey, input, threadId)),
  });
  bb.agents.registerTool({
    name: "reply_in_discussion",
    description: "Reply in the reviewer's discussion at a line of the diff, shown under the line's draft comment, or in its place when there's none; or, with summary: true, in the discussion on the review summary. Only the reviewer sees it; nothing reaches GitHub. The reviewer starts discussions, so there must be one there.",
    instructions: "Messages from a discussion in the diff say which line they're about. When a reply is warranted, answer with reply_in_discussion on that line, where the reviewer reads it, and keep your chat reply to one short line. When they ask for a change to the draft comment there, make it with add_draft_comment, edit_draft_comment, or delete_draft_comment instead of describing it.",
    parameters: z.object({
      summary: z.boolean().optional().describe("true to reply in the review summary's discussion, without file and line."),
      file: location.file.optional(), line: location.line.optional(), side: location.side,
      body: z.string().trim().min(1).max(65_000).describe("The reply, in Markdown."),
    }),
    execute: async ({ summary, file, line, side, body }, { threadId }) => await assistantDraft(threadId, true, async (tx, targetKey) =>
      summary ? await replyInDiscussion(tx, targetKey, { ...SUMMARY_AT, body })
      : file === undefined || line === undefined ? { ok: false, error: "Give the discussion's file and line, or summary: true for the review summary's discussion." }
      : await replyInDiscussion(tx, targetKey, { file, line, side, body })),
  });
}
