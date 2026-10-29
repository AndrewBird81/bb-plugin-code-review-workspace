// Who's asking in a review agent's turn (notes/design/E7-plan.md Part 2 §6): the reviewer typing in the review, one
// of their other threads relaying, or no one, as in a turn the plugin started. The write tools read it when they run.
//
// It's read from bb's events, never its timeline, whose rows leave out agent-only parts and parse their senders from
// the text: the newest request bb gave the agent, with its parts, and the server's own `source`, `initiator` and
// `senderThreadId`. Every message the plugin sends a review agent goes through sendToAgent or spawnAgent, which add an
// agent-only part, `crw:<nonce>`, recorded in kv with who it's from until the first idle after it runs.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Asking } from "./store";
import type { EventListeners } from "./server-modules";
import { carries, insertLines } from "./post-preview";

/**
 * The message the turn answers: bb's id for its request, its text, when it was sent, and the thread that relayed it.
 * `inserted`: it carries text the plugin put in it, a quote or context the PR may have written, so it confirms no post.
 */
export interface TurnMessage { id: string; text: string; at: number; senderThreadId: string | null; inserted?: boolean }
/**
 * Who's asking in the turn running on a review agent, and the newest message it carries; null when there's none.
 * `joined`: that message came into a turn no one asked for, so what it asks for is shown before it's done.
 */
export interface Turn { asking: Asking; message: TurnMessage | null; joined?: boolean }
/** Who's asking on `threadId` now. */
export type Classify = (threadId: string) => Promise<Turn>;

/**
 * Whose a message the plugin sends a review agent is: a turn the plugin starts itself (automatic), what your click in the
 * review composed (ask), or what one of your other threads asked through `bb review` (relay).
 */
export type TurnKind = "automatic" | "ask" | "relay";
const ASKING: Record<TurnKind, Asking> = { automatic: "unattended", ask: "direct", relay: "relayed" };
const STRICTER: Record<Asking, number> = { direct: 0, relayed: 1, unattended: 2 };
const stricter = (a: Asking, b: Asking): Asking => STRICTER[a] >= STRICTER[b] ? a : b;

/**
 * How the plugin marks a message to a review agent: whose it is, the thread that relayed it, and what of it is your own
 * words, such as a discussion's text you typed; none, where the plugin composed it from the PR, as Dig deeper does.
 * `inserted`: the plugin put text in what you sent, a quote, context, or a box it filled, so it confirms no post.
 */
export interface Marking { kind: TurnKind; from?: string | null; said?: string; inserted?: boolean }
/** A message the plugin sent: the review agent it went to (null until a spawn returns it), how it's marked, and when it ran. */
interface Mark extends Marking { threadId: string | null; at: number; dispatchedAt?: number }
const LEDGER = "asking-marks";
/** The plugin's part, alone and first in an agent-only text: anything else agent-only is bb's own, such as a mention's context. */
const MARK = /^crw:([0-9a-f]{32})\b/;
const markText = (nonce: string) => `crw:${nonce} (Code Review Workspace marks its own messages with this line; ignore it.)`;
/** A mark not cleared by then, such as for a message queued on a machine that never came back, is dropped: its message reads as no one's. */
const KEPT_MS = 7 * 86_400_000;

const writes = new WeakMap<BbPluginApi, Promise<unknown>>();
/** Change the plugin's ledgers, one change at a time in the order asked, as events and sends arrive. */
function queued(bb: BbPluginApi, change: () => Promise<void>): Promise<void> {
  const write = (writes.get(bb) ?? Promise.resolve()).then(change);
  writes.set(bb, write.catch(() => {}));
  return write;
}
function update(bb: BbPluginApi, change: (marks: Record<string, Mark>) => void): Promise<void> {
  return queued(bb, async () => {
    const marks = await bb.storage.kv.get<Record<string, Mark>>(LEDGER) ?? {};
    change(marks);
    const now = Date.now();
    for (const [nonce, mark] of Object.entries(marks)) if (now - mark.at > KEPT_MS) delete marks[nonce];
    await bb.storage.kv.set(LEDGER, marks);
  });
}
async function readMarks(bb: BbPluginApi): Promise<Record<string, Mark>> {
  await writes.get(bb);
  return await bb.storage.kv.get<Record<string, Mark>>(LEDGER) ?? {};
}

/**
 * Text the plugin put in a review agent's composer, for you to edit and send: its lines, and when the newest message seen
 * carrying them was sent. A message carrying any of the lines confirms no post. Once one has been seen, a newer one you
 * typed without them shows it went with that one, and it goes; until then it stays, however the messages queued.
 */
