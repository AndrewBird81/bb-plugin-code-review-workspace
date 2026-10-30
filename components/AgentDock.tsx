import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ThreadChat, useComposers, useRealtime, useRpc, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentMessage, AgentMessageContext } from "../src/store";
import type { AgentChoice } from "../src/agent";
import { contextLabel, contextQuote } from "../src/assistant-context";
import { carries, insertLines } from "../src/post-preview";
import { composing } from "../lib/composing";
import { linkImages } from "../lib/link-images";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Badge, SpeakerMark } from "./ui/badge";

/** What to ask the agent about: `context`, quoted from the diff, or `quote`, text to quote as it is, such as a failing check. */
export interface DockInjection { context: AgentMessageContext; quote?: string; nonce: number; }
export interface AgentDockProps {
  targetKey: string;
  /** The review's id (lib/review-identity.ts), which its header names it by. */
  reviewId?: string;
  /** The review's patch, for quoting selected lines. */
  patch: string;
  injection?: DockInjection;
  /** Its tab shows in BB's side panel: it reads the conversation, and focuses its box, only then. */
  active?: boolean;
}
interface Conversation {
  threadId: string | null; legacy: AgentMessage[]; defaults: AgentChoice | null;
  /** The machine chosen in Review settings, when it isn't the bb server. */
  machine?: { name: string; connected: boolean } | null;
}
// The last ask each review's agent took, by its nonce: the tab can mount after the ask that opens it, and mount again
// with BB's panel, and takes each ask once.
const handledInjections = new Map<string, number>();

/** A first message being written: what's typed, its context, and the quotes put in it. */
interface FirstDraft { input: string; chip: AgentMessageContext | null; quoted: string[] }
// Each review's first message as it's written, kept for this page's life: through the review switching, and BB closing
// its panel, which BB 0.48 does by unmounting the tab (seen in its e2e; later BBs say they keep it mounted).
const firstDrafts = new Map<string, FirstDraft>();

/** For tests: forget every first message being written, and every ask taken. */
export function forgetAgentDrafts() { firstDrafts.clear(); handledInjections.clear(); }

