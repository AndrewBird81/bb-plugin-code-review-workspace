// Where the review workspace puts its navigator and side panel, decided from the workspace's own size: BB's pane,
// not the window, so a narrow pane on a wide screen lays out like a small screen.
import { useLayoutEffect, useReducer, useRef, useState } from "react";
import { carried, keep } from "./remount";
import { TEXT_FIELD } from "./review-shortcuts";

/** The narrowest the code gets beside docked sides. */
export const READER_MIN = 560;
/** A workspace shorter than this is a phone held sideways (`short`). */
export const SHORT_BELOW = 500;
/**
 * A workspace narrower than this is a phone's (`phone`): the iPhone Duo unfolded and held sideways, beside BB's thread
 * list, leaves 631, which is a tablet's.
 */
export const PHONE_BELOW = 600;
/**
 * A window whose shorter side is under this is a phone's, the iPhone Duo's inner screen's included: the smallest iPad's
 * screen is 744 on its shorter side. A phone's fold, unfold or rotation keeps what's open (`phoneResized`); an iPad's or
 * a desktop's window resizing is as BB's pane resizing.
 */
export const PHONE_WINDOW_BELOW = 744;
export const NAV_WIDTH = { initial: 288, min: 200, max: 560 };
export const PANEL_WIDTH = { initial: 400, min: 320, max: 640 };
/** How far past a threshold a size must move to undo what it decided, so a size wobbling across it doesn't flip it. */
const HYSTERESIS = 16;

/** `phone`: a dock and one sheet. `short` (a phone held sideways): sides only over the code. `tablet`: sides dock where they fit. */
export type WorkspaceMode = "phone" | "short" | "tablet";
/** `suppressed`: wanted, but out of room beside the docked panel; the panel's closing docks it again. */
export type NavPlacement = "docked" | "overlay" | "suppressed" | "closed";
/** In phone mode an overlay is the sheet. */
export type PanelPlacement = "docked" | "overlay" | "closed";

export interface LayoutState {
  navWidth: number;
  panelWidth: number;
  /** The navigator is wanted, and docks where it fits. */
  navOpen: boolean;
  /** The navigator was opened over the code, which only you do; it stays there until closed. */
  navOverlay: boolean;
  /** Where you're typing, if you are: in the navigator (Find in review), the panel, or elsewhere, such as the code. */
  typingIn?: "nav" | "panel" | "other";
  /** A panel view is open, and docks where it fits. */
  panelOpen: boolean;
  /** The panel was opened where it couldn't dock, so it shows over the code. */
  panelOverlay: boolean;
}

export interface WorkspaceLayout {
  mode: WorkspaceMode;
  nav: NavPlacement;
  panel: PanelPlacement;
  /** The navigator would dock if wanted, beside the panel as placed. */
  navCanDock: boolean;
  /** The panel would dock if open. */
  panelCanDock: boolean;
  /** The code is under 720px wide: long lines wrap unless you chose otherwise, and labels shorten. */
  narrowReader: boolean;
  /** The pane is at least 1000px wide: room for the title bar's labeled controls. */
  widePane: boolean;
  /** It came with a phone's window resizing (a fold, an unfold, a rotation) rather than BB's pane alone. Not compared. */
  phoneResized: boolean;
}

/** `value < threshold`, with the threshold moved HYSTERESIS toward what `was` decided; exact without it. */
function below(value: number, threshold: number, was: boolean | undefined): boolean {
  return value < threshold + (was === undefined ? 0 : was ? HYSTERESIS : -HYSTERESIS);
}

/**
 * The panel's width where it docks in a pane `width` wide: its own, or narrower, down to its least, so the code keeps
 * READER_MIN. (A 400px Comments panel docks at 391 on an unfolded iPhone Duo, 951 wide, rather than covering the code.)
 */
export function panelDockWidth(width: number, panelWidth: number): number {
  return Math.min(panelWidth, Math.max(PANEL_WIDTH.min, width - READER_MIN));
}

/** The code's width between the sides docked in `layout`. */
export function readerWidth(width: number, state: LayoutState, layout: Pick<WorkspaceLayout, "nav" | "panel">): number {
  return width - (layout.nav === "docked" ? state.navWidth : 0) - (layout.panel === "docked" ? panelDockWidth(width, state.panelWidth) : 0);
}

