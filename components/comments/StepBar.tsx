import { useEffect, useState } from "react";
import { showCommentStep, stepComment, useCommentStep } from "../../lib/comment-stops";
import { TEXT_FIELD } from "../../lib/review-shortcuts";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { useNeedsYou } from "../../lib/workspace-store";
import { Icon } from "../ui/icon";
import { NeedsYouPill } from "./NeedsYouPill";
import { updateComments } from "./store";

/** Whether the focus is in a box you type in, which brings up a phone's keyboard. */
function useTyping(): boolean {
  const typing = () => document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || !!document.activeElement.closest(TEXT_FIELD));
  const [now, setNow] = useState(typing);
  useEffect(() => {
    const update = () => setNow(typing());
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return now;
}

const round = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11";

/**
 * Over the code, at the workspace's bottom (above a phone's dock): the step bar, after you go to a comment from an
 * overlay or sheet by touch, which steps through the list's filter there (‹ 2 of 5 · Not submitted › ▤ ✕); the 2 s hint
 * a step by key shows with the list closed; or the "need you" pill. The selection bar takes its place while lines are
 * selected (`hidden`), as the keyboard and what's over the code do.
 */
export function StepBar({ hidden, pill }: {
  /** Lines are selected: the selection bar is in its place. */
  hidden: boolean;
  /** The review came back to you, or 0.5 left it on Feedback or Threads, and Comments couldn't open beside the code. */
  pill: boolean;
}) {
  const { targetKey, layout, panel } = useWorkspace();
  const step = useCommentStep(targetKey);
  const needsYou = useNeedsYou(targetKey);
  const typing = useTyping();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (step?.via !== "hint") return;
    const timer = setTimeout(() => showCommentStep(targetKey, null), 2000);
    return () => clearTimeout(timer);
  }, [step?.via, step?.nonce, targetKey]);
  // Once Comments opens, the pill's job is done.
  useEffect(() => { if (panel.view === "comments") setDismissed(true); }, [panel.view]);
  const place = layout.mode === "phone" ? "bottom-[calc(60px+env(safe-area-inset-bottom))]" : "bottom-4";
  if (hidden || typing || layout.nav === "overlay" || layout.panel === "overlay") return null;
  if (step?.via === "hint") {
    return <p role="status" className={cn("pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium tabular-nums shadow-lg animate-in fade-in duration-150 motion-reduce:animate-none", place)}>
      {step.index + 1} of {step.total} · {step.filter}
    </p>;
  }
  if (step) {
    return (
      <div role="toolbar" aria-label="Step through comments" className={cn("absolute left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-popover p-1 shadow-2xl ring-1 ring-primary/10", place)}>
        <button type="button" aria-label="Previous comment" className={round} onClick={() => stepComment(targetKey, -1, undefined)}><Icon name="ChevronLeft" className="size-4" aria-hidden /></button>
        <span role="status" className="min-w-0 px-1.5 text-center text-xs font-medium whitespace-nowrap tabular-nums">{step.index + 1} of {step.total} · {step.filter}</span>
        <button type="button" aria-label="Next comment" className={round} onClick={() => stepComment(targetKey, 1, undefined)}><Icon name="ChevronRight" className="size-4" aria-hidden /></button>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <button type="button" aria-label="Show in list" className={round} onClick={() => { updateComments(targetKey, { expanded: step.id }); panel.open("comments"); }}><Icon name="MessageSquare" className="size-4" aria-hidden /></button>
        <button type="button" aria-label="Close" className={round} onClick={() => showCommentStep(targetKey, null)}><Icon name="X" className="size-4" aria-hidden /></button>
      </div>
    );
  }
  if (pill && !dismissed && needsYou > 0 && panel.view !== "comments") {
    return <NeedsYouPill count={needsYou} className={place} onDismiss={() => setDismissed(true)} onOpen={() => {
      setDismissed(true);
      updateComments(targetKey, { filter: "needs-you", expanded: null });
      panel.open("comments");
    }} />;
  }
  return null;
}
