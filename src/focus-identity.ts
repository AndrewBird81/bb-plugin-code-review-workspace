import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FocusThread } from "./focus-model";
import type { AsyncStore } from "./store-queue";

type Identity = Pick<FocusThread, "targetKey" | "runId" | "focusId" | "label">;
const focusSpawning = new WeakMap<BbPluginApi, Set<Identity & { title: string }>>();

/** Keep identity from session start until the row commits; never enter the assistant/writer spawn set. */
export async function focusSpawningFor<T>(bb: BbPluginApi, title: string, identity: Identity, run: () => Promise<T>): Promise<T> {
  const entries = focusSpawning.get(bb) ?? new Set();
  focusSpawning.set(bb, entries);
  const entry = { ...identity, title };
  entries.add(entry);
  try { return await run(); } finally { entries.delete(entry); }
}
export function focusSpawnTitled(bb: BbPluginApi, title: string | null): Identity | null {
  return [...focusSpawning.get(bb) ?? []].find((entry) => entry.title === title) ?? null;
}
export async function focusInFlightTitle(bb: BbPluginApi, threadId: string): Promise<string | null> {
  if (!focusSpawning.get(bb)?.size) return null;
  return bb.sdk.threads.get({ threadId }).then((thread) => thread.title ?? null, () => null);
}
export async function focusThread(bb: BbPluginApi, store: AsyncStore, threadId: string): Promise<Identity | null> {
  const recorded = (await store.listFocusThreads()).find((thread) => thread.threadId === threadId);
  if (recorded) return recorded;
  const title = await focusInFlightTitle(bb, threadId);
  return focusSpawnTitled(bb, title);
}
