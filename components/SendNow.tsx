// Send now on a draft comment's card, and what a Send that warns shows before it goes: someone else's PR, a main thread
// archived or deleted, or a folder bb removed. The same warning, with its choices, shows in Finish review's Send.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { CommentLocation, DraftComment } from "../src/draft";
import type { FixerChoice, Offer } from "../src/loop";
import { cn } from "../lib/utils";
import { useWorkspaceFor } from "../lib/workspace-store";
import type { MainThreadName } from "../lib/workspace-context";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { Hint } from "./ui/hint";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

/** A Send that warned: why, what it offers, and with a fresh thread offered, where that starts; with a fork, of which thread. */
export interface SendWarned { warning: string; offers: Offer[]; freshWhere?: string; forkFrom?: string; choice?: FixerChoice }
/** Where a Send goes past its warning: anyway, or with its main thread unarchived, or to a fresh thread, or a fork. */
export type Choice = { force: true; thread?: "unarchive" | "fresh" | "fork" };
export const choiceOf = (offer: Offer): Choice => offer === "anyway" ? { force: true } : { force: true, thread: offer };

/**
 * Watch, a Send's toast action: the thread it went to, beside the review in BB's Main thread tab, or on a phone, held
 * either way, where BB's panel would cover the review anyway, its own page.
 */
export function useWatch(targetKey: string): (threadId: string) => { label: string; onClick: () => void } {
  const api = useWorkspaceFor(targetKey);
  const navigate = useBbNavigate();
  return (threadId) => ({ label: "Watch", onClick: () => api && api.layout.mode === "tablet" ? api.panel.open("main") : navigate.toThread(threadId) });
}

/** What a Send that went says, and to whom: queued behind a busy thread's turn, or sent. */
export function sentNote(delivery: "sent" | "queued", title: string | null, what: string): string {
  const to = title ?? "the main thread";
  return delivery === "queued" ? `Queued for ${to}: it’s busy, and gets ${what} when its turn ends.` : `Sent ${what} to ${to}.`;
}

/**
 * What a fixer's Send left out (keptLocal): comments not on GitHub yet, whose lines its PR's head hasn't. The fixer is
 * the main thread then, so no Send takes them until a thread in their folder is.
 */
export const keptLocalNote = (kept: number | undefined) => kept ? ` ${kept === 1 ? "1 isn’t on GitHub yet: change Main thread to a thread in its folder to send it." : `${kept} aren’t on GitHub yet: change Main thread to a thread in their folder to send them.`}` : "";

/** The focus goes to a warning's or choice's first button as it opens: the Send that opened it gives way to it. */
function useFirstButton(): RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button")?.focus(); }, []);
  return box;
}

const LABEL: Record<Exclude<Offer, "anyway">, string> = { unarchive: "Unarchive and send", fresh: "Start a fresh thread", fork: "Fork the original instead" };

/** Why a PR's Send asks where it goes, as its choice's lead says it. */
function choiceLead({ why, thread, folder }: FixerChoice): string {
  if (why === "archived") return `${thread ?? "The main thread"} is archived.`;
  if (why === "deleted") return `${thread ?? "The main thread"} was deleted.`;
  if (why === "folder-gone") return `BB removed the folder ${folder ?? "it worked in"}.`;
  return "No thread is working on this PR.";
}

/**
 * On a PR, where a Send goes when no thread can take it: a choice, not a warning. A lead names why and what goes
 * (`what`, "@dana’s review"), then each place with a line saying what it means, in the server's order, the first the
 * default: a fresh thread, a fork of the thread that wrote the PR, or the old thread unarchived. Anything else the Send
 * warned of, such as someone else's PR, comes first in the warning's tone.
 */
function SendChoice({ warned, choice, what, busy, onChoose, onCancel, className }: { warned: SendWarned; choice: FixerChoice; what: string; busy: boolean; onChoose: (choice: Choice) => void; onCancel: () => void; className?: string }) {
  const id = useId();
  const box = useFirstButton();
  // "3 comments" reads as these 3.
  const these = /^\d/.test(what) ? `these ${what}` : what;
  const line: Record<Exclude<Offer, "anyway">, string> = {
    fresh: `A new thread${choice.machine ? ` on ${choice.machine}` : ""}, told about the PR and ${these}.`,
    fork: `Keeps everything ${warned.forkFrom ?? "the original"} knew. Costs more: it copies the whole chat.`,
    unarchive: "Picks up the old thread where it stopped.",
  };
  const offers = warned.offers.filter((offer): offer is Exclude<Offer, "anyway"> => offer !== "anyway");
  return <div ref={box} role="group" aria-labelledby={`${id}-lead`} className={cn("space-y-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs leading-relaxed", className)}>
    {choice.note && <p className="flex gap-1.5 text-warning-text"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{choice.note}</span></p>}
    <p id={`${id}-lead`} role="status" className="font-medium text-foreground">{choiceLead(choice)} Where should {these} go?</p>
    <ul className="space-y-2">
      {offers.map((offer, i) => <li key={offer} className="space-y-0.5">
        <Button size="sm" variant={i ? "outline" : "default"} className={cn("aria-disabled:pointer-events-none aria-disabled:opacity-50", TOUCH_CONTROL)} aria-disabled={busy || undefined}
          aria-describedby={`${id}-${offer}`} onClick={() => { if (!busy) onChoose(choiceOf(offer)); }}>{LABEL[offer]}</Button>
        <p id={`${id}-${offer}`} className="text-muted-foreground">{line[offer]}</p>
      </li>)}
    </ul>
    <Button size="sm" variant="ghost" className={cn("-ml-2", TOUCH_CONTROL)} onClick={onCancel}>Cancel</Button>
  </div>;
}

