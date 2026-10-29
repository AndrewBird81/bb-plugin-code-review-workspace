// Who's asking in a review agent's turn (notes/design/E7-plan.md Part 2 §6): the reviewer typing in the review, one
// of their other threads relaying, or no one, as in a turn the plugin started. The write tools read it when they run.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Asking } from "./store";

/** The message the turn answers: its text, when it was sent, and the thread that relayed it. */
export interface TurnMessage { text: string; at: number; senderThreadId: string | null; initiator?: string; /** The row's messageSeq: which message it is. */ seq?: number }
/** Who's asking in the turn running on a review agent, and the newest message it carries; null when there's none. */
export interface Turn { asking: Asking; message: TurnMessage | null }
/** Who's asking on `threadId` now. Step 3.4 gives one that also knows the plugin's own messages. */
export type Classify = (threadId: string) => Promise<Turn>;

/** What's read of a timeline row; the SDK doesn't export its type. */
type Row = { kind: string; role?: string; initiator?: string; systemMessageKind?: string; text?: string; createdAt?: number; messageSeq?: number; senderThreadId?: string | null; children?: Row[] | null };

/** The newest message a person or a thread sent: never bb's own, such as a tool's result arriving. */
function newestMessage(rows: readonly Row[]): TurnMessage | null {
  let newest: TurnMessage | null = null;
  const visit = (row: Row) => {
    if (row.kind === "turn") { for (const child of row.children ?? []) visit(child); return; }
    if (row.kind !== "conversation" || row.role !== "user" || row.initiator === "system" || typeof row.createdAt !== "number") return;
    // bb's own rows, such as a tool's result arriving or a child thread's outcome.
    if (row.systemMessageKind && row.systemMessageKind !== "unlabeled") return;
    if (!newest || row.createdAt >= newest.at) newest = { text: row.text ?? "", at: row.createdAt, senderThreadId: row.senderThreadId ?? null, ...(row.initiator ? { initiator: row.initiator } : {}), ...(typeof row.messageSeq === "number" ? { seq: row.messageSeq } : {}) };
  };
  for (const row of rows) visit(row);
  return newest;
}

/**
 * Until step 3.4: a message relayed from another thread is relayed, and any other is direct, as typing in the review
 * is. The plugin's own messages read as typed ones too, so they count as direct here; 3.4 marks them. No message, or a
 * timeline that can't be read, is unattended.
 */
export function directOnly(bb: BbPluginApi): Classify {
  return async (threadId) => {
    let message: TurnMessage | null = null;
    try { message = newestMessage((await bb.sdk.threads.timeline({ threadId })).rows as unknown as Row[]); } catch { /* unread: no one asking */ }
    if (!message) return { asking: "unattended", message: null };
    // A thread's message whose sender isn't known is no one's to act on.
    if (message.initiator === "agent" && !message.senderThreadId) return { asking: "unattended", message };
    return { asking: message.senderThreadId ? "relayed" : "direct", message };
  };
}
