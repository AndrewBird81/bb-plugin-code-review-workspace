import { useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { ReviewLifecycle } from "../../src/store";
import { checkedText, countedText, finishedText, fixesState, reported } from "../../lib/fixes";
import { useKnob } from "../../lib/settings";
import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { useDraft } from "../DraftProvider";
import { usesFixer } from "../../lib/fixer";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { keptLocalNote, SendWarning, type Choice, type SendWarned } from "../SendNow";
import type { Notice } from "./ReviewNotices";

/** The review, as its fixes' notice reads it. */
type Reviewed = Pick<ReviewLifecycle, "sends" | "fixes" | "verifyingSince" | "verifyingFixes" | "archivedAt" | "userArchivedAt">;

/** What Check fixes, and Check now, do: said beside the button, and to screen readers. */
export const CHECK_FIXES = "The review agent checks each sent comment against the code.";

const BUTTON = cn("h-7", TOUCH_CONTROL);

/**
 * Send the rest to a fresh thread: the comments the main thread, archived or deleted, didn't report, sent again to a
 * fresh thread, which then is the main thread. Inside the draft, whose comments it sends. On your own PR with no folder
 * of its own, the GitHub threads and summaries it didn't report go too, and the Send asks where, as any of its Sends
 * does there: a fresh fixer at the PR's head, or a fork of the thread that wrote it.
 */
function SendRest({ targetKey, onChanged }: { targetKey: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { draft, load, review } = useDraft();
  const [busy, setBusy] = useState(false);
  const [warned, setWarned] = useState<SendWarned | null>(null);
  const rest = draft.comments.filter((comment) => comment.state === "sent" && !reported(comment.claim));
  const own = review?.kind === "pr" && review.ownPr === true;
  const threads = own ? Object.entries(review.threadSends ?? {}).filter(([, sent]) => !reported(sent.claim)).map(([id]) => id) : [];
  // A fixer's choice, as every Send to a fixer asks.
  const fixer = own && usesFixer(review);
  const count = rest.length + threads.length;
  if (!count) return null;
  const what = `${count} comment${count === 1 ? "" : "s"}`;
  const send = async (choice?: Choice) => {
    if (busy) return;
    setBusy(true);
    try {
      // You sent them once, past any warning; a fresh thread is the choice the main thread's state leaves, and on your
      // PR, a fresh fixer or a fork, which it asks.
      const result = await rpc.call("sendToSourceThread", {
        targetKey, comments: rest.map(({ file, line, side }) => ({ file, line, side })), ...threads.length ? { threads } : {},
        force: true, ...choice?.thread ? { thread: choice.thread } : fixer ? {} : { thread: "fresh" },
      });
      if (!result.ok && result.choice) setWarned({ warning: result.warning, offers: result.offers ?? ["fresh"], freshWhere: result.freshWhere, forkFrom: result.forkFrom, choice: result.choice });
      else if (!result.ok) toast.error(result.warning);
      else {
        setWarned(null);
        // What the review no longer has can't go: said plainly, as there's no getting it back.
        const sentCount = count - (result.skipped ?? 0) - (result.keptLocal ?? 0);
        toast.success(`Sent ${sentCount} comment${sentCount === 1 ? "" : "s"} to ${result.title ?? "a fresh thread"}.${result.skipped ? ` ${result.skipped === 1 ? "1 other isn’t" : `${result.skipped} others aren’t`} on GitHub as the review last read it, so ${result.skipped === 1 ? "it" : "they"} didn’t go.` : ""}${keptLocalNote(result.keptLocal)}`);
        onChanged();
        void load();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t send them.");
    } finally {
      setBusy(false);
    }
  };
  const label = fixer ? "Send the rest…" : "Send the rest to a fresh thread";
  return <Popover open={!!warned} onOpenChange={(open) => { if (!open) setWarned(null); }}>
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm" className={BUTTON} disabled={busy} onClick={(event) => { event.preventDefault(); void send(); }}>{busy ? `${label.replace(/…$/, "")}…` : label}</Button>
    </PopoverTrigger>
    <PopoverContent align="end" mobileTitle="Send the rest" className="w-80 max-w-[calc(100vw-24px)] p-1">
      {warned && <SendWarning warned={warned} busy={busy} what={what} onChoose={(choice) => void send(choice)} onCancel={() => setWarned(null)} className="border-0 bg-transparent" />}
    </PopoverContent>
  </Popover>;
}

/**
 * The notice for the comments sent to the main thread (src/reports.ts), always naming it "The main thread", never by its
 * title, which a local review shares: once it stops before it's done, "1 of 6 reported" with Check now, as idle never
 * means done; archived or deleted, Send the rest to a fresh thread too; Ready to re-review once it reported them all or
 * said it's finished, with what the review agent's check found and Check fixes, or Check again; and while the agent
 * checks, only that, never Ready yet. `onChanged` reloads the review.
 */
export function useFixNotices(targetKey: string, review: Reviewed | null, onChanged: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const checkOn = useKnob("runReReviewCheck");
  const sendOn = useKnob("sendToThread");
  const container = useFullscreenPortalContainer();
  const [busy, setBusy] = useState(false);
  const fixes = review && !review.archivedAt && !review.userArchivedAt ? fixesState(review) : null;
  // Only Check fixes checks them: a check of your feedback alone isn't one.
  const checking = !!fixes && !!review?.verifyingSince && !!review.verifyingFixes;
  // The check's end, and what it found, reach the review as feedback.
  const checkingRef = useRef(checking);
  checkingRef.current = checking;
  useRealtime(`feedback:${targetKey}`, () => { if (checkingRef.current) onChanged(); });
  if (!fixes) return [];
  const { send, ready, gone, tally } = fixes;
  const stopped = !ready && !!send.stopped && tally.reported < tally.sent;
  if (!ready && !stopped) return [];

  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("checkFixes", { targetKey });
      if (!result.ok) toast.error(result.error ?? "Couldn’t start the check.");
      else onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start the check.");
    } finally {
      setBusy(false);
    }
  };
  const counted = tally.reported === tally.sent ? `All ${tally.sent} reported` : countedText(tally);
  if (checking) return [{ id: "fixes-checking", tone: "info", icon: "Loading", busy: true, label: "Checking the fixes", firstLine: true, text: `${counted}. Checking the fixes…` }];
  const label = ready ? send.checkedAt !== undefined || tally.checked ? "Check again" : "Check fixes" : "Check now";
  const checkButton = checkOn ? <Hint label={CHECK_FIXES} container={container}>
    <Button variant="outline" size="sm" className={BUTTON} disabled={busy} aria-description={CHECK_FIXES} onClick={() => void check()}>
      <Icon name="Sparkles" className="text-(--ansi-13)" aria-hidden />{busy ? `${label}…` : label}
    </Button>
  </Hint> : null;
  const found = checkedText(tally);
  const result = found ? ` ${found}.` : "";
  if (ready) return [{ id: "fixes-ready", tone: "info", icon: "ArrowTurnBackward", label: "Ready to re-review", firstLine: true, text: `Ready to re-review. ${finishedText(tally, send.readyBy)}.${result}`, action: checkButton ?? undefined }];
  const why = gone === "archived" ? "The main thread is archived." : gone === "deleted" ? "The main thread was deleted." : "The main thread is idle but may still be waiting on subagents.";
  const rest = gone && sendOn ? <SendRest targetKey={targetKey} onChanged={onChanged} /> : null;
  return [{ id: "fixes-reported", tone: "info", icon: gone ? gone === "deleted" ? "Trash2" : "Archive" : "Send", label: "Comments sent", firstLine: true, text: `${countedText(tally)}. ${why}${result}`,
    action: checkButton || rest ? <span className="flex flex-wrap gap-2">{checkButton}{rest}</span> : undefined }];
}
