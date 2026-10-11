// A phone's one sheet: the chapters, Comments or the agent, over the code from just under the workspace's top down to
// the dock, whose tabs switch it. The navigator's host and the side panel each become it in phone mode.
import { useRef, type PointerEvent, type RefObject } from "react";

/** Where the sheet sits and how it opens: 12px of the code above it stay showing, for a tap there to close it. */
export const SHEET = "absolute inset-x-0 bottom-0 top-3 z-40 rounded-t-xl border-t border-border shadow-2xl animate-in slide-in-from-bottom duration-200 motion-reduce:animate-none";

// A flick closes the sheet: dragged down a quarter of its height, or let go while moving down at least this fast.
const CLOSE_SHARE = 0.25;
const CLOSE_SPEED = 450;

/** The handle at the top of the sheet: the sheet follows a finger dragging it down, and a flick closes it. */
export function SheetHandle({ sheet, onClose }: { sheet: RefObject<HTMLElement | null>; onClose: () => void }) {
  const drag = useRef<{ pointer: number; startY: number; lastY: number; lastAt: number; speed: number } | null>(null);
  const place = (offset: number, animate: boolean) => {
    const el = sheet.current;
    if (!el) return;
    el.style.transition = animate ? "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)" : "none";
    el.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
  };
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointer: event.pointerId, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, speed: 0 };
    event.preventDefault();
  }
  function follow(event: PointerEvent<HTMLDivElement>) {
    const at = drag.current;
    if (!at || at.pointer !== event.pointerId) return;
    if (event.timeStamp > at.lastAt) at.speed = (event.clientY - at.lastY) / (event.timeStamp - at.lastAt) * 1000;
    at.lastY = event.clientY;
    at.lastAt = event.timeStamp;
    place(event.clientY - at.startY, false);
  }
  function end(event: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const at = drag.current;
    if (!at || at.pointer !== event.pointerId) return;
    drag.current = null;
    const offset = event.clientY - at.startY;
    const height = sheet.current?.clientHeight || 1;
    if (!cancelled && (offset >= height * CLOSE_SHARE || at.speed >= CLOSE_SPEED)) {
      onClose();
      // Closed before the next paint, so it's put back unseen, for the next time it opens.
      place(0, false);
    } else place(0, true);
  }
  return (
    <div
      aria-hidden
      data-sheet-handle
      onPointerDown={start}
      onPointerMove={follow}
      onPointerUp={(event) => end(event, false)}
      onPointerCancel={(event) => end(event, true)}
      className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
    >
      <span className="h-1 w-9 rounded-full bg-muted-foreground/30" />
    </div>
  );
}
