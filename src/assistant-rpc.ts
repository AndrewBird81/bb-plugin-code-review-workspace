// The review assistant's conversation, and starting a new thread to fix comments; Send is the loop's (src/loop.ts).
import { endAssistantWaits, getConversation, newConversation, startConversation } from "./agent";
import { noteInserted } from "./asking";
import { startFixThread } from "./fix-handoff";
import { clearAsks } from "./asks";
import type { RpcHandlers, ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, sync } = deps;
  const handlers = {
    // Review assistant: a hidden bb thread per review, shown with ThreadChat
    getConversation({ targetKey }) {
      return getConversation(bb, store, targetKey);
    },
    // The dock's first message: what you typed, and the file or lines the plugin quoted after it.
    async startConversation({ targetKey, text, typed, inserted, agent }) {
      const yours = text === typed || text.startsWith(`${typed}\n\n`);
      const started = await startConversation(bb, store, { targetKey, text, agent, kind: "ask", said: yours ? typed : "", inserted: inserted || text !== typed });
      // Its other views, as the review's tab when it started on a thread's page, show the chat.
      bb.realtime.publish(`conversation:${targetKey}`, {});
      return started;
    },
    async noteInserted({ targetKey, threadId, text }) {
      if (await store.getAssistantThread(targetKey) !== threadId) throw new Error("The conversation changed. Try again.");
      await noteInserted(bb, threadId, text);
      return { ok: true as const };
    },
    async newConversation({ targetKey }) {
      await newConversation(bb, store, targetKey);
      // The archived conversation won't answer discussions or a feedback check waiting for it.
      const ended = await store.exclusive(async (tx) => {
        await clearAsks(tx, targetKey);
        return await endAssistantWaits(bb, tx, targetKey);
      });
      if (ended) await sync.evaluate(targetKey);
      return { ok: true };
    },
    startFixThread({ targetKey, comments, force }) {
      return startFixThread(bb, store, targetKey, comments, force);
    },
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
