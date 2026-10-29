import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { setTimeout as delay } from "node:timers/promises";
import type { Draft } from "./draft";
import type { AsyncStore } from "./store-queue";

/**
 * What GitHub took that the store hadn't recorded yet: written before recording it and dropped once it's recorded, so
 * a Submit or Send after a failed record finishes recording it instead of posting it a second time. Kept in bb's kv,
 * which needs no Postgres and outlasts a reload; in memory only when kv refuses it, as it does a value over 256 KB, or
 * there's none, as for a submitter a test makes.
 */
export function postReceipts(kv?: BbPluginApi["storage"]["kv"]) {
  const memory = new Map<string, unknown>();
  return {
    /** Keys of the replies being sent: a second Send of one meanwhile would find no receipt yet, and post it again. */
    sending: new Set<string>(),
    /** Throws when kv can't be read: taken for no receipt, it would post again what GitHub may have. */
    async get<T>(key: string): Promise<T | undefined> {
      if (memory.has(key)) return memory.get(key) as T;
      try {
        return await kv?.get<T>(key);
      } catch {
        throw new Error("Couldn't check whether GitHub already has this; try again.");
      }
    },
    /** False when only memory holds it. */
    async put(key: string, value: unknown): Promise<boolean> {
      try {
        if (!kv) throw new Error("no kv");
        await kv.set(key, value);
        memory.delete(key);
        return true;
      } catch {
        memory.set(key, value);
        return false;
      }
    },
    async drop(key: string): Promise<void> {
      memory.delete(key);
      await kv?.delete(key).catch(() => {});
    },
  };
}

export type PostReceipts = ReturnType<typeof postReceipts>;

/**
 * Text as a receipt keeps and matches it: with \n line endings and without the whitespace around it, as Send trims a
 * reply and the page saves the draft as typed. Every comparison of a draft's text with a receipt's goes through it.
 */
export const receiptText = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** A submitted review not yet recorded: how to record it, and the draft it posted, which recording clears. */
export interface ReviewReceipt { submittedAt: number; reviewId: string | null; headSha: string; reviewer?: string; url?: string; draft: Draft }

export const reviewReceiptKey = (targetKey: string) => `posted-review:${targetKey}`;

/** Recording what GitHub took, tried three times a second apart: a dropped connection usually connects again by then. */
export async function recordPosted(record: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await record();
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(1000);
    }
  }
}

/** Why what GitHub took isn't recorded, and that sending it again, unchanged, finishes it. */
export function notRecorded(what: "review" | "reply", error: unknown, durable: boolean, url?: string): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  const again = what === "review" ? "Submit" : "Send";
  return `GitHub has your ${what}${url ? ` (${url})` : ""}, but it couldn't be recorded here: ${reason}. ${again} again without changing the draft to finish recording it: it won't be posted again.`
    + (durable ? "" : " Until then, don't reload the plugin, which would forget it was posted.");
}

export const replyReceiptKey = (targetKey: string, threadId: string) => `posted-reply:${targetKey}:${threadId}`;
/**
 * How long a recorded reply's receipt still answers a Send of the same text: a page that gave up waiting on a reply GitHub
 * took later says it wasn't sent, and its Send again finishes as posted.
 */
export const RECORDED_REPLY_MS = 15 * 60_000;

/**
 * A reply draft discarded, or saved as `body` other than the reply GitHub took, is no longer that reply: Send posts it.
 * One kv can't read is kept, as Send matches it to the reply before taking it for the one GitHub has.
 */
export async function forgetPostedReply(receipts: PostReceipts, targetKey: string, threadId: string, body?: string): Promise<void> {
  const key = replyReceiptKey(targetKey, threadId);
  if (body === undefined) return receipts.drop(key);
  const posted = await receipts.get<{ body: string }>(key).catch(() => undefined);
  if (posted && receiptText(posted.body) !== receiptText(body)) await receipts.drop(key);
}

/**
 * Post a reply that answers a drafted one, then clear that draft. A reply GitHub has whose draft couldn't be cleared is
 * finished by the next Send of the same text, without posting it again. One posted and cleared in the last 15 minutes
 * (RECORDED_REPLY_MS) isn't posted again either: that Send answers `alreadyPosted`, leaving its draft, so the reviewer
 * sees it wasn't sent and can change it. A Send of it while one is sending is refused.
 */
export async function postDraftedReply(receipts: PostReceipts, store: AsyncStore, targetKey: string, threadId: string, body: string, post: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<{ ok: true; alreadyPosted?: true } | { ok: false; error: string }> {
  const key = replyReceiptKey(targetKey, threadId);
  if (receipts.sending.has(key)) return { ok: false, error: "This reply is already being sent." };
  receipts.sending.add(key);
  try {
    let earlier: { body: string; at: number; recorded?: boolean } | undefined;
    try {
      earlier = await receipts.get(key);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    const same = earlier !== undefined && receiptText(earlier.body) === receiptText(body) && (!earlier.recorded || Date.now() - earlier.at < RECORDED_REPLY_MS);
    if (same && earlier!.recorded) return { ok: true, alreadyPosted: true };
    let durable = true;
    if (!same) {
      const posted = await post();
      if (!posted.ok) return posted;
      durable = await receipts.put(key, { body: receiptText(body), at: Date.now() });
    }
    try {
      await recordPosted(() => store.deleteReplyDraft(targetKey, threadId));
    } catch (error) {
      // One found again is put in kv again, as it may be in memory alone.
      if (same) durable = await receipts.put(key, earlier);
      return { ok: false, error: notRecorded("reply", error, durable) };
    }
    await receipts.put(key, { body: receiptText(body), at: same ? earlier!.at : Date.now(), recorded: true });
    return { ok: true };
  } finally {
    receipts.sending.delete(key);
  }
}