/**
 * The layout for a workspace `width` × `height`, given the layout it had (`previous`) for hysteresis. A side docks only
 * while the code keeps READER_MIN, and the panel gets the room first; overlays never open by themselves. Out of room,
 * a docked panel hides, unless a phone's window resized (`phoneResized`: a fold, an unfold, a rotation), which takes
 * it over the code instead: what you had open stays open as the screen changes. Not a side you're not typing in,
 * though: that hides as before, rather than cover the box you're typing in.
 */
export function workspaceLayout(width: number, height: number, state: LayoutState, previous?: WorkspaceLayout, phoneResized = false): WorkspaceLayout {
  const mode: WorkspaceMode = below(height, SHORT_BELOW, previous && previous.mode === "short") ? "short"
    : below(width, PHONE_BELOW, previous && previous.mode === "phone") ? "phone" : "tablet";
  // Docked, a side stays docked down to HYSTERESIS under READER_MIN; anything else docks at READER_MIN.
  const fits = (room: number, docked: boolean) => mode === "tablet" && room >= READER_MIN - (docked ? HYSTERESIS : 0);
  const panelWidth = panelDockWidth(width, state.panelWidth);
  const panelCanDock = fits(width - panelWidth, previous?.panel === "docked");
  const carries = (side: "nav" | "panel") => phoneResized && (!state.typingIn || state.typingIn === side);
  // Opened over the code and docked since by an unfold, they go back over it as it folds, not as BB's pane narrows.
  // Docked on their own, they go over the code only with you typing in them.
  const navOver = (state.navOverlay && (previous?.nav !== "docked" || carries("nav"))) || (phoneResized && previous?.nav === "docked" && state.typingIn === "nav");
  // Over the code, it stays there until it closes or docks. One side at a time goes there: the chapters, if they do.
  const panelOver = state.panelOverlay || previous?.panel === "overlay" || (carries("panel") && previous?.panel === "docked" && !navOver);
  const panel: PanelPlacement = state.panelOpen && panelCanDock ? "docked" : state.panelOpen && panelOver ? "overlay" : "closed";
  const navCanDock = fits(width - state.navWidth - (panel === "docked" ? panelWidth : 0), previous?.nav === "docked");
  const nav: NavPlacement = state.navOpen && navCanDock ? "docked" : navOver ? "overlay"
    : state.navOpen && panel === "docked" ? "suppressed" : "closed";
  return {
    mode, nav, panel, navCanDock, panelCanDock,
    narrowReader: below(readerWidth(width, state, { nav, panel }), 720, previous?.narrowReader),
    widePane: !below(width, 1000, previous && !previous.widePane),
    phoneResized,
  };
}

function sameLayout(a: WorkspaceLayout, b: WorkspaceLayout): boolean {
  return (Object.keys(a) as Array<keyof WorkspaceLayout>).every((key) => key === "phoneResized" || a[key] === b[key]);
}

/** Without ResizeObserver (jsdom), the window stands in, held to what its media queries say about the mode. */
function windowSize(): { width: number; height: number } {
  const matches = (query: string) => window.matchMedia?.(query).matches ?? false;
  return {
    width: matches(`(max-width: ${PHONE_BELOW - 1}px)`) ? Math.min(window.innerWidth, PHONE_BELOW - 1) : Math.max(window.innerWidth, PHONE_BELOW),
    height: matches("(max-height: 499px)") ? Math.min(window.innerHeight, 499) : Math.max(window.innerHeight, 500),
  };
}

const px = (value: string) => parseFloat(value) || 0;

/**
 * The room `el` has: its size less the padding that keeps it clear of the screen's edges (top, left, right), but not
 * the keyboard's at its bottom, which comes and goes as you type and mustn't turn a phone into a phone held sideways.
 */
function roomOf(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return { width: rect.width - px(style.paddingLeft) - px(style.paddingRight), height: rect.height - px(style.paddingTop) };
}

type Size = { width: number; height: number };

/** The window's size, which a fold, an unfold or a rotation changes, and BB's pane resizing doesn't. */
const windowNow = (): Size => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });

/** Whether a window, by default this one, is a phone's (PHONE_WINDOW_BELOW). */
export const phoneWindow = ({ width, height }: Size = windowNow()) => Math.min(width, height) < PHONE_WINDOW_BELOW;