interface Insert { id: string; lines: string[]; at: number; carriedAt?: number }
const INSERTS = "asking-inserts";
/** The inserts kept per thread: the newest. */
const MAX_INSERTS = 20;
function updateInserts(bb: BbPluginApi, change: (inserts: Record<string, Insert[]>) => void): Promise<void> {
  return queued(bb, async () => {
    const inserts = await bb.storage.kv.get<Record<string, Insert[]>>(INSERTS) ?? {};
    change(inserts);
    const now = Date.now();
    for (const [threadId, list] of Object.entries(inserts)) {
      const kept = list.filter((insert) => now - insert.at <= KEPT_MS).slice(-MAX_INSERTS);
      if (kept.length) inserts[threadId] = kept;
      else delete inserts[threadId];
    }
    await bb.storage.kv.set(INSERTS, inserts);
  });
}

/** Note that the plugin is putting `text` in `threadId`'s composer: called before it does, and failing, it mustn't. */
export async function noteInserted(bb: BbPluginApi, threadId: string, text: string): Promise<void> {
  const lines = insertLines(text);
  if (!lines.length) return;
  await updateInserts(bb, (inserts) => { (inserts[threadId] ??= []).push({ id: randomBytes(8).toString("hex"), lines, at: Date.now() }); });
}

/**
 * Whether `request`, unmarked, carries text the plugin put in `threadId`'s composer, noting when one that does was sent.
 * Read as the turn's newest message, a newer one you typed without an insert seen sent before retires it. Read as the
 * message that started the turn, which may be older than what's carried since, nothing retires.
 */
async function carriesInsert(bb: BbPluginApi, threadId: string, request: Request, newest: boolean): Promise<boolean> {
  await writes.get(bb);
  const inserts = (await bb.storage.kv.get<Record<string, Insert[]>>(INSERTS))?.[threadId] ?? [];
  const carried = inserts.filter((insert) => carries(request.text, insert.lines));
  const seen = new Set(carried.filter((insert) => (insert.carriedAt ?? -Infinity) < request.at).map((insert) => insert.id));
  const typed = newest && !request.senderThreadId && request.initiator !== "agent" && request.source !== "spawn";
  const gone = new Set(typed ? inserts.filter((insert) => !carried.includes(insert) && insert.carriedAt !== undefined && request.at > insert.carriedAt).map((insert) => insert.id) : []);
  if (seen.size || gone.size) {
    await updateInserts(bb, (all) => {
      if (all[threadId]) all[threadId] = all[threadId].filter((insert) => !gone.has(insert.id)).map((insert) => seen.has(insert.id) ? { ...insert, carriedAt: request.at } : insert);
    }).catch((error) => bb.log.warn(`Could not note text put in a review agent's composer: ${String(error)}`));
  }
  return carried.length > 0;
}
type Input = { type: string; text?: string; visibility?: string };
const noncesIn = (input: readonly Input[]) => input.flatMap((part) => part.type === "text" && part.visibility === "agent-only" ? part.text?.match(MARK)?.[1] ?? [] : []);

async function mark(bb: BbPluginApi, threadId: string | null, { kind, from, said, inserted }: Marking) {
  const nonce = randomBytes(16).toString("hex");
  await update(bb, (marks) => { marks[nonce] = { threadId, kind, at: Date.now(), ...(from === undefined ? {} : { from }), ...(said === undefined ? {} : { said }), ...(inserted ? { inserted } : {}) }; });
  return { nonce, part: { type: "text" as const, text: markText(nonce), mentions: [], visibility: "agent-only" as const } };
}
/**
 * The message with `nonce` is running, on `threadId`: its mark goes at the thread's next idle. One that can't be written
 * keeps the mark until it's dropped, and never fails what was sent.
 */
const ran = (bb: BbPluginApi, nonce: string, threadId?: string) => update(bb, (marks) => {
  const found = marks[nonce];
  if (found) marks[nonce] = { ...found, ...(threadId ? { threadId } : {}), dispatchedAt: Date.now() };
}).catch((error) => bb.log.warn(`Could not note a message to a review agent ran: ${String(error)}`));
const forget = (bb: BbPluginApi, nonce: string) => update(bb, (marks) => { delete marks[nonce]; }).catch(() => {});

type SendArgs = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

