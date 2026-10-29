// A review agent's chat as bb's events give it to the plugin (`threads.events.list`): each message a request, and bb
// taking it into a turn, a new one unless it joins the running one. What the plugin sends or spawns lands in it too,
// marks and all, as bb would deliver it.
import { expect } from "vitest";

type Part = { type: "text"; text: string; mentions?: unknown[]; visibility?: "agent-only" };
export interface Said {
  parts?: Part[];
  at?: number;
  /** The thread that relayed it, as `bb thread tell` sets it. */
  sender?: string | null;
  source?: "spawn" | "tell";
  initiator?: "user" | "agent" | "system";
  systemMessageKind?: string;
  /** false: still pending, as a steer bb hasn't taken yet. */
  accepted?: boolean;
  /** Taken into the running turn, as a message typed while the agent works, or a tool's result arriving: not a new turn. */
  joins?: boolean;
}

export function agentChat(threadId = "agent") {
  let seq = 0;
  const events: Array<{ id: string; seq: number; threadId: string; createdAt: number; type: string; scope: { kind: string; turnId?: string }; data: Record<string, unknown> }> = [];
  let turns = 0;
  /** Each thread's ancestors, as bb lists them: none unless a test says; null, a thread bb leaves out, as unknown. */
  const ancestors: Record<string, string[] | null> = {};
  /** The messages queued behind a busy agent, by their queue id, until dispatched. */
  const queue = new Map<string, Part[]>();
  let busy = false;
  const push = (said: Said) => {
    const requestId = `creq_${++seq}`;
    const createdAt = said.at ?? Date.now();
    events.push({ id: `evt_${seq}`, seq, threadId, createdAt, type: "client/turn/requested", scope: { kind: "thread" }, data: {
      requestId, source: said.source ?? "tell", initiator: said.initiator ?? (said.sender ? "agent" : "user"), senderThreadId: said.sender ?? null,
      systemMessageKind: said.systemMessageKind ?? "unlabeled", input: said.parts ?? [],
    } });
    if (said.accepted !== false) {
      const turnId = `turn-${said.joins && turns ? turns : ++turns}`;
      events.push({ id: `evt_${++seq}`, seq, threadId, createdAt, type: "turn/input/accepted", scope: { kind: "turn", turnId }, data: { clientRequestId: requestId } });
    }
    return requestId;
  };
  return {
    /** You, or a thread with `sender`, say `text` in the agent's chat. */
    say: (text: string, said: Said = {}) => push({ parts: [{ type: "text", text, mentions: [] }], ...said }),
    /** A message with these exact parts. */
    request: (said: Said) => push(said),
    /** The events, newest first as the plugin asks for them. */
    events,
    ancestors,
    /** While busy, what the plugin sends queues, until dispatch. */
    busy: (on: boolean) => { busy = on; },
    /** Dispatch a queued message: it becomes the agent's newest. Returns the queue entry message.dispatched carries. */
    dispatch: (id: string) => {
      const content = queue.get(id)!;
      queue.delete(id);
      push({ parts: content });
      return { id, threadId, content };
    },
    queued: () => [...queue.keys()],
    /** No message at all, as in a turn no one started. */
    clear: () => { events.length = 0; },
    /** A queued message's queue entry, as message.cancelled carries it, deleting it from the queue. */
    cancel: (id: string) => {
      const content = queue.get(id)!;
      queue.delete(id);
      return { id, threadId, content };
    },
    /** bb's threads.send, threads.spawn and threads.events, for createFakePluginHost's sdk.threads. */
    sdk: {
      send: async (args: { threadId: string; input: Part[] }) => {
        if (!busy) { push({ parts: args.input }); return { ok: true, delivery: "sent" }; }
        const id = `q${queue.size + 1}`;
        queue.set(id, args.input);
        return { ok: true, delivery: "queued", queuedMessage: { id } };
      },
      spawn: async (args: { input: Part[] }) => { push({ parts: args.input, source: "spawn" }); return { id: threadId }; },
      events: { list: async ({ order, types, limit }: { order?: string; types?: string[]; limit?: string }) => {
        const listed = events.filter((e) => !types || types.includes(e.type));
        return (order === "desc" ? listed.reverse() : listed).slice(0, limit === undefined ? undefined : Number(limit));
      } },
      experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.filter((id) => ancestors[id] !== null).map((id) => ({ threadId: id, ancestorIds: ancestors[id] ?? [] })) }),
    },
  };
}

/** The part the plugin marks each message to a review agent with (src/asking.ts), as a test expects it. */
export const MARK_PART = { type: "text", text: expect.stringMatching(/^crw:[0-9a-f]{32} /), mentions: [], visibility: "agent-only" };
