import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { ThreadChat, useComposers, useRealtime, useRpc, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentMessage, AgentMessageContext } from "../src/store";
import type { AgentChoice } from "../src/agent";
import { contextLabel, contextQuote } from "../src/assistant-context";
import { composing } from "../lib/composing";
import { linkImages } from "../lib/link-images";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { clampRect, defaultRect, type Rect } from "../lib/dock-geometry";
import { agentDockKey } from "../lib/panel-state";
import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Badge, SpeakerMark } from "./ui/badge";

export interface DockInjection { context: AgentMessageContext; nonce: number; }
export interface AgentDockProps {
  targetKey: string;
  /** The review's patch, for quoting selected lines. */
  patch: string;
  injection?: DockInjection;
  /** Fullscreen root, so a popped-out widget remains in the visible subtree. */
  container?: HTMLElement | null;
  active?: boolean;
  /** It can pop out as a widget over the review; not on a phone, nor one held sideways. */
  popOut?: boolean;
  /** Its ✕'s name: "Close" in a phone's sheet. */
  closeLabel?: string;
  onDock?: () => void;
  onCollapse?: () => void;
}
interface Persisted { mode: "panel" | "widget"; rect: Rect; }
interface Conversation {
  threadId: string | null; legacy: AgentMessage[]; defaults: AgentChoice | null;
  /** The machine chosen in Review settings, when it isn't the bb server. */
  machine?: { name: string; connected: boolean } | null;
}
// bb's picker resolves the first provider's default model from an empty seed.
const UNSET_AGENT: AgentChoice = { providerId: "", model: "", reasoningLevel: "medium" };
function bounds() { return { width: window.innerWidth, height: window.innerHeight }; }
/** How far an arrow key moves or sizes the widget, or null for any other key. */
function arrowStep(key: string): { dx: number; dy: number } | null {
  const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[key];
  return step ? { dx: step[0], dy: step[1] } : null;
}
function loadPersisted(targetKey: string): Persisted | null {
  try { return JSON.parse(localStorage.getItem(agentDockKey(targetKey)) ?? "null"); }
  catch { return null; }
}

