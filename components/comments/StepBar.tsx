import { useEffect, useState } from "react";
import { showCommentStep, stepComment, stepLabel, useCommentStep } from "../../lib/comment-stops";
import { TEXT_FIELD } from "../../lib/review-shortcuts";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { useNeedsYou } from "../../lib/workspace-store";
import { sidePanelId } from "../shell/SidePanel";
import { useMediaQuery } from "../ui/hooks/use-media-query";
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

/** How long the step bar waits once text is no longer selected: the selection bar stays that long, for a tap on it. */
const TEXT_GONE_MS = 300;

/**
 * Whether text is selected, as a long-press selects it on a phone: the selection bar shows for text in the code where
 * the step bar sits, so the step bar keeps out of its way, for any text.
 */
function useTextSelected(): boolean {
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    let gone: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(gone);
      if (document.getSelection()?.toString().trim()) setSelected(true);
      else gone = setTimeout(() => setSelected(false), TEXT_GONE_MS);
    };
    document.addEventListener("selectionchange", update);
    return () => {
      clearTimeout(gone);
      document.removeEventListener("selectionchange", update);
    };
  }, []);
  return selected;
}

/**
 * While a side panel docks at the code's right: how far the code's right edge is from the workspace's (`width`: the
 * panel's and its 1px resizer's), and the code's width beside it (`code`).
 */
function useDockedPanel(targetKey: string, docked: boolean): { width: number; code: number } {
  const [size, setSize] = useState({ width: 0, code: 0 });
  useEffect(() => {
    const panel = docked ? document.getElementById(sidePanelId(targetKey)) : null;
    const main = panel?.parentElement?.querySelector<HTMLElement>(":scope > main");
    if (!panel || !main) { setSize({ width: 0, code: 0 }); return; }
    const measure = () => {
      const width = Math.round(panel.getBoundingClientRect().width);
      const code = Math.round(main.getBoundingClientRect().width);
      setSize((was) => was.width === (width ? width + 1 : 0) && was.code === code ? was : { width: width ? width + 1 : 0, code });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(main);
    return () => observer.disconnect();
  }, [targetKey, docked]);
  return size;
}

const round = "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11";

/**
 * Over the code, at the workspace's bottom (above a phone's dock): the step bar, after you go to a comment from an
 * overlay or sheet by touch, which steps through the list's filter there (‹ 2 of 5 · Not submitted › ▤ ✕); the 2 s hint
 * a step by key shows with the list closed; or the "need you" pill. The selection bar takes its place while lines or
 * text are selected, as the keyboard and what's over the code do.
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
  const textSelected = useTextSelected();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (step?.via !== "hint") return;
    const timer = setTimeout(() => showCommentStep(targetKey, null), 2000);
    return () => clearTimeout(timer);
  }, [step?.via, step?.nonce, targetKey]);
  // Once Comments opens, the pill's job is done.
  useEffect(() => { if (panel.view === "comments") setDismissed(true); }, [panel.view]);
  const coarse = useMediaQuery("(pointer: coarse)");
  const docked = useDockedPanel(targetKey, layout.panel === "docked");
  // Above a phone's dock, in the middle; elsewhere at the code's corner, beside a docked panel and clear of a folding
  // screen's middle: beside a docked panel in under 600px of code on touch, as on an unfolded iPhone Duo held sideways,
  // the fold runs through the code's right part, so the bar keeps to its left. Each side clear of what of its safe area
  // reaches the workspace (lib/use-safe-area.ts), whose padding doesn't move what's absolute in it.
  const phone = layout.mode === "phone";
  const besideFold = coarse && layout.nav !== "docked" && docked.width > 0 && docked.code < 600;
  const place = phone ? "left-1/2 -translate-x-1/2 bottom-[calc(60px+var(--gr-safe-bottom,0px))]" : cn("bottom-[max(1rem,var(--gr-safe-bottom,0px))]", !docked.width && "right-[max(1rem,var(--gr-safe-right,0px))]");
  const beside = phone || !docked.width ? undefined
    : besideFold ? { left: "calc(1rem + var(--gr-safe-left, 0px))" } : { right: `calc(${docked.width}px + 1rem + var(--gr-safe-right, 0px))` };
  if (hidden || typing || textSelected || layout.nav === "overlay" || layout.panel === "overlay") return null;
  if (step?.via === "hint") {
    return <p role="status" style={beside} className={cn("pointer-events-none absolute z-40 rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium tabular-nums shadow-lg animate-in fade-in duration-150 motion-reduce:animate-none", place)}>
      {stepLabel(step)}
    </p>;
  }
  if (step) {
    return (
      <div role="toolbar" aria-label="Step through comments" style={beside} className={cn("absolute z-40 flex items-center gap-0.5 rounded-full border border-border bg-popover p-1 shadow-2xl ring-1 ring-primary/10", place)}>
        <button type="button" aria-label="Previous comment" className={round} onClick={() => stepComment(targetKey, -1, undefined)}><Icon name="ChevronLeft" className="size-4" aria-hidden /></button>
        <span role="status" className="min-w-0 px-1.5 text-center text-xs font-medium whitespace-nowrap tabular-nums">{stepLabel(step)}</span>
        <button type="button" aria-label="Next comment" className={round} onClick={() => stepComment(targetKey, 1, undefined)}><Icon name="ChevronRight" className="size-4" aria-hidden /></button>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <button type="button" aria-label="Show in list" className={round} onClick={() => { updateComments(targetKey, { expanded: step.id }); panel.open("comments"); }}><Icon name="MessageSquare" className="size-4" aria-hidden /></button>
        <button type="button" aria-label="Close" className={round} onClick={() => showCommentStep(targetKey, null)}><Icon name="X" className="size-4" aria-hidden /></button>
      </div>
    );
  }
  if (pill && !dismissed && needsYou > 0 && panel.view !== "comments") {
    return <NeedsYouPill count={needsYou} className={place} style={beside} onDismiss={() => setDismissed(true)} onOpen={() => {
      setDismissed(true);
      updateComments(targetKey, { filter: "needs-you", expanded: null });
      panel.open("comments");
    }} />;
  }
  return null;
}
