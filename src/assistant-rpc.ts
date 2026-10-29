// The review assistant's conversation, and sending comments to a fix thread or to the thread the change came from.
import { endAssistantWaits, getConversation, newConversation, startConversation } from "./agent";
import { noteInserted } from "./asking";
import { sendApprovalToSourceThread, sendToSourceThread, sourceThread, startFixThread } from "./fix-handoff";
import { clearAsks } from "./asks";
import type { RpcHandlers, ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, sync, changed } = deps;
  const handlers = {
    // Review assistant: a hidden bb thread per review, shown with ThreadChat
    getConversation({ targetKey }) {
      return getConversation(bb, store, targetKey);
    },
    // The dock's first message: what you typed, and the file or lines the plugin quoted after it.
    startConversation({ targetKey, text, typed, inserted, agent }) {
      const yours = text === typed || text.startsWith(`${typed}\n\n`);
      return startConversation(bb, store, { targetKey, text, agent, kind: "ask", said: yours ? typed : "", inserted: inserted || text !== typed });
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
    startFixThread({ targetKey, comments }) {
      return startFixThread(bb, store, targetKey, comments);
    },
    async getSourceThread({ targetKey }) {
      if (!(await store.getPreferences()).preferences.knobs.sendToThread) return { thread: null };
      return { thread: await sourceThread(bb, store, targetKey) };
    },
    async sendToSourceThread({ targetKey, comments, message, includeSummary }) {
      if (!(await store.getPreferences()).preferences.knobs.sendToThread) throw new Error("Send to thread is off in Review settings.");
      const result = await sendToSourceThread(bb, store, targetKey, comments, { message, includeSummary });
      changed(targetKey);
      return result;
    },
    async sendApprovalToSourceThread({ targetKey, revision, message, includeSummary }) {
      if (!(await store.getPreferences()).preferences.knobs.sendToThread) throw new Error("Send to thread is off in Review settings.");
      const result = await sendApprovalToSourceThread(bb, store, targetKey, revision, { message, includeSummary });
      changed(targetKey);
      return result;
    },
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
