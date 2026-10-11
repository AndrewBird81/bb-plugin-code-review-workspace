// Where the review workspace puts its navigator and side panel, decided from the workspace's own size: BB's pane,
// not the window, so a narrow pane on a wide screen lays out like a small screen.
import { useLayoutEffect, useReducer, useRef } from "react";

/** The narrowest the code gets beside docked sides. */
export const READER_MIN = 560;
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
}

/** `value < threshold`, with the threshold moved HYSTERESIS toward what `was` decided; exact without it. */
function below(value: number, threshold: number, was: boolean | undefined): boolean {
  return value < threshold + (was === undefined ? 0 : was ? HYSTERESIS : -HYSTERESIS);
}

/** The code's width between the sides docked in `layout`. */
export function readerWidth(width: number, state: LayoutState, layout: Pick<WorkspaceLayout, "nav" | "panel">): number {
  return width - (layout.nav === "docked" ? state.navWidth : 0) - (layout.panel === "docked" ? state.panelWidth : 0);
}

/**
 * The layout for a workspace `width` × `height`, given the layout it had (`previous`) for hysteresis. A side docks only
 * while the code keeps READER_MIN, and the panel gets the room first; overlays never open by themselves.
 */
export function workspaceLayout(width: number, height: number, state: LayoutState, previous?: WorkspaceLayout): WorkspaceLayout {
  const mode: WorkspaceMode = below(height, 500, previous && previous.mode === "short") ? "short"
    : below(width, 640, previous && previous.mode === "phone") ? "phone" : "tablet";
  // Docked, a side stays docked down to HYSTERESIS under READER_MIN; anything else docks at READER_MIN.
  const fits = (room: number, docked: boolean) => mode === "tablet" && room >= READER_MIN - (docked ? HYSTERESIS : 0);
  const panelCanDock = fits(width - state.panelWidth, previous?.panel === "docked");
  const panel: PanelPlacement = state.panelOpen && panelCanDock ? "docked" : state.panelOpen && state.panelOverlay ? "overlay" : "closed";
  const navCanDock = fits(width - state.navWidth - (panel === "docked" ? state.panelWidth : 0), previous?.nav === "docked");
  const nav: NavPlacement = state.navOpen && navCanDock ? "docked" : state.navOverlay ? "overlay"
    : state.navOpen && panel === "docked" ? "suppressed" : "closed";
  return {
    mode, nav, panel, navCanDock, panelCanDock,
    narrowReader: below(readerWidth(width, state, { nav, panel }), 720, previous?.narrowReader),
    widePane: !below(width, 1000, previous && !previous.widePane),
  };
}

function sameLayout(a: WorkspaceLayout, b: WorkspaceLayout): boolean {
  return (Object.keys(a) as Array<keyof WorkspaceLayout>).every((key) => a[key] === b[key]);
}

/** Without ResizeObserver (jsdom), the window stands in, held to what its media queries say about the mode. */
function windowSize(): { width: number; height: number } {
  const matches = (query: string) => window.matchMedia?.(query).matches ?? false;
  return {
    width: matches("(max-width: 639px)") ? Math.min(window.innerWidth, 639) : Math.max(window.innerWidth, 640),
    height: matches("(max-height: 499px)") ? Math.min(window.innerHeight, 499) : Math.max(window.innerHeight, 500),
  };
}

/** The layout for `el`'s size as it resizes. It re-renders only when the layout changes, not on every frame of a pane drag. */
export function useWorkspaceLayout(el: HTMLElement | null, state: LayoutState): WorkspaceLayout {
  const size = useRef<{ width: number; height: number } | null>(null);
  const latest = useRef(state);
  latest.current = state;
  // The layout last rendered, which hysteresis keeps to.
  const shown = useRef<WorkspaceLayout | undefined>(undefined);
  const [, remeasured] = useReducer((count: number) => count + 1, 0);
  const { width, height } = size.current ?? windowSize();
  const next = workspaceLayout(width, height, state, shown.current);
  const layout = shown.current && sameLayout(next, shown.current) ? shown.current : next;
  useLayoutEffect(() => { shown.current = layout; });
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (width: number, height: number) => {
      // The first measurement replaces the window's guess outright, rather than keeping to it.
      if (!size.current) shown.current = undefined;
      size.current = { width, height: Number.isFinite(height) ? height : windowSize().height };
      if (!shown.current || !sameLayout(workspaceLayout(size.current.width, size.current.height, latest.current, shown.current), shown.current)) remeasured();
    };
    // Before the first paint, rather than when the observer first reports.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) measure(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return layout;
}
