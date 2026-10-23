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
    async get<T>(key: string): Promise<T | undefined> {
      return (memory.get(key) as T | undefined) ?? await kv?.get<T>(key).catch(() => undefined);
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

/** Why what GitHub took isn't recorded, and that sending it again finishes it. */
export function notRecorded(what: "review" | "reply", error: unknown, durable: boolean, url?: string): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  const again = what === "review" ? "Submit" : "Send";
  return `GitHub has your ${what}${url ? ` (${url})` : ""}, but it couldn't be recorded here: ${reason}. ${again} again to finish recording it: it won't be posted again.`
    + (durable ? "" : " Until then, don't reload the plugin, which would forget it was posted.");
}

export const replyReceiptKey = (targetKey: string, threadId: string) => `posted-reply:${targetKey}:${threadId}`;

/** A reply draft discarded, or saved as `body` other than the reply GitHub took, is no longer that reply: Send posts it. */
export async function forgetPostedReply(receipts: PostReceipts, targetKey: string, threadId: string, body?: string): Promise<void> {
  const key = replyReceiptKey(targetKey, threadId);
  if (body === undefined || (await receipts.get<{ body: string }>(key))?.body !== body) await receipts.drop(key);
}

/**
 * Post a reply that answers a drafted one, then clear that draft. A reply GitHub has whose draft couldn't be cleared is
 * finished by the next Send of the same text, without posting it again.
 */
export async function postDraftedReply(receipts: PostReceipts, store: AsyncStore, targetKey: string, threadId: string, body: string, post: () => Promise<{ ok: true } | { ok: false; error: string }>): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = replyReceiptKey(targetKey, threadId);
  const earlier = await receipts.get<{ body: string; at: number }>(key);
  let durable = true;
  if (earlier?.body !== body) {
    const posted = await post();
    if (!posted.ok) return posted;
    durable = await receipts.put(key, { body, at: Date.now() });
  }
  try {
    await recordPosted(() => store.deleteReplyDraft(targetKey, threadId));
  } catch (error) {
    // One found again is put in kv again, as it may be in memory alone.
    if (earlier?.body === body) durable = await receipts.put(key, earlier);
    return { ok: false, error: notRecorded("reply", error, durable) };
  }
  await receipts.drop(key);
  return { ok: true };
}
