// What a comment was before your Resolve or Dismiss click, kept in kv for that click's Undo (src/draft-rpc.ts): only
// what the server recorded then comes back, never a state the caller names. Kept until Undo, Reopen, Remove, the
// review's deletion, or UNDO_FOR_MS, whichever is first.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CommentLocation, CommentState, DraftComment } from "./draft";

/** How long after the click Undo can still put it back; the page offers it for 10 seconds. */
export const UNDO_FOR_MS = 10 * 60_000;
const PREFIX = "fix-undo:";

/** The comment as the click found it: its id, state, and words and lines, which an edit since changes. */
export type Before = { id: string | null; state: CommentState; at: number } & Pick<DraftComment, "body" | "startLine" | "startSide">;

type Kv = BbPluginApi["storage"]["kv"];
// The review first, so one review's keys share a prefix.
const keyOf = (targetKey: string, at?: CommentLocation) => `${PREFIX}${JSON.stringify(at ? [targetKey, at.file, at.line, at.side] : [targetKey]).slice(0, at ? undefined : -1)}${at ? "" : ","}`;

export async function rememberBefore(kv: Kv, targetKey: string, at: CommentLocation, before: Before) {
  await prune(kv);
  await kv.set(keyOf(targetKey, at), before);
}

export const readBefore = (kv: Kv, targetKey: string, at: CommentLocation) => kv.get<Before>(keyOf(targetKey, at));

/** Forget the comment's at `at`, or with no `at`, every one of the review's. */
export async function forgetBefore(kv: Kv, targetKey: string, at?: CommentLocation) {
  if (at) return void await kv.delete(keyOf(targetKey, at)).catch(() => {});
  for (const key of await kv.list(keyOf(targetKey)).catch(() => [] as string[])) await kv.delete(key).catch(() => {});
}

/** Drop what's past its Undo. */
async function prune(kv: Kv) {
  for (const key of await kv.list(PREFIX).catch(() => [] as string[])) {
    const before = await kv.get<Before>(key).catch(() => null);
    if (!before || Date.now() - before.at > UNDO_FOR_MS) await kv.delete(key).catch(() => {});
  }
}
