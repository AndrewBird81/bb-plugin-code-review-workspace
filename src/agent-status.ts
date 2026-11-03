// The review agents' status in BB, for the reviews' rows (lib/review-indicator.ts), read from their hidden threads: BB's
// live thread list in the browser leaves hidden threads out. The rows hear when an agent starts, ends, fails or asks
// you, and opening a review reads its agent, as opening a thread does.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { agentStatus, type AgentStatus } from "../lib/review-indicator";
import { assistantReview } from "./draft-comments";
import type { EventListeners, RpcHandlers, ServeDeps } from "./server-modules";

/** BB lists at most 200 threads by id at a time. */
const PAGE = 200;

/** Each agent's status by its thread's id; none for an archived or deleted one, or while BB can't be read. */
export async function agentStatuses(bb: BbPluginApi, threadIds: readonly string[]): Promise<Map<string, AgentStatus>> {
  const statuses = new Map<string, AgentStatus>();
  try {
    for (let at = 0; at < threadIds.length; at += PAGE) {
      for (const row of await bb.sdk.threads.list({ threadIds: threadIds.slice(at, at + PAGE), includeHidden: true })) {
        const status = agentStatus(row);
        if (status) statuses.set(row.id, status);
      }
    }
  } catch (error) {
    bb.log.warn(`Could not read the review agents' status: ${String(error)}`);
  }
  return statuses;
}

export function register(deps: ServeDeps) {
  const { bb, store, changed } = deps;
  /** A review agent started, ended, failed, or asks you: its review's rows and page read its status again. */
  const told = async ({ thread }: { thread: { id: string } }) => {
    const targetKey = await assistantReview(store, thread.id);
    if (targetKey) changed(targetKey);
  };
  const handlers = {
    async readAgent({ targetKey }: { targetKey: string }) {
      const threadId = await store.getAssistantThread(targetKey);
      if (!threadId) return { ok: true };
      try {
        await bb.sdk.threads.markRead({ threadId });
      } catch {
        return { ok: false };
      }
      changed(targetKey);
      return { ok: true };
    },
  } satisfies Partial<RpcHandlers>;
  const events: EventListeners = { "thread.active": [told], "thread.idle": [told], "thread.failed": [told], "interaction.pending": [told] };
  return { handlers, events };
}