// bb's picker resolves the first provider's default model from an empty seed.
const UNSET_AGENT: AgentChoice = { providerId: "", model: "", reasoningLevel: "medium" };
// The Review agent tab in BB's side panel (components/PanelTabs.tsx), mounted again for each review it shows, and by BB
// 0.48 each time its panel opens. A review's conversation is a hidden bb thread shown with ThreadChat; until it exists, a
// first-message composer chooses its agent.
export const AgentDock = memo(function AgentDock({ targetKey, reviewId, patch, injection, active = true }: AgentDockProps) {
  const rpc = useRpc<typeof rpcContract>();
  const composers = useComposers();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [agent, setAgent] = useState<AgentChoice>(UNSET_AGENT);
  const [kept] = useState(() => firstDrafts.get(targetKey));
  const [input, setInput] = useState(kept?.input ?? "");
  const [chip, setChip] = useState<AgentMessageContext | null>(kept?.chip ?? null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const resetCancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const readRevision = useRef(0);
  // Quotes put in the first message's box: a message still carrying one confirms no post (src/asking.ts).
  const quoted = useRef<string[]>(kept?.quoted ?? []);
  useEffect(() => {
    if (input || chip) firstDrafts.set(targetKey, { input, chip, quoted: quoted.current });
    else firstDrafts.delete(targetKey);
  }, [targetKey, input, chip]);
  const visible = active;
  const threadId = conversation?.threadId ?? null;
  const hostId = conversation?.defaults?.hostId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const load = useCallback(async () => {
    const revision = ++readRevision.current;
    try {
      const result = await rpc.call("getConversation", { targetKey });
      if (!mounted.current || revision !== readRevision.current) return;
      setConversation(result as Conversation);
      if (!result.threadId) setAgent(result.defaults ?? UNSET_AGENT);
      setLoadError(false);
    } catch { if (mounted.current && revision === readRevision.current) setLoadError(true); }
  }, [rpc, targetKey]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  // Asking the agent from the diff can start the conversation.
  useRealtime(`conversation:${targetKey}`, load);
  useEffect(() => {
    if (!visible || threadId) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, threadId]);
  // Before the conversation exists, a selection becomes the first message's
  // context; afterwards it is quoted into bb's composer for the reviewer to edit.
  useEffect(() => {
    if (!injection || handledInjections.get(targetKey) === injection.nonce || !conversation) return;
    if (!threadId) {
      handledInjections.set(targetKey, injection.nonce);
      const { quote } = injection;
      // A quote goes into the first message's box, unsent, after anything typed there.
      if (quote) {
        quoted.current.push(quote);
        setInput((typed) => typed.trim() ? `${typed.trimEnd()}\n\n${quote}` : quote);
      } else setChip(injection.context);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === threadId);
    if (!composer) return; // ThreadChat's composer has not registered yet.
    handledInjections.set(targetKey, injection.nonce);
    const text = injection.quote ?? contextQuote(injection.context, patch);
    // Nothing to quote, as with no file in view: Ask agent only opens the chat, its box focused.
    if (!text) { requestAnimationFrame(() => composer.focus()); return; }
    // Noted first, so the message that carries it confirms no post (src/asking.ts); unnoted, it isn't put there.
    rpc.call("noteInserted", { targetKey, threadId, text }).then(() => {
      composer.insert(text, { at: "end", block: true });
      requestAnimationFrame(() => composer.focus());
    }, () => toast.error("Couldn’t add that to the chat. Try again."));
  }, [injection, conversation, threadId, composers, patch, rpc, targetKey]);

  async function start() {
    const message = input.trim();
    if (!message || locked.current || !conversation || !agent.providerId || !agent.model) return;
    locked.current = true; setBusy(true);
    try {
      const quote = chip ? contextQuote(chip, patch) : "";
      const inserted = !!quote || quoted.current.some((text) => carries(message, insertLines(text)));
      const result = await rpc.call("startConversation", { targetKey, text: quote ? `${message}\n\n${quote}` : message, typed: message, inserted, agent });
      if (mounted.current) { setConversation({ ...conversation, threadId: result.threadId }); setInput(""); setChip(null); quoted.current = []; }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The agent couldn’t start");
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // New conversation's confirmation takes the focus, as it asks; cancelling gives it back.
  useEffect(() => { if (confirmingReset) resetCancelRef.current?.focus(); }, [confirmingReset]);
  function cancelReset() {
    setConfirmingReset(false);
    requestAnimationFrame(() => resetRef.current?.focus());
  }
  async function reset() {
    setConfirmingReset(false);
    try { await rpc.call("newConversation", { targetKey }); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn’t start a new conversation"); }
    await load();
  }
  const legacy = conversation?.legacy.length ? <div className="space-y-4 p-3">
    <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground"><span className="h-px flex-1 bg-border" />Earlier conversation<span className="h-px flex-1 bg-border" /></p>
    {conversation.legacy.map((message) => message.role === "user"
      ? <div key={message.id} className="flex flex-col items-end gap-1">
          {message.context && <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground">{contextLabel(message.context)}</span>}
          <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm leading-relaxed ring-1 ring-inset ring-primary/20">{message.text}</p>
        </div>
      : <div key={message.id} className="space-y-1">
          <span className="flex items-center gap-1.5 text-xs font-medium"><SpeakerMark agent />Agent</span>
          <div className="pl-6"><Markdown content={linkImages(message.text)} className="text-sm leading-relaxed" /></div>
        </div>)}
  </div> : undefined;
  const firstMessage = <>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col items-center gap-2 px-4 pb-2 pt-6 text-center">
        <span aria-hidden className="flex size-11 items-center justify-center rounded-2xl bg-(--ansi-13)/10 text-(--ansi-13) ring-1 ring-inset ring-(--ansi-13)/25"><Icon name="Sparkles" className="size-5" /></span>
        <p className="text-sm font-medium">Ask about this change.</p>
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">Discuss a file, check a risk, or select lines in the diff for a focused question. Your conversation stays with this review.</p>
      </div>
      {legacy}
    </div>
    <div className="shrink-0 space-y-2 border-t border-border bg-surface-raised p-3">
      {chip && <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">Context</span><Badge tone="primary" className="min-w-0 font-mono" icon={<Icon name="File" aria-hidden />}><span className="truncate">{contextLabel(chip)}</span></Badge><Button variant="ghost" size="sm" className={cn("relative h-6 px-1", TOUCH_TARGET)} aria-label="Clear selection context" onClick={() => setChip(null)}><Icon name="X" className="size-3" aria-hidden /></Button></div>}
      <Textarea ref={composerRef} aria-label="Ask the agent" disabled={busy} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !composing(event)) { event.preventDefault(); void start(); }
      }} placeholder="Ask the agent…" className="max-h-32 min-h-20 resize-none rounded-lg bg-background text-sm focus-visible:border-(--ansi-13)/50 focus-visible:ring-[3px] focus-visible:ring-(--ansi-13)/15" />
      <div className="flex min-w-0 items-center gap-2">
        {/* The SDK's types list the reasoning levels it knew; a provider's own passes through (lib/review-preferences.ts). */}
        <ProviderModelPicker value={agent as ComponentProps<typeof ProviderModelPicker>["value"]} onChange={(next) => setAgent({ ...(hostId ? { hostId } : {}), ...next })} routing={hostId ? { kind: "host", hostId } : undefined} disabled={busy} className="min-w-0" />
        {conversation?.machine && <span className="min-w-0 truncate text-xs text-muted-foreground">{conversation.machine.connected ? `on ${conversation.machine.name}` : `${conversation.machine.name} is offline`}</span>}
        <Button size="sm" className="ml-auto size-8 rounded-lg p-0 pointer-coarse:size-11" disabled={busy || !input.trim() || !agent.providerId || !agent.model} onClick={() => void start()} aria-label="Send"><Icon name={busy ? "Loading" : "ArrowUp"} className={cn("size-4", busy && "animate-spin motion-reduce:animate-none")} aria-hidden /></Button>
      </div>
    </div>
  </>;
  const body = loadError
    ? <div role="alert" className="m-3 space-y-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive-text"><p>Couldn’t load the conversation.</p><Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => void load()}>Retry conversation</Button></div>
    : !conversation ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading conversation…</p>
    : threadId ? <ThreadChat threadId={threadId} variant="compact" className="min-h-0 flex-1" leadingContent={legacy} />
    : firstMessage;

  return <section aria-label="Review agent" className="flex h-full min-h-0 flex-1 flex-col">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
      <Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden />
      <h2 className="flex min-w-0 items-baseline gap-1.5 text-sm font-medium"><span className="shrink-0">Review agent</span>{reviewId && <><span aria-hidden className="text-subtle-foreground">·</span><span className="truncate font-mono text-[11px] font-normal text-muted-foreground">{reviewId}</span></>}</h2>
      {(threadId || conversation?.legacy.length) ? <Button ref={resetRef} variant="ghost" size="icon" className="ml-auto size-7 pointer-coarse:size-11" aria-label="New conversation" onClick={() => setConfirmingReset(true)}><Icon name="MessageSquarePlus" className="size-3.5" aria-hidden /></Button> : null}
    </div>
    {confirmingReset && <div role="alertdialog" aria-label="Start a new conversation" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); cancelReset();
    }} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/20 bg-warning/10 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">Archive this conversation and start a new one?</span>
      <Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={() => void reset()}>Start new</Button>
      <Button ref={resetCancelRef} variant="ghost" size="sm" className={TOUCH_CONTROL} onClick={cancelReset}>Cancel</Button>
    </div>}
    {body}
  </section>;
});
AgentDock.displayName = "AgentDock";