/** Send a review agent the plugin's message, marked as `marking` says. The only way the plugin sends one (src/agent-sends.test.ts checks). */
export async function sendToAgent(bb: BbPluginApi, args: SendArgs, marking: Marking) {
  const { nonce, part } = await mark(bb, args.threadId, marking);
  try {
    const sent = await bb.sdk.threads.send({ ...args, input: [...args.input, part] });
    // Queued, it runs once it dispatches, which message.dispatched tells.
    if (sent?.delivery !== "queued") await ran(bb, nonce);
    return sent;
  } catch (error) {
    await forget(bb, nonce);
    throw error;
  }
}

/** Spawn a review agent with the plugin's first message, marked as `marking` says. The only way the plugin spawns one. */
export async function spawnAgent(bb: BbPluginApi, args: SpawnArgs & { input: NonNullable<SpawnArgs["input"]> }, marking: Marking) {
  const { nonce, part } = await mark(bb, null, marking);
  try {
    const thread = await bb.sdk.threads.spawn({ ...args, input: [...args.input, part] });
    await ran(bb, nonce, thread.id);
    return thread;
  } catch (error) {
    await forget(bb, nonce);
    throw error;
  }
}

/**
 * The ledger's events: a queued message's mark starts counting once it dispatches, one deleted from the queue goes, and a
 * thread's marks that ran go at its first idle after, so a later turn that carries no new message is no one's.
 */
export function ledgerEvents(bb: BbPluginApi): EventListeners {
  return {
    "message.dispatched": [async ({ entry }) => { for (const nonce of noncesIn(entry.content)) await ran(bb, nonce, entry.threadId); }],
    "message.cancelled": [async ({ entry }) => { for (const nonce of noncesIn(entry.content)) await forget(bb, nonce); }],
    "thread.idle": [async ({ thread }) => {
      await update(bb, (marks) => {
        for (const [nonce, found] of Object.entries(marks)) if (found.threadId === thread.id && found.dispatchedAt !== undefined) delete marks[nonce];
      });
    }],
  };
}

/** A request to the agent, as bb's `client/turn/requested` event has it. */
export interface Request {
  id: string;
  at: number;
  source: string;
  initiator: string;
  senderThreadId: string | null;
  systemMessageKind: string | null;
  input: Input[];
  /** Its visible text, without the `[bb message from thread:…]` line bb starts a relayed message with. */
  text: string;
}
/** The request the running turn answers, and the one that started that turn: itself, or an earlier one. */
export interface Running { request: Request; starter: Request }
type Event = { type: string; createdAt: number; scope?: { kind?: string; turnId?: string }; data: Record<string, any> };
/** The most events bb gives in one page. */
const PAGE = 100;
const RELAYED_FROM = /^\[bb message from thread:[^\]\n]*\]\s*/;
/** bb's own rows, such as a tool's result arriving or a child's outcome: no one's asking. */
const bbOwn = (data: Record<string, any>) => data.initiator === "system" || (!!data.systemMessageKind && data.systemMessageKind !== "unlabeled");

function toRequest({ createdAt, data }: Event): Request {
  const input = (data.input ?? []) as Input[];
  const senderThreadId = (data.senderThreadId as string | null) ?? null;
  const shown = input.filter((part) => part.type === "text" && part.visibility !== "agent-only").map((part) => part.text ?? "").join("\n");
  return {
    id: data.requestId, at: createdAt, source: data.source, initiator: data.initiator, senderThreadId, systemMessageKind: data.systemMessageKind ?? null,
    input, text: senderThreadId ? shown.replace(RELAYED_FROM, "") : shown,
  };
}

/**
 * The turn running on `threadId`, from bb's newest page of requests and what it took of them into which turn: the newest
 * request of a person or a thread bb put in that turn, and the one that started the turn. Null when there's none to
 * read, the page doesn't say which turn or reaches back to its start, or bb itself started the turn, as with a tool's result arriving or a child's
 * outcome: no one asked for it.
 */
export async function latestRequest(bb: BbPluginApi, threadId: string): Promise<Running | null> {
  // bb refuses a page of more than 100 events.
  const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested", "turn/input/accepted"], order: "desc", limit: String(PAGE) }) as unknown as Event[];
  const requested = events.filter((e) => e.type === "client/turn/requested");
  const accepted = events.filter((e) => e.type === "turn/input/accepted");
  // The newest request bb took names the running turn.
  const turnId = accepted[0]?.scope?.turnId;
  if (turnId === undefined) return null;
  const inTurn = new Set(accepted.filter((e) => e.scope?.turnId === turnId).map((e) => e.data.clientRequestId as string));
  // A full page that ends inside the running turn may have left its start off: who started it can't be told.
  const oldest = events.at(-1);
  if (events.length >= PAGE && oldest && (oldest.type === "turn/input/accepted" ? oldest.scope?.turnId === turnId : inTurn.has(oldest.data.requestId))) return null;
  // Newest first: the last is the turn's start.
  const turn = requested.filter((e) => inTurn.has(e.data.requestId));
  const start = turn.at(-1);
  if (!start || bbOwn(start.data)) return null;
  const newest = turn.find((e) => !bbOwn(e.data))!;
  return { request: toRequest(newest), starter: toRequest(start) };
}

