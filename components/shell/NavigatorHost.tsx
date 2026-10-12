import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { NAV_WIDTH, type NavPlacement } from "../../lib/workspace-layout";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { TOUCH_CONTROL } from "../touch";
import { SHEET, SheetHandle } from "./ReviewSheet";
import { OPAQUE, Resizer, useSide } from "./side-parts";
import { navigatorId } from "./TopBand";

/**
 * Where the navigator is: docked at the code's left at its width, over the code (`overlay`), or hidden, suppressed
 * beside the docked panel or closed. On a phone (`sheet`) over the code is the sheet above the dock, headed by
 * `sheetTitle` and `sheetActions`. It stays mounted throughout, so the chapters keep what's open and Find its query.
 */
export function NavigatorHost({ targetKey, placement, sheet, sheetTitle, sheetActions, width, maxWidth, onWidth, onWidthDone, onClose, children }: {
  targetKey: string;
  placement: NavPlacement;
  sheet: boolean;
  /** The sheet's header, where a title would be: the Chapters | All files switch. */
  sheetTitle?: ReactNode;
  /** The sheet's buttons, before its ✕. */
  sheetActions?: ReactNode;
  width: number;
  /** The widest it can be docked now, keeping the code at its narrowest or wider. */
  maxWidth: number;
  onWidth: (width: number) => void;
  onWidthDone: (width: number) => void;
  /** Closes the overlay: Esc, or a tap on the code around it. */
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = placement === "overlay";
  const shown = placement === "docked" || overlay;
  const inSheet = sheet && overlay;
  const dialog = useSide(ref, { shown, overlay, modal: !sheet, onClose });
  return (
    <>
      <div
        ref={ref}
        id={navigatorId(targetKey)}
        hidden={!shown}
        aria-label={overlay ? "Chapters" : undefined}
        {...dialog}
        className={cn(
          "flex min-h-0 flex-col bg-surface-raised outline-none",
          !shown && "hidden",
          placement === "docked" && "relative shrink-0",
          overlay && !sheet && "absolute inset-y-0 left-0 z-40 w-[min(320px,85%)] border-r border-border shadow-2xl animate-in slide-in-from-left duration-200 motion-reduce:animate-none",
          inSheet && SHEET,
        )}
        style={placement === "docked" ? { width } : overlay ? OPAQUE : undefined}
      >
        {inSheet && <SheetHandle sheet={ref} onClose={onClose} />}
        {inSheet && (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
            <div className="min-w-0 flex-1">{sheetTitle}</div>
            {sheetActions}
            <Button variant="ghost" size="sm" aria-label="Close" className={cn("size-8 shrink-0 px-0 text-muted-foreground", TOUCH_CONTROL)} onClick={onClose}><Icon name="X" aria-hidden /></Button>
          </div>
        )}
        {children}
      </div>
      {placement === "docked" && <Resizer label="Resize chapters" edge="left" width={width} min={NAV_WIDTH.min} max={maxWidth} initial={NAV_WIDTH.initial} onWidth={onWidth} onDone={onWidthDone} />}
    </>
  );
}
