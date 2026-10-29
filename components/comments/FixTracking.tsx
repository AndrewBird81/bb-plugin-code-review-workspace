// A sent comment's fix, on its card in the code and in the list: which thread reported it and what it said, what the
// review agent's check found against the Send that carried it, and Resolve, Dismiss and Reopen, which only your click does.
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { experimental_useSidebarThreads, Markdown, ThreadTitle, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { DraftComment } from "../../src/draft";
import { sentCheck, type CommentChecks } from "../../lib/comments";
import { linkImages } from "../../lib/link-images";
import { useStatusFacts } from "../../lib/review-links";
import { cn } from "../../lib/utils";
import { MetaLine } from "../MetaLine";
import { TOUCH_TARGET } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { CheckBadge } from "./look";

/**
 * A thread that reported, other than the main thread, by its title as BB's thread list has it ("a thread not in your
 * list" where the list doesn't have it), which opens it.
 */
function Reporter({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const listed = experimental_useSidebarThreads?.()?.threads.some((thread) => thread.id === threadId);
  return <button type="button" className={cn("relative min-w-0 max-w-full text-primary hover:underline", TOUCH_TARGET)} onClick={() => navigate.toThread(threadId)}>
    {listed ? <ThreadTitle threadId={threadId} /> : "a thread not in your list"} ↗
  </button>;
}

/** Sent, resolved or dismissed: a comment whose fix a card follows. */
const followed = (comment: Pick<DraftComment, "state">) => comment.state === "sent" || comment.state === "resolved" || comment.state === "dismissed";

/** The check's verdict, for the card's head. */
export function FixCheckBadge({ comment, checks }: { comment: DraftComment; checks: CommentChecks | undefined }) {
  const check = sentCheck(comment, checks);
  return check ? <CheckBadge check={check} /> : null;
}

/**
 * Under a followed comment's words: who reported it ("Reported by the main thread", another thread by its title, which
 * opens it, or from the command line) and in which commit; once it's resolved or dismissed, what was reported, which
 * its status line no longer says; then the check's one line, in the agent's tint.
 */
export function FixReport({ comment, checks }: { comment: DraftComment; checks: CommentChecks | undefined }) {
  const facts = useStatusFacts();
  const check = sentCheck(comment, checks);
  const claim = followed(comment) ? comment.claim : undefined;
  if (!claim && !check) return null;
  const main = facts.sends?.find((send) => send.n === comment.sendN)?.threadId ?? facts.sent?.threadId;
  const note = claim?.note?.trim().replace(/(?<!\.)\.$/, "");
  // Sent, the status line says what was reported. A check's inference has the check's words, under it.
  const said = claim && comment.state !== "sent" ? [claim.inferred ? `Looked ${claim.outcome}` : claim.outcome === "done" ? "Done" : "Declined", claim.inferred ? null : note].filter(Boolean).join(" · ") : null;
  // Who said so.
  const who = !claim ? null
    : claim.inferred ? "Found by the review agent’s check"
    : !claim.threadId ? "Reported from the command line"
    : <span className="whitespace-normal">Reported by {claim.threadId === main ? "the main thread" : <Reporter threadId={claim.threadId} />}</span>;
  return <div className="space-y-1.5">
    {claim && <MetaLine className="text-xs text-muted-foreground" items={[
      said && <span className="whitespace-normal break-words"><InlineCode text={said} /></span>,
      who,
      claim.commit ? <span className="font-mono">{claim.commit.slice(0, 7)}</span> : null,
    ]} />}
    {check?.evidence && <div className="flex gap-2 rounded-md border-l-2 border-(--ansi-13)/60 bg-(--ansi-13)/5 px-2.5 py-1.5">
      <Icon name="Sparkles" className="mt-0.5 size-3.5 shrink-0 text-(--ansi-13)" aria-label="The review agent’s check" />
      <Markdown content={linkImages(check.evidence)} className="min-w-0 flex-1 text-sm leading-relaxed" />
    </div>}
  </div>;
}

/** What a card's fix buttons do: resolve, dismiss, reopen for the next Send, or undo a Resolve or Dismiss. */
export type FixChange = "resolved" | "dismissed" | "open" | "undo";

// Comments just resolved or dismissed here, by review and id, whose status line offers Undo for UNDO_MS or until the
// focus leaves the card.
const UNDO_MS = 10_000;
const settled = new Set<string>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const notify = () => { for (const listener of listeners) listener(); };
function settle(key: string, on: boolean) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  if (on) {
    settled.add(key);
    timers.set(key, setTimeout(() => settle(key, false), UNDO_MS));
  } else if (!settled.delete(key)) return;
  notify();
}
const undoKey = (targetKey: string, comment: Pick<DraftComment, "id">) => `${targetKey}\0${comment.id}`;
function useSettled(key: string): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settled.has(key));
}

/** A fix button's focus ring, shown when the focus moves to it after a click too. */
const RING = "focus:outline-none focus:ring-2 focus:ring-ring/50";

