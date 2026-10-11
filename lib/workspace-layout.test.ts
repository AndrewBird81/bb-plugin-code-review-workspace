import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { readerWidth, useWorkspaceLayout, workspaceLayout, type LayoutState, type WorkspaceLayout } from "./workspace-layout";

const closed: LayoutState = { navWidth: 288, panelWidth: 400, navOpen: false, navOverlay: false, panelOpen: false, panelOverlay: false };
const navOnly = { ...closed, navOpen: true };
const panelOnly = { ...closed, panelOpen: true };
const both = { ...closed, navOpen: true, panelOpen: true };
const reader = (width: number, height: number, state: LayoutState) => readerWidth(width, state, workspaceLayout(width, height, state));

// The spec's pane widths (BB's title bar takes 48px of the height), with the navigator only, the panel only, and both wanted.
describe.each([
  { pane: "desktop 1440, BB's thread list open", width: 1120, height: 852, nav: 832, panel: 720, both: { nav: "suppressed", reader: 720 } },
  { pane: "desktop 1440, thread list collapsed", width: 1388, height: 852, nav: 1100, panel: 988, both: { nav: "docked", reader: 700 } },
  { pane: "iPad landscape, thread list open", width: 1056, height: 984, nav: 768, panel: 656, both: { nav: "suppressed", reader: 656 } },
  { pane: "iPad landscape, thread list collapsed", width: 1322, height: 984, nav: 1034, panel: 922, both: { nav: "docked", reader: 634 } },
  { pane: "iPad portrait, thread list collapsed", width: 978, height: 1328, nav: 690, panel: 578, both: { nav: "suppressed", reader: 578 } },
])("$pane ($width)", ({ width, height, nav, panel, both: expected }) => {
  test("the navigator alone docks", () => {
    expect(workspaceLayout(width, height, navOnly)).toMatchObject({ mode: "tablet", nav: "docked", panel: "closed" });
    expect(reader(width, height, navOnly)).toBe(nav);
  });
  test("the panel alone docks", () => {
    expect(workspaceLayout(width, height, panelOnly)).toMatchObject({ mode: "tablet", nav: "closed", panel: "docked" });
    expect(reader(width, height, panelOnly)).toBe(panel);
  });
  test(`with both, the panel docks and the navigator is ${expected.nav}`, () => {
    expect(workspaceLayout(width, height, both)).toMatchObject({ mode: "tablet", nav: expected.nav, panel: "docked" });
    expect(reader(width, height, both)).toBe(expected.reader);
  });
});

test("iPad portrait with BB's thread list open (712): neither side docks, and each opens only over the code", () => {
  expect(workspaceLayout(712, 1328, both)).toMatchObject({ mode: "tablet", nav: "closed", panel: "closed", navCanDock: false, panelCanDock: false });
  expect(workspaceLayout(712, 1328, { ...both, navOverlay: true })).toMatchObject({ nav: "overlay", panel: "closed" });
  expect(workspaceLayout(712, 1328, { ...both, panelOverlay: true })).toMatchObject({ nav: "closed", panel: "overlay" });
  expect(reader(712, 1328, { ...both, navOverlay: true, panelOverlay: true })).toBe(712);
});

test.each([524, 790, 844])("a phone held sideways (%i × 342) is short: nothing docks, and sides open only over the code", (width) => {
  expect(workspaceLayout(width, 342, both)).toMatchObject({ mode: "short", nav: "closed", panel: "closed", navCanDock: false, panelCanDock: false });
  expect(workspaceLayout(width, 342, { ...both, navOverlay: true, panelOverlay: true })).toMatchObject({ nav: "overlay", panel: "overlay" });
});

test("a phone (390 × 796) gets phone mode, where an open side is the sheet", () => {
  expect(workspaceLayout(390, 796, both)).toMatchObject({ mode: "phone", nav: "closed", panel: "closed" });
  expect(workspaceLayout(390, 796, { ...both, panelOverlay: true })).toMatchObject({ mode: "phone", panel: "overlay" });
});

test("modes switch at 640 wide and 500 tall, and only 16px past that once decided", () => {
  expect(workspaceLayout(639, 800, closed).mode).toBe("phone");
  expect(workspaceLayout(640, 800, closed).mode).toBe("tablet");
  expect(workspaceLayout(1200, 499, closed).mode).toBe("short");
  expect(workspaceLayout(1200, 500, closed).mode).toBe("tablet");
  const tablet = workspaceLayout(700, 800, closed);
  expect(workspaceLayout(630, 800, closed, tablet).mode).toBe("tablet");
  expect(workspaceLayout(623, 800, closed, tablet).mode).toBe("phone");
  const phone = workspaceLayout(600, 800, closed);
  expect(workspaceLayout(650, 800, closed, phone).mode).toBe("phone");
  expect(workspaceLayout(656, 800, closed, phone).mode).toBe("tablet");
  const short = workspaceLayout(1200, 400, closed);
  expect(workspaceLayout(1200, 510, closed, short).mode).toBe("short");
  expect(workspaceLayout(1200, 516, closed, short).mode).toBe("tablet");
  expect(workspaceLayout(1200, 490, closed, tablet).mode).toBe("tablet");
});

test("a docked side stays docked until the code is 16px under 560, and docks again at 560", () => {
  const docked = workspaceLayout(960, 800, panelOnly);
  expect(docked.panel).toBe("docked");
  const squeezed = workspaceLayout(945, 800, panelOnly, docked);
  expect(squeezed.panel).toBe("docked");
  // Out of room, a panel that was docked closes rather than covering the code.
  const out = workspaceLayout(943, 800, panelOnly, squeezed);
  expect(out).toMatchObject({ panel: "closed", panelCanDock: false });
  expect(workspaceLayout(959, 800, panelOnly, out).panel).toBe("closed");
  expect(workspaceLayout(960, 800, panelOnly, out).panel).toBe("docked");
});

