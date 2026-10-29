// Send now on a draft comment's card, and what a Send that warns shows before it goes: someone else's PR, a main thread
// archived or deleted, or a folder bb removed. The same warning, with its choices, shows in Finish review's Send.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { CommentLocation, DraftComment } from "../src/draft";
import type { Offer } from "../src/loop";
import { cn } from "../lib/utils";
import { useWorkspaceFor } from "../lib/workspace-store";
import type { MainThreadName } from "../lib/workspace-context";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { Hint } from "./ui/hint";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

/** A Send that warned: why, what it offers, and with a fresh thread offered, where that starts. */
export interface SendWarned { warning: string; offers: Offer[]; freshWhere?: string }
/** Where a Send goes past its warning: anyway, or with its main thread unarchived, or to a fresh thread. */
export type Choice = { force: true; thread?: "unarchive" | "fresh" };
export const choiceOf = (offer: Offer): Choice => offer === "anyway" ? { force: true } : { force: true, thread: offer };

/** What a Send that went says, and to whom: queued behind a busy thread's turn, or sent. */
export function sentNote(delivery: "sent" | "queued", title: string | null, what: string): string {
  const to = title ?? "the main thread";
  return delivery === "queued" ? `Queued for ${to}: it’s busy, and gets ${what} when its turn ends.` : `Sent ${what} to ${to}.`;
}

/**
 * The warning a Send gave, with a button for each choice it offers and Cancel. `anyway` names the first: Send anyway,
 * Start anyway. Choosing one sends again with it.
 */
export function SendWarning({ warned, busy, anyway = "Send anyway", onChoose, onCancel, className }: { warned: SendWarned; busy: boolean; anyway?: string; onChoose: (choice: Choice) => void; onCancel: () => void; className?: string }) {
  const label: Record<Offer, string> = { anyway, unarchive: "Unarchive and send", fresh: "Start a fresh thread" };
  return <div role="alert" className={cn("space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text", className)}>
    <p className="flex gap-1.5"><Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{warned.warning}</span></p>
    <div className="flex flex-wrap gap-2">
      {warned.offers.map((offer, i) => <Button key={offer} size="sm" variant={i ? "outline" : "default"} className={cn("aria-disabled:pointer-events-none aria-disabled:opacity-50", TOUCH_CONTROL)} aria-disabled={busy || undefined} onClick={() => { if (!busy) onChoose(choiceOf(offer)); }}>{label[offer]}</Button>)}
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

/** Where Send now sends, in its hint and its name: "Send now to Build snooze (main thread) on MaxBook". */
export const sendNowLabel = (to: MainThreadName) => `Send now to ${to.title ? `${to.title} (main thread)` : "the main thread"}${to.machine ? ` on ${to.machine}` : ""}`;

/**
 * Send now, a card's action: it sends the comment alone. What it warned, or why it failed, the card shows through
 * `onNote`; a Send that went says so in a toast, and its card then says Sent.
 */
export function SendNow({ targetKey, comment, to, className, onNote }: { targetKey: string; comment: CommentLocation; to: MainThreadName; className?: string; onNote: (note: ReactNode) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const container = useFullscreenPortalContainer();
  const [busy, setBusy] = useState(false);
  const [warned, setWarned] = useState<SendWarned | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function send(choice?: Choice) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("sendNow", { targetKey, comment: { file: comment.file, line: comment.line, side: comment.side }, ...choice });
      if (result.sent) {
        setWarned(null);
        toast.success(sentNote(result.sent.delivery, result.sent.title, "the comment"));
      } else if (result.warning) setWarned({ warning: result.warning, offers: result.offers ?? ["anyway"] });
      else setError(result.error ?? "Couldn’t send it. Try again.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn’t send it. Try again.");
    } finally { setBusy(false); }
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    onNote(warned ? <SendWarning warned={warned} busy={busy} onChoose={(choice) => void sendRef.current(choice)} onCancel={() => setWarned(null)} />
      : error ? <p role="alert" className="text-xs text-destructive-text">{error}</p> : null);
  }, [warned, error, busy, onNote]);
  // Gone, as once the comment is sent, it leaves nothing behind on the card.
  useEffect(() => () => onNote(null), [onNote]);
  const label = sendNowLabel(to);
  return <Hint label={label} container={container}>
    <Button variant="ghost" size="sm" aria-label={label} className={className} aria-disabled={busy || undefined} onClick={() => void send()}>
      <Icon name={busy ? "Loading" : "Send"} className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")} aria-hidden />Send now
    </Button>
  </Hint>;
}