/**
 * The warning a Send gave, with a button for each choice it offers and Cancel. `anyway` names the first: Send anyway,
 * Start anyway. Choosing one sends again with it. On a PR whose Send asks where it goes, that's a choice instead
 * (SendChoice), naming `what` it sends.
 */
export function SendWarning({ warned, busy, anyway = "Send anyway", what = "the comment", onChoose, onCancel, className }: { warned: SendWarned; busy: boolean; anyway?: string; what?: string; onChoose: (choice: Choice) => void; onCancel: () => void; className?: string }) {
  const box = useFirstButton();
  if (warned.choice) return <SendChoice warned={warned} choice={warned.choice} what={what} busy={busy} onChoose={onChoose} onCancel={onCancel} className={className} />;
  const label: Record<Offer, string> = { anyway, ...LABEL };
  return <div ref={box} role="alert" className={cn("space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text", className)}>
    <p className="flex gap-1.5"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{warned.warning}</span></p>
    <div className="flex flex-wrap gap-2">
      {warned.offers.map((offer, i) => <Button key={offer} size="sm" variant={i ? "outline" : "default"} className={cn("aria-disabled:pointer-events-none aria-disabled:opacity-50", TOUCH_CONTROL)} aria-disabled={busy || undefined}
        aria-description={offer === "fork" && warned.forkFrom ? `Forks ${warned.forkFrom}` : offer === "fresh" && warned.freshWhere ? `Starts it ${warned.freshWhere}` : undefined} onClick={() => { if (!busy) onChoose(choiceOf(offer)); }}>{label[offer]}</Button>)}
      <Button size="sm" variant="ghost" className={TOUCH_CONTROL} onClick={onCancel}>Cancel</Button>
    </div>
  </div>;
}

/** A draft comment that goes with the next Send: not sent since it was last changed, nor resolved or dismissed. */
export const isOpen = (comment: Pick<DraftComment, "state">) => !comment.state || comment.state === "open";

/**
 * The main thread a comment on `targetKey`'s cards would go to with Send now: while the review has one, with Send to
 * thread on, and the comment is open; else null.
 */
export function useSendable(targetKey: string | undefined, comment: Pick<DraftComment, "state">): MainThreadName | null {
  const mainThread = useWorkspaceFor(targetKey ?? null)?.mainThread ?? null;
  return targetKey && mainThread && isOpen(comment) ? mainThread : null;
}

/**
 * Where Send now sends, in its hint and its name: "Send now to Build snooze (main thread) on MaxBook"; on your own PR,
 * whose words it sends, "Send @dana’s comment to Build snooze (main thread)", or with no main thread, "to a fresh thread".
 */
export const sendNowLabel = (to: MainThreadName | null, what?: string) => `${what ? `Send ${what}` : "Send now"} to ${!to ? "a fresh thread" : to.title ? `${to.title} (main thread)` : "the main thread"}${to?.machine ? ` on ${to.machine}` : ""}`;

/**
 * Send now, a card's action: it sends the comment alone, a draft comment, or on your own PR a thread, review summary or
 * comment on GitHub (`comment.threadId`), named `what`, "@dana’s comment". With no main thread (`to` null), that Send
 * offers a fresh thread or a fork. What it warned, or why it failed, the card shows through `onNote`; a Send that went
 * says so in a toast, and its card then says Sent.
 */
export function SendNow({ targetKey, comment, to, what, className, onNote }: { targetKey: string; comment: CommentLocation | { threadId: string }; to: MainThreadName | null; what?: string; className?: string; onNote: (note: ReactNode) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const container = useFullscreenPortalContainer();
  const watch = useWatch(targetKey);
  const [busy, setBusy] = useState(false);
  const [warned, setWarned] = useState<SendWarned | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function send(choice?: Choice) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("sendNow", { targetKey, comment: "threadId" in comment ? { threadId: comment.threadId } : { file: comment.file, line: comment.line, side: comment.side }, ...choice });
      if (result.sent) {
        setWarned(null);
        toast.success(sentNote(result.sent.delivery, result.sent.title, what ?? "the comment"), { action: watch(result.sent.threadId) });
      } else if (result.warning) setWarned({ warning: result.warning, offers: result.offers ?? ["anyway"], freshWhere: result.freshWhere, forkFrom: result.forkFrom, choice: result.choice });
      else setError(result.error ?? "Couldn’t send it. Try again.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t send it. Try again.");
    } finally { setBusy(false); }
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    onNote(warned ? <SendWarning warned={warned} busy={busy} what={what} onChoose={(choice) => void sendRef.current(choice)} onCancel={() => setWarned(null)} />
      : error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null);
  }, [warned, error, busy, onNote, what]);
  // Gone, as once the comment is sent, it leaves nothing behind on the card.
  useEffect(() => () => onNote(null), [onNote]);
  const label = sendNowLabel(to, what);
  // One Send at a time: while its warning or choice is open, that's where you send from.
  if (warned) return null;
  return <Hint label={label} container={container}>
    <Button variant="ghost" size="sm" aria-label={label} className={className} aria-disabled={busy || undefined} onClick={() => void send()}>
      <Icon name={busy ? "Loading" : "Send"} className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")} aria-hidden />{what ? "Send" : "Send now"}
    </Button>
  </Hint>;
}
