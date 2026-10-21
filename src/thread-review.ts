import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assistantReview } from "./draft-comments";
import type { AsyncStore } from "./store-queue";

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

/** The spawns in flight titled exactly `title`, oldest first. */
export function spawnsTitled(bb: BbPluginApi, title: string | null): Array<{ title: string; targetKey: string }> {
  return [...spawning.get(bb) ?? []].filter((pending) => pending.title === title);
}

/**
 * The review a thread of this plugin belongs to: the one it's recorded as the assistant or guide writer of, or,
 * while a spawn with its exact title is in flight, that spawn's: NO_REVIEW for the Suggest instructions worker's. Never
 * its title or metadata alone, which it can write.
 */
export async function threadReview(bb: BbPluginApi, store: AsyncStore, thread: { id: string; title: string | null }): Promise<string | null> {
  return store.exclusive(async (tx) => {
    const recorded = await assistantReview(tx, thread.id) ?? await tx.generationOf(thread.id);
    if (recorded) return recorded;
    return spawnsTitled(bb, thread.title)[0]?.targetKey ?? null;
  });
}

/** threadReview for a tool call, which has only the thread's id; its title is read only while a spawn is in flight. */
export async function toolThreadReview(bb: BbPluginApi, store: AsyncStore, threadId: string): Promise<string | null> {
  if (!spawning.get(bb)?.size) return await threadReview(bb, store, { id: threadId, title: null });
  const title = await bb.sdk.threads.get({ threadId }).then((thread) => thread.title ?? null, () => null);
  return await threadReview(bb, store, { id: threadId, title });
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
