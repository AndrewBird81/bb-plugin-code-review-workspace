// The reviewer's discussions with the review assistant at lines of the diff.
// They live beside the draft comments, in this bb only; nothing here reaches GitHub.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isSummary, postedBody, sameLocation, type CommentLocation, type DiscussionEntry } from "./draft";
import { extractSelectedLines } from "./assistant-context";
import { messageAssistant } from "./agent";
import { assistantReview, describeComments, unchangeable } from "./draft-comments";
import { describeSummary } from "./draft-summary";
import { askAt, setAsk } from "./asks";
import { codeFence } from "./untrusted";
import type { AsyncStore } from "./store-queue";

const MAX_HISTORY = 20_000;

export interface AskInput extends CommentLocation {
  /** The other end of the lines the reviewer selected, if several. */
  startLine?: number;
  body: string;
}

function historyLine(entry: DiscussionEntry, at: CommentLocation): string {
  if (entry.kind === "restored") return "(The reviewer undid that change.)";
  if (entry.kind !== "message") return `(An agent ${entry.kind} ${isSummary(at) ? "the review summary" : "the draft comment"}.)`;
  return `${entry.author === "agent" ? "You" : "Reviewer"}: ${entry.body}`;
}

/**
 * The reviewer's message as the assistant gets it. The chat shows `text`, one
 * line naming where it came from; `context` carries the rest for the assistant only.
 */
export async function discussionMessage(store: AsyncStore, targetKey: string, input: AskInput): Promise<{ text: string; context: string }> {
  return store.exclusive(async (tx) => {
    const at: CommentLocation = { file: input.file, line: input.line, side: input.side };
    const discussion = (await tx.listDiscussions(targetKey)).find((d) => sameLocation(d, at));
    const history = (discussion?.entries ?? []).map((entry) => historyLine(entry, at)).join("\n").slice(-MAX_HISTORY);
    if (isSummary(at)) return { text: `On the review summary: ${input.body}`, context: [
      "This message comes from the reviewer's discussion on the review summary in Finish review, not from the chat. They read replies there.",
      "When they ask you to change the summary, or to write one, do it with set_review_summary instead of describing it. If a reply is warranted, answer with reply_in_discussion with summary: true. Keep your reply in this chat to one short line.",
      await describeSummary(tx, targetKey),
      await describeComments(tx, targetKey),
      history ? `Earlier in this discussion:\n${history}` : "",
    ].filter(Boolean).join("\n\n") };
    const from = input.startLine ?? discussion?.startLine ?? at.line;
    const lines = from === at.line ? `${at.line}` : `${Math.min(from, at.line)}–${Math.max(from, at.line)}`;
    const comment = (await tx.getDraft(targetKey)).comments.find((c) => sameLocation(c, at));
    const patch = await tx.patch(targetKey);
    const code = extractSelectedLines(patch, at.file, from, at.line, at.side === "LEFT" ? "deletions" : "additions");
    const context = [
      `This message comes from the reviewer's discussion at ${at.file}:${lines} (${at.side} side) in the diff, not from the chat. They read replies there.`,
      `If a reply is warranted, answer with reply_in_discussion on file ${JSON.stringify(at.file)}, line ${at.line}, side ${at.side}. ${comment
        ? "If they ask you to change or drop the draft comment there, do it with edit_draft_comment or delete_draft_comment."
        : "If they ask for a draft comment there, add it with add_draft_comment."} Keep your reply in this chat to one short line.`,
      comment ? `The draft comment there, ${comment.author === "agent" ? "added by an agent" : "written by the reviewer"}:\n${postedBody(comment)}` : "There is no draft comment there.",
      code ? `The lines:\n${codeFence(code, "diff")}` : "",
      history ? `Earlier in this discussion:\n${history}` : "",
    ].filter(Boolean).join("\n\n");
    return { text: `On \`${at.file}:${lines}\`: ${input.body}`, context };
  });
}

/** Send the reviewer's message to the assistant and add it to the line's discussion. Returns whether a conversation started. */
export async function askAgent(bb: BbPluginApi, store: AsyncStore, targetKey: string, input: AskInput): Promise<{ started: boolean }> {
  const refused = unchangeable(await store.getReview(targetKey));
  if (refused) throw new Error(refused);
  const { text, context } = await discussionMessage(store, targetKey, input);
  // An ask on the summary or a comment opens what the reviewer wrote there to the turn that carries it, and only that turn.
  const before = askAt(await store.getReview(targetKey), input);
  await setAsk(store, targetKey, input, { threadId: await store.getAssistantThread(targetKey), state: "sending", at: Date.now() });
  let result: Awaited<ReturnType<typeof messageAssistant>>;
  try {
    result = await messageAssistant(bb, store, targetKey, text, context);
  } catch (error) {
    await setAsk(store, targetKey, input, before);
    throw error;
  }
  if (askAt(await store.getReview(targetKey), input)?.state === "sending") {
    const { threadId, queuedMessageId } = result;
    await setAsk(store, targetKey, input, queuedMessageId ? { threadId, state: "queued", queuedMessageId, at: Date.now() } : { threadId, state: "running", at: Date.now() });
  }
  await store.addDiscussionMessage(targetKey, input, "reviewer", input.body, input.startLine !== input.line ? input.startLine : undefined);
  return { started: result.started };
}

/**
 * Once the assistant's turn ends, it won't answer the discussions waiting for it,
 * unless a queued message starts another turn. Returns the review it settled.
 */
export async function settleDiscussions(bb: BbPluginApi, store: AsyncStore, threadId: string): Promise<string | null> {
  const targetKey = await assistantReview(store, threadId);
  if (!targetKey || !(await store.listDiscussions(targetKey)).some((d) => d.waiting)) return null;
  const queued = await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => []);
  if (queued.length) return null;
  return await store.stopWaiting(targetKey) ? targetKey : null;
}