/** The window resizing from `was` to `is` on a phone's touch screen, a phone's window both before and after. */
function phoneResize(was: Size, is: Size): boolean {
  return (was.width !== is.width || was.height !== is.height) && phoneWindow(was) && phoneWindow(is) && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** How long, once you're done typing, BB's pane may take to grow back as the keyboard goes away. */
const KEYBOARD_GOING_MS = 1000;

/**
 * The layout for `el`'s size as it resizes. It re-renders only when the layout changes, not on every frame of a pane
 * drag. It measures as `el` resizes, and as the window and its visual viewport do, then again a frame later: on a
 * phone the window's new size can arrive after the resize. With `carryKey`, a workspace that takes another's place (BB
 * remounts its page: lib/remount.ts) starts from that one's size, window and layout, so the change between them is a
 * resize as in place: a phone's turn or fold carries what's open.
 */
export function useWorkspaceLayout(el: HTMLElement | null, state: LayoutState, carryKey?: string): WorkspaceLayout {
  const [seed] = useState(() => carryKey ? carried(carryKey)?.layout : undefined);
  const size = useRef<{ width: number; height: number; phoneResized: boolean } | null>(seed ? { width: seed.width, height: seed.height, phoneResized: false } : null);
  // The window as the workspace last resized.
  const windowLast = useRef<Size | null>(seed?.window ?? null);
  const latest = useRef(state);
  latest.current = state;
  // The layout last rendered, which hysteresis keeps to.
  const shown = useRef<WorkspaceLayout | undefined>(seed?.shown);
  const [, remeasured] = useReducer((count: number) => count + 1, 0);
  const { width, height, phoneResized } = size.current ?? { ...windowSize(), phoneResized: false };
  const next = workspaceLayout(width, height, state, shown.current, phoneResized);
  const layout = shown.current && sameLayout(next, shown.current) ? shown.current : next;
  const kept = useRef<unknown[]>([]);
  useLayoutEffect(() => {
    shown.current = layout;
    const now = [size.current?.width, size.current?.height, windowLast.current?.width, windowLast.current?.height, layout];
    if (!carryKey || !size.current || !windowLast.current || now.every((value, index) => value === kept.current[index])) return;
    kept.current = now;
    keep(carryKey, { layout: { width: size.current.width, height: size.current.height, window: windowLast.current, shown: layout } });
  });
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    let windowWas = windowLast.current ?? windowNow();
    windowLast.current = windowWas;
    // Until when the height from before the keyboard is kept: while you type, then KEYBOARD_GOING_MS once you're done.
    let keptUntil: number | null = null;
    let release = 0;
    const measure = ({ width, height: measured }: Size) => {
      if (!(width > 0)) return;
      let height = Number.isFinite(measured) ? measured : windowSize().height;
      // BB shrinks its pane to what shows above an on-screen keyboard: while you type, a pane that only got shorter
      // keeps the height it had, so the keyboard doesn't turn a phone into a phone held sideways; and once you're done,
      // until BB's pane grows back as the keyboard goes, for up to KEYBOARD_GOING_MS. A new width ends it at once.
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && (active.isContentEditable || !!active.closest(TEXT_FIELD));
      const shorter = !!size.current && size.current.width === width && height < size.current.height;
      if (!shorter) keptUntil = null;
      else if (typing) keptUntil = Infinity;
      else if (keptUntil === Infinity) {
        keptUntil = Date.now() + KEYBOARD_GOING_MS;
        clearTimeout(release);
        release = window.setTimeout(() => measure(roomOf(el)), KEYBOARD_GOING_MS);
      } else if (keptUntil !== null && Date.now() >= keptUntil) keptUntil = null;
      if (keptUntil !== null && size.current) height = size.current.height;
      // The first measurement replaces the window's guess outright, rather than keeping to it.
      if (!size.current) shown.current = undefined;
      else if (size.current.width === width && size.current.height === height) return;
      // The window as the workspace last resized, rather than as last measured: BB's pane can follow a fold a frame late.
      const windowIs = windowNow();
      const phoneResized = phoneResize(windowWas, windowIs);
      windowWas = windowIs;
      windowLast.current = windowIs;
      size.current = { width, height, phoneResized };
      if (!shown.current || !sameLayout(workspaceLayout(width, height, latest.current, shown.current, phoneResized), shown.current)) remeasured();
    };
    // Before the first paint, rather than when the observer first reports.
    measure(roomOf(el));
    const observer = new ResizeObserver(([entry]) => measure({ width: entry.contentRect.width, height: entry.contentRect.height + px(getComputedStyle(el).paddingBottom) }));
    observer.observe(el);
    let frame = 0;
    const remeasure = () => {
      measure(roomOf(el));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure(roomOf(el)));
    };
    window.addEventListener("resize", remeasure);
    window.visualViewport?.addEventListener("resize", remeasure);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(release);
      window.removeEventListener("resize", remeasure);
      window.visualViewport?.removeEventListener("resize", remeasure);
    };
  }, [el]);
  return layout;
}
