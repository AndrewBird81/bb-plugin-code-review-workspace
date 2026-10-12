// Where the review workspace puts its navigator and side panel, decided from the workspace's own size: BB's pane,
// not the window, so a narrow pane on a wide screen lays out like a small screen.
import { useLayoutEffect, useReducer, useRef } from "react";

/** The narrowest the code gets beside docked sides. */
export const READER_MIN = 560;
/** A workspace shorter than this is a phone held sideways (`short`). */
export const SHORT_BELOW = 500;
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
  /** You're typing in the navigator (Find in review): docked, a fold or a rotation keeps it open, over the code. */
  navTyping?: boolean;
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
  /** It came with the window resizing (a fold, an unfold, a rotation) rather than BB's pane alone. Not compared. */
  windowResized: boolean;
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
 * a docked panel hides, unless the window itself resized (`windowResized`: a fold, an unfold, a rotation), which
 * takes it over the code instead: what you had open stays open as the screen changes.
 */
export function workspaceLayout(width: number, height: number, state: LayoutState, previous?: WorkspaceLayout, windowResized = false): WorkspaceLayout {
  const mode: WorkspaceMode = below(height, SHORT_BELOW, previous && previous.mode === "short") ? "short"
    : below(width, 640, previous && previous.mode === "phone") ? "phone" : "tablet";
  // Docked, a side stays docked down to HYSTERESIS under READER_MIN; anything else docks at READER_MIN.
  const fits = (room: number, docked: boolean) => mode === "tablet" && room >= READER_MIN - (docked ? HYSTERESIS : 0);
  const panelWidth = panelDockWidth(width, state.panelWidth);
  const panelCanDock = fits(width - panelWidth, previous?.panel === "docked");
  // Over the code, it stays there until it closes or docks.
  const panelOver = state.panelOverlay || previous?.panel === "overlay" || (windowResized && previous?.panel === "docked");
  const panel: PanelPlacement = state.panelOpen && panelCanDock ? "docked" : state.panelOpen && panelOver ? "overlay" : "closed";
  const navCanDock = fits(width - state.navWidth - (panel === "docked" ? panelWidth : 0), previous?.nav === "docked");
  const navOver = state.navOverlay || (windowResized && previous?.nav === "docked" && !!state.navTyping);
  const nav: NavPlacement = state.navOpen && navCanDock ? "docked" : navOver ? "overlay"
    : state.navOpen && panel === "docked" ? "suppressed" : "closed";
  return {
    mode, nav, panel, navCanDock, panelCanDock,
    narrowReader: below(readerWidth(width, state, { nav, panel }), 720, previous?.narrowReader),
    widePane: !below(width, 1000, previous && !previous.widePane),
    windowResized,
  };
}

function sameLayout(a: WorkspaceLayout, b: WorkspaceLayout): boolean {
  return (Object.keys(a) as Array<keyof WorkspaceLayout>).every((key) => key === "windowResized" || a[key] === b[key]);
}

/** Without ResizeObserver (jsdom), the window stands in, held to what its media queries say about the mode. */
function windowSize(): { width: number; height: number } {
  const matches = (query: string) => window.matchMedia?.(query).matches ?? false;
  return {
    width: matches("(max-width: 639px)") ? Math.min(window.innerWidth, 639) : Math.max(window.innerWidth, 640),
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

/** The window's size, which a fold, an unfold or a rotation changes, and BB's pane resizing doesn't. */
const windowKey = () => `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`;

/**
 * The layout for `el`'s size as it resizes. It re-renders only when the layout changes, not on every frame of a pane
 * drag. It measures as `el` resizes, and as the window and its visual viewport do, then again a frame later: on a
 * phone the window's new size can arrive after the resize.
 */
export function useWorkspaceLayout(el: HTMLElement | null, state: LayoutState): WorkspaceLayout {
  const size = useRef<{ width: number; height: number; windowResized: boolean } | null>(null);
  const latest = useRef(state);
  latest.current = state;
  // The layout last rendered, which hysteresis keeps to.
  const shown = useRef<WorkspaceLayout | undefined>(undefined);
  const [, remeasured] = useReducer((count: number) => count + 1, 0);
  const { width, height, windowResized } = size.current ?? { ...windowSize(), windowResized: false };
  const next = workspaceLayout(width, height, state, shown.current, windowResized);
  const layout = shown.current && sameLayout(next, shown.current) ? shown.current : next;
  useLayoutEffect(() => { shown.current = layout; });
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    let windowWas = windowKey();
    const measure = ({ width, height: measured }: { width: number; height: number }) => {
      if (!(width > 0)) return;
      const height = Number.isFinite(measured) ? measured : windowSize().height;
      const windowIs = windowKey();
      const windowResized = windowIs !== windowWas;
      windowWas = windowIs;
      // The first measurement replaces the window's guess outright, rather than keeping to it.
      if (!size.current) shown.current = undefined;
      else if (size.current.width === width && size.current.height === height) return;
      size.current = { width, height, windowResized };
      if (!shown.current || !sameLayout(workspaceLayout(width, height, latest.current, shown.current, windowResized), shown.current)) remeasured();
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
      window.removeEventListener("resize", remeasure);
      window.visualViewport?.removeEventListener("resize", remeasure);
    };
  }, [el]);
  return layout;
}
