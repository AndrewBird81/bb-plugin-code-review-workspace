import { useRef, type ReactNode } from "react";
import type { PanelView } from "../../lib/panel-state";
import { cn } from "../../lib/utils";
import { PANEL_WIDTH, READER_MIN, type PanelPlacement } from "../../lib/workspace-layout";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { TOUCH_CONTROL } from "../touch";
import { SHEET, SheetHandle } from "./ReviewSheet";
import { OPAQUE, Resizer, useSide } from "./side-parts";

/** The id of the side panel, which the title bar's openers show and hide. */
export const sidePanelId = (targetKey: string) => `gr-side-panel-${targetKey}`;

const TITLE: Record<PanelView, string> = { comments: "Comments", finish: "Finish review", agent: "Review agent" };

/**
 * The conversation and finishing, at the code's right: docked at its width, over the code (`overlay`), or closed. On a
 * phone (`sheet`) over the code is the sheet above the dock. Its views stay mounted when it closes or switches, so
 * none loses what you were doing; `children` are them, each showing for its own view. The agent's view has a header of
 * its own.
 */
export function SidePanel({ targetKey, placement, sheet, view, width, maxWidth, onWidth, onWidthDone, onClose, onBack, children }: {
  targetKey: string;
  placement: PanelPlacement;
  sheet: boolean;
  /** The view showing; null while closed. */
  view: PanelView | null;
  width: number;
  /** The widest it can be docked now, keeping the code at its narrowest or wider. */
  maxWidth: number;
  onWidth: (width: number) => void;
  onWidthDone: (width: number) => void;
  onClose: () => void;
  /** Finish review's way back to Comments. */
  onBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const overlay = placement === "overlay";
  const shown = placement !== "closed" && view !== null;
  const inSheet = sheet && overlay;
  const dialog = useSide(ref, { shown, overlay, modal: !sheet, onClose });
  const button = cn("size-8 shrink-0 px-0 text-muted-foreground", TOUCH_CONTROL);
  // Docked where the code would get under READER_MIN beside it, it narrows, down to its least (lib/workspace-layout.ts);
  // in CSS (100cqw: the workspace's width), so it follows the pane as it resizes.
  const docked = `min(${width}px, max(${PANEL_WIDTH.min}px, 100cqw - ${READER_MIN}px))`;
  return (
    <>
      {placement === "docked" && <Resizer label="Resize panel" edge="right" width={Math.min(width, Math.max(PANEL_WIDTH.min, maxWidth))} min={PANEL_WIDTH.min} max={maxWidth} initial={PANEL_WIDTH.initial} narrows onWidth={onWidth} onDone={onWidthDone} />}
      <aside
        ref={ref}
        id={sidePanelId(targetKey)}
        hidden={!shown}
        aria-label={overlay && view ? TITLE[view] : "Comments and agent"}
        {...dialog}
        className={cn(
          "flex min-h-0 min-w-0 flex-col bg-background outline-none",
          !shown && "hidden",
          placement === "docked" && "relative shrink-0",
          // Where a foldable says where its fold is (lib/use-fold.ts), it keeps to the fold's right, if it can at its least.
          overlay && !sheet && "absolute inset-y-0 right-0 z-40 w-[min(440px,92%)] max-w-[max(320px,calc(100%-var(--gr-fold-end,0px)))] border-l border-border shadow-2xl animate-in slide-in-from-right duration-200 motion-reduce:animate-none",
          inSheet && SHEET,
        )}
        style={placement === "docked" ? { width: docked } : overlay ? OPAQUE : undefined}
      >
        {inSheet && <SheetHandle sheet={ref} onClose={onClose} />}
        {view && view !== "agent" && (
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-1.5 pr-1.5">
            {view === "finish"
              ? <Button variant="ghost" size="sm" className={cn("h-8 gap-1 px-2 text-muted-foreground", TOUCH_CONTROL)} onClick={onBack}><Icon name="ChevronLeft" aria-hidden />Comments</Button>
              : <Icon name="MessageSquare" className="ml-1.5 size-4 shrink-0 text-primary" aria-hidden />}
            <h2 className={cn("min-w-0 flex-1 truncate text-sm font-medium", view === "comments" && "ml-1")}>{TITLE[view]}</h2>
            <Button variant="ghost" size="sm" aria-label={inSheet ? "Close" : "Close panel"} className={button} onClick={onClose}><Icon name="X" aria-hidden /></Button>
          </div>
        )}
        {children}
      </aside>
    </>
  );
}
