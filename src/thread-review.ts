import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { assistantReview } from "./draft-comments";
import { ASSISTANT_TITLE } from "./agent";
import { GUIDE_WORKER_TITLE } from "./generate";

/** This plugin's agent threads being spawned, by the title each gets, until its id is recorded. */
const spawning = new WeakMap<BbPluginApi, Set<{ title: string; targetKey: string }>>();

/**
 * Runs a thread's spawn and the recording of its id. Until both finish, a thread with that title counts as the
 * review's, as BB may start its first session, and so ask for its instructions, before the spawn returns its id.
 */
export async function spawningFor<T>(bb: BbPluginApi, title: string, targetKey: string, run: () => Promise<T>): Promise<T> {
  const pending = { title, targetKey };
  const entries = spawning.get(bb) ?? new Set();
  spawning.set(bb, entries);
  entries.add(pending);
  try {
    return await run();
  } finally {
    entries.delete(pending);
  }
}

/**
 * The review a thread of this plugin belongs to: the one it's recorded as the assistant or guide writer of, or,
 * while a spawn with its exact title is in flight, that spawn's: NO_REVIEW for the Suggest instructions worker's. Never
 * its title or metadata alone, which it can write.
 */
export function threadReview(bb: BbPluginApi, store: Store, thread: { id: string; title: string | null }): string | null {
  const recorded = assistantReview(store, thread.id) ?? store.generationOf(thread.id);
  if (recorded) return recorded;
  for (const pending of spawning.get(bb) ?? []) if (pending.title === thread.title) return pending.targetKey;
  return null;
}

/**
 * What a thread of this plugin is: the assistant or guide writer it's recorded as, whatever its title now, or, only
 * while a spawn with its exact title is in flight, what that title names. Null for any other thread.
 */
export function threadRole(bb: BbPluginApi, store: Store, thread: { id: string; title: string | null }): "assistant" | "writer" | null {
  if (assistantReview(store, thread.id)) return "assistant";
  if (store.generationOf(thread.id)) return "writer";
  for (const pending of spawning.get(bb) ?? []) {
    if (pending.title !== thread.title) continue;
    if (pending.title.startsWith(GUIDE_WORKER_TITLE)) return "writer";
    if (pending.title.startsWith(ASSISTANT_TITLE)) return "assistant";
  }
  return null;
}

/** threadReview for a tool call, which has only the thread's id; its title is read only while a spawn is in flight. */
export async function toolThreadReview(bb: BbPluginApi, store: Store, threadId: string): Promise<string | null> {
  if (!spawning.get(bb)?.size) return threadReview(bb, store, { id: threadId, title: null });
  const title = await bb.sdk.threads.get({ threadId }).then((thread) => thread.title ?? null, () => null);
  return threadReview(bb, store, { id: threadId, title });
}

/** This plugin's threads, archived or not, hidden included, whose title is exactly `title`. */
export async function pluginThreadsTitled(bb: BbPluginApi, title: string): Promise<string[]> {
  const ids: string[] = [];
  const limit = 200;
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += limit) {
      const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived, limit, offset });
      for (const thread of page) if (thread.originPluginId === bb.pluginId && thread.title === title) ids.push(thread.id);
      if (page.length < limit) break;
    }
  }
  return ids;
}