/**
 * Undo on a comment's status line right after you resolved or dismissed it here, for about 10 seconds or until the focus
 * leaves its card: it goes back as it was, sent, with its report. `label` says the status too, where the card has none.
 */
export function FixUndo({ targetKey, comment, onFix, label = false }: { targetKey: string; comment: DraftComment; onFix: (comment: DraftComment, state: FixChange) => Promise<void>; label?: boolean }) {
  const key = undoKey(targetKey, comment);
  const shown = useSettled(key) && (comment.state === "resolved" || comment.state === "dismissed");
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const card = button.current?.closest("article");
    if (!shown || !card) return;
    const left = (event: FocusEvent) => { if (!card.contains(event.relatedTarget as Node | null)) settle(key, false); };
    card.addEventListener("focusout", left);
    return () => {
      card.removeEventListener("focusout", left);
      // Gone with the focus on it: the focus goes to Reopen, which took its place for later.
      if (button.current && document.activeElement === button.current) requestAnimationFrame(() => card.querySelector<HTMLElement>("[data-fix-reopen]")?.focus());
    };
  }, [shown, key]);
  if (!shown) return null;
  const undo = <button ref={button} type="button" data-fix-undo className={cn("relative rounded-sm font-medium text-primary hover:underline", RING, TOUCH_TARGET)} onClick={() => { settle(key, false); void onFix(comment, "undo"); }}>Undo</button>;
  return label
    ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="font-medium text-foreground">{comment.state === "resolved" ? "Resolved" : "Dismissed"}</span> · {undo}</p>
    : <span className="shrink-0 text-xs text-muted-foreground"> · {undo}</span>;
}

/**
 * A sent comment's fix actions, first in its card's row: Resolve; Reopen, to send it again, once the thread reported on
 * it or the check found it not or partly addressed; and Dismiss, until it's reported done. Reopen alone on one resolved
 * or dismissed. Your click alone does each. Resolve and Dismiss offer Undo on the status line, which takes the focus.
 * `posts`: a PR's Submit would post it, as on a PR you don't own.
 */
export function FixButtons({ targetKey, comment, checks, busy, posts, className, onFix }: {
  targetKey: string;
  comment: DraftComment;
  checks: CommentChecks | undefined;
  busy: boolean;
  posts: boolean;
  className: string;
  onFix: (comment: DraftComment, state: FixChange) => Promise<void>;
}) {
  const resolveHint = useId();
  const dismissHint = useId();
  if (!followed(comment)) return null;
  const fix = (state: FixChange, event: { currentTarget: HTMLElement }) => {
    if (busy) return;
    const card = event.currentTarget.closest<HTMLElement>("article");
    const pressed = event.currentTarget;
    if (state === "resolved" || state === "dismissed") settle(undoKey(targetKey, comment), true);
    void onFix(comment, state).then(() => requestAnimationFrame(() => {
      if (state === "resolved" || state === "dismissed") return void card?.querySelector<HTMLElement>("[data-fix-undo]")?.focus();
      if (!pressed.isConnected && (!document.activeElement || document.activeElement === document.body)) card?.focus();
    }));
  };
  const busyProps = { "aria-disabled": busy || undefined };
  const leaves = `It won’t go with a Send${posts ? " or post with Submit" : ""}; Reopen brings it back.`;
  const reopenButton = <Button variant="ghost" size="sm" data-fix-reopen className={cn(className, RING)} {...busyProps} onClick={(event) => fix("open", event)}>
    <Icon name="RotateCcw" className="size-3.5" aria-hidden />Reopen
  </Button>;
  if (comment.state !== "sent") return reopenButton;
  const verdict = sentCheck(comment, checks)?.verdict;
  const reopens = !!comment.claim || verdict === "not_addressed" || verdict === "partial";
  return <>
    <Hint label={`Fixed. ${leaves}`}>
      <Button variant="ghost" size="sm" className={cn(className, RING)} aria-describedby={resolveHint} {...busyProps} onClick={(event) => fix("resolved", event)}>
        <Icon name="CircleCheck" className="size-3.5" aria-hidden />Resolve
      </Button>
    </Hint>
    <span id={resolveHint} hidden>Fixed. {leaves}</span>
    {reopens && <Hint label="Open it again: it goes with the next Send.">{reopenButton}</Hint>}
    {/* Reported done, it isn't "won't be fixed". */}
    {comment.claim?.outcome !== "done" && <>
      <Hint label={`Won’t be fixed. ${leaves}`}>
        <Button variant="ghost" size="sm" className={cn(className, RING)} aria-describedby={dismissHint} {...busyProps} onClick={(event) => fix("dismissed", event)}>
          <Icon name="Archive" className="size-3.5" aria-hidden />Dismiss
        </Button>
      </Hint>
      <span id={dismissHint} hidden>Won’t be fixed. {leaves}</span>
    </>}
  </>;
}

/** Whether a card offers Mark as pre-existing: only while it's open, not once it's sent, reported, resolved or dismissed. */
export const marksPreExisting = (comment: Pick<DraftComment, "state">) => !comment.state || comment.state === "open";