test("a panel opened over the code docks once there's room, and goes back over the code without it", () => {
  const overlay = workspaceLayout(712, 1328, { ...panelOnly, panelOverlay: true });
  expect(overlay.panel).toBe("overlay");
  const docked = workspaceLayout(1056, 984, { ...panelOnly, panelOverlay: true }, overlay);
  expect(docked.panel).toBe("docked");
  expect(workspaceLayout(712, 1328, { ...panelOnly, panelOverlay: true }, docked).panel).toBe("overlay");
});

test("a suppressed navigator peeks over the code, and docks again when the panel closes", () => {
  expect(workspaceLayout(1120, 852, { ...both, navOverlay: true })).toMatchObject({ nav: "overlay", panel: "docked" });
  const suppressed = workspaceLayout(1120, 852, both);
  expect(suppressed).toMatchObject({ nav: "suppressed", navCanDock: false });
  expect(workspaceLayout(1120, 852, navOnly, suppressed)).toMatchObject({ nav: "docked", panel: "closed" });
});

test("a navigator you hid stays hidden, and opens over the code only from its toggle", () => {
  expect(workspaceLayout(1120, 852, closed)).toMatchObject({ nav: "closed", navCanDock: true });
  expect(workspaceLayout(1120, 852, { ...closed, panelOpen: true })).toMatchObject({ nav: "closed", navCanDock: false });
  expect(workspaceLayout(1120, 852, { ...closed, panelOpen: true, navOverlay: true }).nav).toBe("overlay");
});

test("the navigator yields to the docked panel even where it couldn't dock alone, and stays closed once the panel closes", () => {
  const wide = { ...both, navWidth: 560 };
  expect(workspaceLayout(1100, 852, wide)).toMatchObject({ nav: "suppressed", panel: "docked" });
  expect(workspaceLayout(1100, 852, { ...wide, panelOpen: false })).toMatchObject({ nav: "closed", navCanDock: false });
  expect(workspaceLayout(1120, 852, { ...wide, panelOpen: false })).toMatchObject({ nav: "docked" });
});

test("the code is narrow under 720px, and the pane wide from 1000px, each 16px sticky", () => {
  expect(workspaceLayout(1120, 852, both).narrowReader).toBe(false);
  expect(workspaceLayout(1000, 852, panelOnly).narrowReader).toBe(true);
  const narrow = workspaceLayout(712, 1328, closed);
  expect(narrow.narrowReader).toBe(true);
  expect(workspaceLayout(730, 1328, closed, narrow).narrowReader).toBe(true);
  expect(workspaceLayout(736, 1328, closed, narrow).narrowReader).toBe(false);
  expect(workspaceLayout(999, 852, closed).widePane).toBe(false);
  const wide = workspaceLayout(1000, 852, closed);
  expect(wide.widePane).toBe(true);
  expect(workspaceLayout(990, 852, closed, wide).widePane).toBe(true);
  expect(workspaceLayout(983, 852, closed, wide).widePane).toBe(false);
});

describe("useWorkspaceLayout", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { for (const restore of restores.splice(0)) restore(); });
  /** A ResizeObserver that reports `size` on observe, and again whenever `resize` changes it. */
  function stubResizeObserver(size: { width: number; height: number }) {
    const original = globalThis.ResizeObserver;
    let report: (() => void) | null = null;
    globalThis.ResizeObserver = class {
      constructor(private notify: ResizeObserverCallback) {}
      observe(target: Element) { report = () => this.notify([{ target, contentRect: { ...size } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); report(); }
      unobserve() {}
      disconnect() { report = null; }
    } as unknown as typeof ResizeObserver;
    restores.push(() => { globalThis.ResizeObserver = original; });
    return (next: { width: number; height: number }) => { Object.assign(size, next); act(() => report?.()); };
  }

  test("follows the element's size, re-rendering only when the layout changes", () => {
    const resize = stubResizeObserver({ width: 1120, height: 852 });
    const el = document.createElement("div");
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useWorkspaceLayout(el, both); });
    expect(result.current).toMatchObject({ mode: "tablet", nav: "suppressed", panel: "docked" });
    const first: WorkspaceLayout = result.current;
    const rendered = renders;
    resize({ width: 1110, height: 852 });
    expect(renders).toBe(rendered);
    expect(result.current).toBe(first);
    resize({ width: 712, height: 1328 });
    expect(result.current).toMatchObject({ nav: "closed", panel: "closed" });
    resize({ width: 390, height: 796 });
    expect(result.current.mode).toBe("phone");
  });

  test("recomputes with the current size when the state changes", () => {
    const resize = stubResizeObserver({ width: 1120, height: 852 });
    const el = document.createElement("div");
    const { result, rerender } = renderHook(({ state }) => useWorkspaceLayout(el, state), { initialProps: { state: navOnly } });
    resize({ width: 1400, height: 852 });
    expect(result.current.nav).toBe("docked");
    rerender({ state: both });
    expect(result.current).toMatchObject({ nav: "docked", panel: "docked" });
  });

  test("without ResizeObserver, the window's media queries decide the mode", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    restores.push(() => vi.unstubAllGlobals());
    const phone = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(max-width: 639px)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    restores.push(() => phone.mockRestore());
    const el = document.createElement("div");
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("phone");
    phone.mockImplementation((query: string) => ({ matches: query === "(max-height: 499px)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("short");
    phone.mockImplementation((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("tablet");
  });
});
