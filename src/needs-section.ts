// The BB thread section the thread list shows Needs review in. A real section, so BB drags, collapses, renames and hides
// it as it does any other; the plugin only puts review rows in it (components/NeedsReviewSidebar.tsx).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const KEY = "thread-list:needs-section";
export const NEEDS_SECTION_NAME = "Needs review";

let queue: Promise<unknown> = Promise.resolve();

/**
 * The section's id. The first call, or `recreate` once the reviewer deleted it, takes a section named Needs review, else
 * creates one. Later calls return the id kept, even of a deleted section: the page falls back to its own group then.
 * One at a time, so two windows loading at once make one section.
 */
export function needsSection(bb: BbPluginApi, recreate = false): Promise<string> {
  const run = queue.then(async () => {
    const kept = await bb.storage.kv.get<string>(KEY);
    if (kept && !recreate) return kept;
    const sections = await bb.sdk.threadSections.list();
    if (kept && sections.some((section) => section.id === kept)) return kept;
    const id = sections.find((section) => section.name === NEEDS_SECTION_NAME)?.id ?? (await bb.sdk.threadSections.create({ name: NEEDS_SECTION_NAME })).id;
    await bb.storage.kv.set(KEY, id);
    return id;
  });
  queue = run.catch(() => {});
  return run;
}
