// The reviewer's discussions with the review assistant at lines of the diff.
// They live beside the draft comments, in this bb only; nothing here reaches GitHub.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { isSummary, sameLocation, type CommentLocation, type DiscussionEntry } from "./draft";
import { extractSelectedLines } from "./assistant-context";
import { messageAssistant } from "./agent";
import { assistantReview, describeComments, unchangeable } from "./draft-comments";
import { describeSummary } from "./draft-summary";

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
export function discussionMessage(store: Store, targetKey: string, input: AskInput): { text: string; context: string } {
  const at: CommentLocation = { file: input.file, line: input.line, side: input.side };
  const discussion = store.listDiscussions(targetKey).find((d) => sameLocation(d, at));
  const history = (discussion?.entries ?? []).map((entry) => historyLine(entry, at)).join("\n").slice(-MAX_HISTORY);
  if (isSummary(at)) return { text: `On the review summary: ${input.body}`, context: [
    "This message comes from the reviewer's discussion on the review summary in Draft review, not from the chat. They read replies there.",
    "When they ask you to change the summary, or to write one, do it with set_review_summary instead of describing it. If a reply is warranted, answer with reply_in_discussion with summary: true. Keep your reply in this chat to one short line.",
    describeSummary(store, targetKey),
    describeComments(store, targetKey),
    history ? `Earlier in this discussion:\n${history}` : "",
  ].filter(Boolean).join("\n\n") };
  const from = input.startLine ?? discussion?.startLine ?? at.line;
  const lines = from === at.line ? `${at.line}` : `${Math.min(from, at.line)}–${Math.max(from, at.line)}`;
  const comment = store.getDraft(targetKey).comments.find((c) => sameLocation(c, at));
  const patch = store.readPatch(targetKey, 0, store.readPatch(targetKey, 0, 0).total).text;
  const code = extractSelectedLines(patch, at.file, from, at.line, at.side === "LEFT" ? "deletions" : "additions");
  const context = [
    `This message comes from the reviewer's discussion at ${at.file}:${lines} (${at.side} side) in the diff, not from the chat. They read replies there.`,
    `If a reply is warranted, answer with reply_in_discussion on file ${JSON.stringify(at.file)}, line ${at.line}, side ${at.side}. ${comment
      ? "If they ask you to change or drop the draft comment there, do it with edit_draft_comment or delete_draft_comment."
      : "If they ask for a draft comment there, add it with add_draft_comment."} Keep your reply in this chat to one short line.`,
    comment ? `The draft comment there, ${comment.author === "agent" ? "added by an agent" : "written by the reviewer"}:\n${comment.body}` : "There is no draft comment there.",
    code ? `The lines:\n\`\`\`diff\n${code}\n\`\`\`` : "",
    history ? `Earlier in this discussion:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
  return { text: `On \`${at.file}:${lines}\`: ${input.body}`, context };
}

/** Send the reviewer's message to the assistant and add it to the line's discussion. Returns whether a conversation started. */
export async function askAgent(bb: BbPluginApi, store: Store, targetKey: string, input: AskInput): Promise<{ started: boolean }> {
  const refused = unchangeable(store.getReview(targetKey));
  if (refused) throw new Error(refused);
  const { text, context } = discussionMessage(store, targetKey, input);
  // Placed before it's sent, so even a turn that ends at once finds it.
  const summary = isSummary(input);
  if (summary) store.setLifecycle(targetKey, { summaryAsk: await askPlace(bb, store, targetKey) });
  let result: { started: boolean; threadId: string };
  try {
    result = await messageAssistant(bb, store, targetKey, text, context);
  } catch (error) {
    if (summary) store.setLifecycle(targetKey, { summaryAsk: null });
    throw error;
  }
  const ask = store.getReview(targetKey)?.summaryAsk;
  if (summary && ask && ask.threadId !== result.threadId) store.setLifecycle(targetKey, { summaryAsk: { ...ask, threadId: result.threadId, ahead: 0 } });
  store.addDiscussionMessage(targetKey, input, "reviewer", input.body, input.startLine !== input.line ? input.startLine : undefined);
  return { started: result.started };
}

/**
 * Where an ask on the summary lands: the conversation's thread, and how many turns run before it,
 * the one in progress and those queued. Only the turn that answers the ask may change the reviewer's summary.
 */
async function askPlace(bb: BbPluginApi, store: Store, targetKey: string): Promise<{ threadId: string | null; ahead: number; at: number }> {
  const threadId = store.getAssistantThread(targetKey);
  if (!threadId) return { threadId: null, ahead: 0, at: Date.now() };
  const [thread, queued] = await Promise.all([
    bb.sdk.threads.get({ threadId }).catch(() => null),
    bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => []),
  ]);
  const busy = thread?.status === "active" || thread?.status === "starting";
  return { threadId, ahead: (busy ? 1 : 0) + queued.length, at: Date.now() };
}

/**
 * Once the assistant's turn ends, it won't answer the discussions waiting for it,
 * unless a queued message starts another turn. Returns the review it settled.
 */
export async function settleDiscussions(bb: BbPluginApi, store: Store, threadId: string): Promise<string | null> {
  const targetKey = assistantReview(store, threadId);
  if (!targetKey || !store.listDiscussions(targetKey).some((d) => d.waiting)) return null;
  const queued = await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => []);
  if (queued.length) return null;
  return store.stopWaiting(targetKey) ? targetKey : null;
}