// This controller stays mounted when changing tabs or presentation. A review's
// conversation is a hidden bb thread shown with ThreadChat; until it exists, a
// first-message composer chooses its agent.
export const AgentDock = memo(function AgentDock({ targetKey, patch, injection, container, active = true, popOut = true, closeLabel = "Close panel", onDock, onCollapse }: AgentDockProps) {
  const rpc = useRpc<typeof rpcContract>();
  const composers = useComposers();
  const scopeProps = usePortalScopeProps();
  const persisted = useMemo(() => loadPersisted(targetKey), [targetKey]);
  const [chosenMode, setMode] = useState<"panel" | "widget">(persisted?.mode === "widget" ? "widget" : "panel");
  // Where it can't pop out, a widget chosen elsewhere shows in the panel, and is kept for there.
  const mode = popOut ? chosenMode : "panel";
  const [rect, setRect] = useState<Rect>(() => persisted?.rect && [persisted.rect.x, persisted.rect.y, persisted.rect.w, persisted.rect.h].every(Number.isFinite) ? clampRect(persisted.rect, bounds()) : defaultRect(bounds()));
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [agent, setAgent] = useState<AgentChoice>(UNSET_AGENT);
  const [input, setInput] = useState("");
  const [chip, setChip] = useState<AgentMessageContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const resetCancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const gestureCleanup = useRef<(() => void) | null>(null);
  const readRevision = useRef(0);
  // An injection from before this mount was already handled.
  const handledInjection = useRef(injection?.nonce ?? null);
  const visible = active || mode === "widget";
  const threadId = conversation?.threadId ?? null;
  const hostId = conversation?.defaults?.hostId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gestureCleanup.current?.(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(agentDockKey(targetKey), JSON.stringify({ mode: chosenMode, rect })); } catch { /* optional persistence */ }
  }, [targetKey, chosenMode, rect]);
  useEffect(() => {
    const resize = () => setRect((previous) => clampRect(previous, bounds()));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
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
  }, [visible, mode, threadId]);
  // Before the conversation exists, a selection becomes the first message's
  // context; afterwards it is quoted into bb's composer for the reviewer to edit.
  useEffect(() => {
    if (!injection || handledInjection.current === injection.nonce || !conversation) return;
    if (!threadId) {
      handledInjection.current = injection.nonce;
      setChip(injection.context);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === threadId);
    if (!composer) return; // ThreadChat's composer has not registered yet.
    handledInjection.current = injection.nonce;
    composer.insert(contextQuote(injection.context, patch), { at: "end", block: true });
    requestAnimationFrame(() => composer.focus());
  }, [injection, conversation, threadId, composers, patch]);

  async function start() {
    const message = input.trim();
    if (!message || locked.current || !conversation || !agent.providerId || !agent.model) return;
    locked.current = true; setBusy(true);
    try {
      const quote = chip ? contextQuote(chip, patch) : "";
      const result = await rpc.call("startConversation", { targetKey, text: quote ? `${message}\n\n${quote}` : message, agent });
      if (mounted.current) { setConversation({ ...conversation, threadId: result.threadId }); setInput(""); setChip(null); }
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
  function dock() { gestureCleanup.current?.(); setMode("panel"); onDock?.(); }
  function startGesture(event: React.PointerEvent, action: "move" | "resize") {
    event.preventDefault(); gestureCleanup.current?.();
    const start = { x: event.clientX, y: event.clientY, rect };
    const move = (event: PointerEvent) => {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      setRect(clampRect(action === "move" ? { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy } : { ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy }, bounds()));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish);
      gestureCleanup.current = null;
    };
    gestureCleanup.current = finish;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
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

  const panel = <>
    <div className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5", mode === "widget" && "cursor-move bg-surface-raised")} onPointerDown={mode === "widget" ? (event) => startGesture(event, "move") : undefined}>
      {mode === "widget"
        // The header drags it; from the keyboard, its mark moves it with the arrow keys, as its corner resizes it.
        ? <span role="button" tabIndex={0} aria-label="Move agent widget" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" title="Drag, or use the arrow keys, to move" onKeyDown={(event) => {
            const step = arrowStep(event.key);
            if (!step) return;
            event.preventDefault(); setRect((rect) => clampRect({ ...rect, x: rect.x + step.dx, y: rect.y + step.dy }, bounds()));
          }} className="flex rounded-sm focus-visible:outline focus-visible:outline-ring"><Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden /></span>
        : <Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden />}
      <h2 className="text-sm font-medium">Review agent</h2>
      {(threadId || conversation?.legacy.length) ? <Button ref={resetRef} variant="ghost" size="icon" className="ml-auto size-7 pointer-coarse:size-11" aria-label="New conversation" onPointerDown={(event) => event.stopPropagation()} onClick={() => setConfirmingReset(true)}><Icon name="MessageSquarePlus" className="size-3.5" aria-hidden /></Button> : null}
      {popOut && <Button variant="ghost" size="sm" className={cn("pointer-coarse:h-11", !(threadId || conversation?.legacy.length) && "ml-auto")} onPointerDown={(event) => event.stopPropagation()} onClick={mode === "widget" ? dock : () => setMode("widget")}>
        <Icon name={mode === "widget" ? "Minimize2" : "Maximize2"} className="size-3.5" aria-hidden />{mode === "widget" ? "Dock" : "Pop out"}
      </Button>}
      {mode === "panel" && onCollapse && <Button variant="ghost" size="icon" className={cn("size-8 text-muted-foreground pointer-coarse:size-11", !popOut && !(threadId || conversation?.legacy.length) && "ml-auto")} aria-label={closeLabel} onClick={onCollapse}><Icon name="X" aria-hidden /></Button>}
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
  </>;
  // Below z-50, where bb's own popovers (such as ThreadChat's model picker) open.
  const widget = mode === "widget" && createPortal(<div role="dialog" aria-label="Review agent" {...scopeProps} className="fixed z-[49] flex flex-col overflow-hidden rounded-lg border border-border shadow-2xl" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
    {panel}
    <div role="separator" tabIndex={0} aria-label="Resize agent widget" aria-orientation="horizontal" onPointerDown={(event) => startGesture(event, "resize")} onKeyDown={(event) => {
      const step = arrowStep(event.key);
      if (!step) return;
      event.preventDefault(); setRect((rect) => clampRect({ ...rect, w: rect.w + step.dx, h: rect.h + step.dy }, bounds()));
    }} className="absolute bottom-0 right-0 size-3 cursor-nwse-resize border-b-2 border-r-2 border-muted-foreground focus-visible:outline focus-visible:outline-ring" />
  </div>, container ?? document.body);
  return <>
    <section aria-label="Review agent" hidden={!active} className={cn("flex min-h-0 flex-1 flex-col", !active && "hidden")}>
      {mode === "panel" ? panel : <><div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5"><Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden /><h2 className="flex-1 text-sm font-medium">Review agent</h2>{onCollapse && <Button variant="ghost" size="icon" className="size-8 text-muted-foreground pointer-coarse:size-11" aria-label={closeLabel} onClick={onCollapse}><Icon name="X" aria-hidden /></Button>}</div><div className="space-y-3 p-3 text-sm"><p className="text-muted-foreground">The agent is popped out.</p><Button variant="outline" size="sm" className={TOUCH_CONTROL} onClick={dock}>Dock</Button></div></>}
    </section>
    {widget}
  </>;
});
AgentDock.displayName = "AgentDock";

/** Where the review `targetKey`'s agent was last put: popped out as a widget, or in the side panel. */
export function agentDockMode(targetKey: string): Persisted["mode"] {
  return loadPersisted(targetKey)?.mode === "widget" ? "widget" : "panel";
}