/**
 * Whether a thread is one of this plugin's agents, or one they started, as `ownThread` knows them by recorded id; null
 * when that can't be told, since its ancestors couldn't be read. A message from one, or a command it runs, is no one's.
 */
export function fromOwnAgent(bb: BbPluginApi, ownThread: (threadId: string) => boolean | Promise<boolean>): (threadId: string) => Promise<boolean | null> {
  return async (threadId) => {
    if (await ownThread(threadId)) return true;
    let ancestors: readonly string[] | undefined;
    try {
      ancestors = (await bb.sdk.threads.experimental_listAncestors?.({ threadIds: [threadId] }))?.threads.find((thread) => thread.threadId === threadId)?.ancestorIds;
    } catch { /* unread: can't be told */ }
    if (!ancestors) return null;
    for (const ancestor of ancestors) if (await ownThread(ancestor)) return true;
    return false;
  };
}

/**
 * Who's asking in the running turn, failing closed: a message the plugin marked counts as its kind while its mark lasts,
 * with only your own words in it as its text, and as no one's once it's gone or was never the plugin's. One carrying
 * text the plugin put in it, by its mark or from the composer, is `inserted`, and confirms no post. A spawn the
 * plugin didn't mark, no one's; a thread of this plugin's, or one below it, relaying, no one's; another thread relaying,
 * relayed; a thread's message with no sender, no one's; and else what you typed in the review. A turn bb started, or a
 * request that can't be read, is no one's. A message that joined a turn no one asked for, such as one typed into the
 * automatic review while it runs, is `joined`: what it asks for is shown first, since the agent may have been steered
 * before it came. `ownThread` says whether a thread is one of this plugin's agents, by its recorded id.
 */
export function createClassifier(bb: BbPluginApi, ownThread: (threadId: string) => boolean | Promise<boolean>): Classify {
  const own = fromOwnAgent(bb, ownThread);
  /** What a message relayed from `sender` counts as: one of the plugin's own threads, or one they started, isn't you. */
  const relayed = async (sender: string): Promise<Asking> => await own(sender) === false ? "relayed" : "unattended";
  /** Who's asking in `request`: the turn's newest message, or with `newest` false, the one that started it. */
  const asOf = async (threadId: string, request: Request, newest = true): Promise<{ asking: Asking; message: TurnMessage }> => {
    const message: TurnMessage = { id: request.id, text: request.text, at: request.at, senderThreadId: request.senderThreadId };
    let asking: Asking = "direct";
    const nonces = noncesIn(request.input);
    if (nonces.length) {
      const marks = await readMarks(bb).catch(() => ({} as Record<string, Mark>));
      // The plugin wrote the message, things the PR says included: what's yours of it is what the mark kept.
      const said: string[] = [];
      for (const nonce of nonces) {
        const found = marks[nonce];
        if (!found || (found.threadId !== null && found.threadId !== threadId)) { asking = "unattended"; continue; }
        asking = stricter(asking, ASKING[found.kind]);
        if (found.said) said.push(found.said);
        if (found.inserted) message.inserted = true;
        if (found.kind !== "relay") continue;
        message.senderThreadId = found.from ?? null;
        if (found.from) asking = stricter(asking, await relayed(found.from));
      }
      message.text = said.join("\n");
    } else {
      if (request.source === "spawn") asking = "unattended";
      // Typed in bb's composer, it may carry a quote the plugin put there; unread, it may.
      if (await carriesInsert(bb, threadId, request, newest).catch(() => true)) message.inserted = true;
    }
    if (request.senderThreadId) asking = stricter(asking, await relayed(request.senderThreadId));
    // A thread's message whose sender isn't known is no one's to act on.
    else if (request.initiator === "agent") asking = "unattended";
    return { asking, message };
  };
  return async (threadId) => {
    const running = await latestRequest(bb, threadId).catch(() => null);
    if (!running) return { asking: "unattended", message: null };
    const turn: Turn = await asOf(threadId, running.request);
    if (running.starter.id === running.request.id || turn.asking === "unattended") return turn;
    return (await asOf(threadId, running.starter, false)).asking === "unattended" ? { ...turn, joined: true } : turn;
  };
}
