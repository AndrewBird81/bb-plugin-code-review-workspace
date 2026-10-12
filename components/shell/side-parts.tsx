// What the navigator and the side panel share: their resize handle, and how each behaves over the code.
import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { cn } from "../../lib/utils";
import { TOUCH_HANDLE } from "../touch";

const FOCUSABLE = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "summary", '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])'].join(",");

/** Whether a closed <details> hides `item`: all of one but its summary. */
function inClosedDetails(item: HTMLElement): boolean {
  for (let details = item.closest("details:not([open])"); details; details = details.parentElement?.closest("details:not([open])") ?? null) {
    if (!details.querySelector(":scope > summary")?.contains(item)) return true;
  }
  return false;
}

function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => !item.closest("[hidden], [aria-hidden=\"true\"], [inert]") && !inClosedDetails(item));
}

/** Over the code a side is opaque, as the workspace is, whatever the alpha of BB's background. */
export const OPAQUE = { backgroundColor: "rgb(from var(--background) r g b / 1)" };

/**
 * Give the focus to `el`, if it was lost or left behind in what closed: on the next frame, once what changed with the
 * closing, such as `el` showing again, is drawn. After a tap or a click too: a Hint there opens only for a keyboard.
 */
export function returnFocus(el: HTMLElement | null | undefined, from: HTMLElement | null) {
  const now = document.activeElement;
  if (el?.isConnected && (!now || now === document.body || !!from?.contains(now))) requestAnimationFrame(() => el.focus({ preventScroll: true }));
}

/**
 * A side's focus: closing it gives the focus back to what opened it. Over the code (`overlay`) it's a dialog too:
 * opening it moves the focus in, and Esc closes it; a `modal` one also keeps Tab inside it. Spread the returned props
 * on the side.
 */
export function useSide(ref: RefObject<HTMLElement | null>, { shown, overlay, modal = true, onClose }: { shown: boolean; overlay: boolean; modal?: boolean; onClose: () => void }) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body && !el.contains(active) ? active : null;
    return () => returnFocus(opener.current, el);
  }, [ref, shown]);
  // The dialog itself, rather than its first control, whose tooltip would open: Tab goes on from there.
  useLayoutEffect(() => {
    const el = ref.current;
    if (overlay && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [ref, overlay]);
  // React's events, not the DOM's: a box inside that handles Esc itself, such as Find in review's, goes first. Keys
  // from a menu it opened, which React passes up from the menu's portal, are the menu's.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || event.defaultPrevented || !el.contains(event.target as Node)) return;
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab" || !modal) return;
    const items = focusables(el);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? items.at(-1) : items[index - 1]) : (index < 0 || index === items.length - 1 ? items[0] : items[index + 1]);
    event.preventDefault();
    (next ?? el).focus({ preventScroll: true });
  };
  return overlay ? { role: "dialog", ...(modal ? { "aria-modal": true } : {}), tabIndex: -1, onKeyDown } as const : {};
}

/**
 * The line between a docked side and the code, which drags or steps its width. `edge`: the side of the line its pane
 * is on. Double-clicking or double-tapping it puts the width back. A width is saved only when it changes: a touch, or
 * a key that can't go further, keeps the one you chose.
 */
export function Resizer({ label, edge, width, min, max, initial, narrows = false, onWidth, onDone }: {
  label: string;
  edge: "left" | "right";
  width: number;
  min: number;
  /** The widest it goes now, which keeps the code at its narrowest or wider. */
  max: number;
  initial: number;
  /** It shows narrower than its width where the room is less (lib/workspace-layout.ts): putting it back saves `initial` itself. */
  narrows?: boolean;
  onWidth: (width: number) => void;
  /** The drag or key that changed the width ended, so it can be saved. */
  onDone: (width: number) => void;
}) {
  const latest = useRef(width);
  latest.current = width;
  const lastDown = useRef(-Infinity);
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
  const set = (value: number) => {
    const next = clamp(value);
    if (next === width) return;
    onWidth(next);
    onDone(next);
  };
  // Moving away from the pane widens it.
  const sign = edge === "left" ? 1 : -1;
  function drag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    // A second press soon after the first, as a double-click or a double tap.
    if (event.timeStamp - lastDown.current < 300) {
      lastDown.current = -Infinity;
      if (!narrows) set(initial);
      else if (initial !== width) { onWidth(initial); onDone(initial); }
      return;
    }
    lastDown.current = event.timeStamp;
    const startX = event.clientX;
    const startWidth = width;
    const move = (ev: globalThis.PointerEvent) => {
      const next = clamp(startWidth + sign * (ev.clientX - startX));
      if (next !== latest.current) onWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (latest.current !== startWidth) onDone(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  function step(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === "Home" ? min : event.key === "End" ? max
      : event.key === "ArrowRight" ? width + 20 * sign : event.key === "ArrowLeft" ? width - 20 * sign : null;
    if (next === null) return;
    event.preventDefault();
    set(next);
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      aria-valuenow={width}
      onPointerDown={drag}
      onKeyDown={step}
      className={cn(
        "relative z-20 w-px shrink-0 cursor-col-resize touch-none bg-border before:absolute before:inset-y-0 before:content-['']",
        TOUCH_HANDLE,
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-primary/70 after:opacity-0 after:transition-opacity after:content-[''] hover:after:opacity-100 focus-visible:outline-none focus-visible:after:w-1 focus-visible:after:bg-primary focus-visible:after:opacity-100",
      )}
    />
  );
}
