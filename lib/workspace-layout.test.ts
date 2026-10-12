import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { panelDockWidth, readerWidth, useWorkspaceLayout, workspaceLayout, type LayoutState, type WorkspaceLayout } from "./workspace-layout";

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

// The user's phones (lanes/00-devices.md): Safari's page, less BB's 48px title bar.
const DEVICES = {
  "pm-portrait": { width: 430, height: 727 },
  "pm-landscape": { width: 932, height: 382 },
  "duo-outer": { width: 382, height: 550 },
  "duo-outer-landscape": { width: 594, height: 338 },
  "duo-inner-landscape": { width: 951, height: 541 },
  "duo-inner-portrait": { width: 669, height: 821 },
  "duo-split": { width: 385, height: 541 },
};

describe("the user's phones", () => {
  const at = (key: keyof typeof DEVICES, state: LayoutState, previous?: WorkspaceLayout, phoneResized = false) =>
    workspaceLayout(DEVICES[key].width, DEVICES[key].height, state, previous, phoneResized);

  test.each(["pm-portrait", "duo-outer", "duo-split"] as const)("%s is a phone: the dock, and one sheet", (key) => {
    expect(at(key, both)).toMatchObject({ mode: "phone", nav: "closed", panel: "closed", navCanDock: false, panelCanDock: false });
    expect(at(key, { ...both, navOverlay: true })).toMatchObject({ mode: "phone", nav: "overlay" });
    expect(at(key, { ...both, panelOverlay: true })).toMatchObject({ mode: "phone", panel: "overlay" });
  });

  test.each(["pm-landscape", "duo-outer-landscape"] as const)("%s is short: the 40px band, and sides over the code", (key) => {
    expect(at(key, both)).toMatchObject({ mode: "short", nav: "closed", panel: "closed", navCanDock: false, panelCanDock: false });
    expect(at(key, { ...both, navOverlay: true, panelOverlay: true })).toMatchObject({ nav: "overlay", panel: "overlay" });
  });

  test("the unfolded Duo held sideways (951) docks the chapters, and Comments at 391 beside 560px of code", () => {
    expect(at("duo-inner-landscape", navOnly)).toMatchObject({ mode: "tablet", nav: "docked", narrowReader: true, widePane: false });
    expect(readerWidth(951, navOnly, at("duo-inner-landscape", navOnly))).toBe(663);
    expect(at("duo-inner-landscape", panelOnly)).toMatchObject({ mode: "tablet", panel: "docked" });
    expect(readerWidth(951, panelOnly, at("duo-inner-landscape", panelOnly))).toBe(560);
    // With both wanted the panel gets the room, and the chapters peek over the code from [≡].
    expect(at("duo-inner-landscape", both)).toMatchObject({ nav: "suppressed", panel: "docked" });
    expect(at("duo-inner-landscape", { ...both, navOverlay: true })).toMatchObject({ nav: "overlay", panel: "docked" });
  });

  test("the unfolded Duo upright (669) is a tablet whose sides open over the code", () => {
    expect(at("duo-inner-portrait", both)).toMatchObject({ mode: "tablet", nav: "closed", panel: "closed", navCanDock: false, panelCanDock: false, narrowReader: true });
    expect(at("duo-inner-portrait", { ...both, navOverlay: true })).toMatchObject({ nav: "overlay", panel: "closed" });
    expect(at("duo-inner-portrait", { ...both, panelOverlay: true })).toMatchObject({ nav: "closed", panel: "overlay" });
  });

  test("as a home-screen app the unfolded Duo's rail takes 84px: Comments opens over the code, the chapters still dock", () => {
    expect(workspaceLayout(951 - 84, 669 - 34 - 48, panelOnly)).toMatchObject({ mode: "tablet", panel: "closed", panelCanDock: false });
    expect(workspaceLayout(951 - 84, 669 - 34 - 48, navOnly)).toMatchObject({ nav: "docked" });
  });

  // Folding, unfolding and rotating resize the window: each goes from one key to the other and back.
  const PAIRS = [
    ["duo-outer", "duo-inner-portrait"], ["duo-outer", "duo-inner-landscape"], ["pm-portrait", "pm-landscape"],
    ["duo-outer", "duo-outer-landscape"], ["duo-inner-landscape", "duo-inner-portrait"], ["duo-split", "duo-inner-landscape"],
  ] as const;

  test.each(PAIRS)("%s ⇄ %s: the modes don't stick to the size before, nor flap", (a, b) => {
    const first = at(a, both);
    const there = at(b, both, first, true);
    expect(there.mode).toBe(at(b, both).mode);
    const back = at(a, both, there, true);
    expect(back.mode).toBe(first.mode);
    expect(at(b, both, back, true).mode).toBe(there.mode);
  });

  test.each(PAIRS)("%s ⇄ %s: an open panel stays open, docked where it fits and over the code where it doesn't", (a, b) => {
    // Opened where it was: docked if it fits, else over the code (the sheet, on a phone).
    let state = { ...panelOnly, panelOverlay: !at(a, panelOnly).panelCanDock };
    let layout = at(a, state);
    for (const key of [b, a, b, a]) {
      layout = at(key, state, layout, true);
      expect(layout.panel).toBe(at(key, panelOnly).panelCanDock ? "docked" : "overlay");
      // As the workspace does: docked, it was never opened over the code.
      if (layout.panel === "docked") state = { ...state, panelOverlay: false };
    }
  });

  test("folded while docked, Comments becomes the sheet; BB's pane narrowing instead hides it until there's room", () => {
    const docked = at("duo-inner-landscape", panelOnly);
    expect(docked.panel).toBe("docked");
    expect(at("duo-outer", panelOnly, docked, true)).toMatchObject({ mode: "phone", panel: "overlay" });
    expect(at("duo-inner-portrait", panelOnly, docked, true)).toMatchObject({ mode: "tablet", panel: "overlay" });
    expect(workspaceLayout(712, 984, panelOnly, docked)).toMatchObject({ panel: "closed" });
    // Over the code it stays there while it's open, whatever opened it.
    const sheet = at("duo-outer", panelOnly, docked, true);
    expect(at("duo-outer", panelOnly, sheet).panel).toBe("overlay");
    expect(at("duo-outer", { ...panelOnly, panelOpen: false }, sheet).panel).toBe("closed");
  });

  test("typing outside docked Comments, as in a comment in the code, a fold steps it aside rather than cover the box, and it docks again", () => {
    const docked = at("duo-inner-landscape", panelOnly);
    for (const typingIn of ["other", "nav"] as const) {
      const aside = at("duo-outer", { ...panelOnly, typingIn }, docked, true);
      expect(aside).toMatchObject({ mode: "phone", panel: "closed" });
      expect(at("duo-inner-portrait", { ...panelOnly, typingIn }, docked, true).panel).toBe("closed");
      expect(at("duo-inner-landscape", { ...panelOnly, typingIn }, aside, true).panel).toBe("docked");
    }
    // Typing in Comments itself, it goes with you.
    expect(at("duo-outer", { ...panelOnly, typingIn: "panel" }, docked, true).panel).toBe("overlay");
  });

  test("chapters opened over the code and docked by an unfold go back over it as it folds; BB's pane narrowing, or typing elsewhere, hides them", () => {
    const opened = { ...navOnly, navOverlay: true };
    const docked = at("duo-inner-landscape", opened, at("duo-outer", opened), true);
    expect(docked.nav).toBe("docked");
    expect(at("duo-outer", opened, docked, true).nav).toBe("overlay");
    expect(at("duo-outer", { ...opened, typingIn: "nav" }, docked, true).nav).toBe("overlay");
    expect(at("duo-outer", { ...opened, typingIn: "other" }, docked, true).nav).toBe("closed");
    expect(workspaceLayout(800, 541, opened, docked)).toMatchObject({ nav: "closed", navCanDock: false });
  });
});

test("modes switch at 600 wide and 500 tall, and only 16px past that once decided", () => {
  expect(workspaceLayout(599, 800, closed).mode).toBe("phone");
  expect(workspaceLayout(600, 800, closed).mode).toBe("tablet");
  expect(workspaceLayout(1200, 499, closed).mode).toBe("short");
  expect(workspaceLayout(1200, 500, closed).mode).toBe("tablet");
  const tablet = workspaceLayout(700, 800, closed);
  expect(workspaceLayout(590, 800, closed, tablet).mode).toBe("tablet");
  expect(workspaceLayout(583, 800, closed, tablet).mode).toBe("phone");
  const phone = workspaceLayout(560, 800, closed);
  expect(workspaceLayout(610, 800, closed, phone).mode).toBe("phone");
  expect(workspaceLayout(616, 800, closed, phone).mode).toBe("tablet");
  const short = workspaceLayout(1200, 400, closed);
  expect(workspaceLayout(1200, 510, closed, short).mode).toBe("short");
  expect(workspaceLayout(1200, 516, closed, short).mode).toBe("tablet");
  expect(workspaceLayout(1200, 490, closed, tablet).mode).toBe("tablet");
  // The unfolded Duo held sideways beside BB's thread list is a tablet, whatever it was before; the phones stay phones,
  // and held sideways, short.
  expect(workspaceLayout(631, 541, closed).mode).toBe("tablet");
  expect(workspaceLayout(631, 541, closed, phone).mode).toBe("tablet");
  for (const width of [382, 385, 390, 430]) expect(workspaceLayout(width, 550, closed).mode).toBe("phone");
  expect(workspaceLayout(594, 338, closed).mode).toBe("short");
  expect(workspaceLayout(612, 382, closed).mode).toBe("short");
});

test("the panel docks narrower, down to 320, rather than squeeze the code under 560", () => {
  expect(panelDockWidth(960, 400)).toBe(400);
  expect(panelDockWidth(900, 400)).toBe(340);
  expect(panelDockWidth(880, 400)).toBe(320);
  expect(panelDockWidth(860, 400)).toBe(320);
  expect(panelDockWidth(1400, 400)).toBe(400);
  expect(reader(900, 800, panelOnly)).toBe(560);
  expect(reader(880, 800, panelOnly)).toBe(560);
});

// Where §3.1 opens a panel saved wider than its room over the code, it docks narrower: code at 560 beats an overlay.
test.each([
  { pane: "iPad landscape, BB's thread list open", width: 1056, height: 984, panelWidth: 640, docked: 496 },
  { pane: "desktop 1440, BB's thread list open", width: 1120, height: 852, panelWidth: 640, docked: 560 },
  { pane: "iPad portrait, thread list collapsed", width: 978, height: 1328, panelWidth: 640, docked: 418 },
])("$pane ($width) with a panel saved at $panelWidth: it docks at $docked beside 560px of code, the chapters suppressed", ({ width, height, panelWidth, docked }) => {
  const state = { ...both, panelWidth };
  expect(workspaceLayout(width, height, state)).toMatchObject({ mode: "tablet", nav: "suppressed", panel: "docked" });
  expect(panelDockWidth(width, panelWidth)).toBe(docked);
  expect(reader(width, height, state)).toBe(560);
});

test("a docked side stays docked until the code is 16px under 560, and docks again at 560", () => {
  const docked = workspaceLayout(960, 800, panelOnly);
  expect(docked.panel).toBe("docked");
  const narrowed = workspaceLayout(900, 800, panelOnly, docked);
  expect(narrowed.panel).toBe("docked");
  // At its narrowest, the code gives way 16px.
  const squeezed = workspaceLayout(865, 800, panelOnly, narrowed);
  expect(squeezed.panel).toBe("docked");
  expect(readerWidth(865, panelOnly, squeezed)).toBe(545);
  // Out of room, a panel that was docked closes rather than covering the code: BB's pane narrowed, not the window.
  const out = workspaceLayout(863, 800, panelOnly, squeezed);
  expect(out).toMatchObject({ panel: "closed", panelCanDock: false });
  expect(workspaceLayout(879, 800, panelOnly, out).panel).toBe("closed");
  expect(workspaceLayout(880, 800, panelOnly, out).panel).toBe("docked");
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

  /** The window's size, as documentElement's client size, which a fold or a rotation changes. */
  function stubWindow(width: number, height: number) {
    const size = { width, height };
    const root = document.documentElement;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => size.width });
    Object.defineProperty(root, "clientHeight", { configurable: true, get: () => size.height });
    restores.push(() => { delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; });
    return (next: { width: number; height: number }) => Object.assign(size, next);
  }

  test("a keyboard over a phone, which pads the workspace's bottom, doesn't turn it into a phone held sideways", () => {
    const resize = stubResizeObserver({ width: 382, height: 550 });
    const el = document.body.appendChild(document.createElement("div"));
    restores.push(() => el.remove());
    const { result } = renderHook(() => useWorkspaceLayout(el, both));
    expect(result.current.mode).toBe("phone");
    el.style.paddingBottom = "290px";
    resize({ width: 382, height: 260 });
    expect(result.current.mode).toBe("phone");
  });

  /** A touch screen's pointer, or a desktop's. */
  function stubPointer(pointer: "coarse" | "fine") {
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(pointer: coarse)" && pointer === "coarse", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    restores.push(() => media.mockRestore());
  }

  test("folded with Comments docked, the window resizes and Comments becomes the sheet; BB's pane narrowing hides it", () => {
    stubPointer("coarse");
    const resize = stubResizeObserver({ width: 951, height: 541 });
    const window = stubWindow(951, 589);
    const el = document.createElement("div");
    const { result } = renderHook(() => useWorkspaceLayout(el, panelOnly));
    expect(result.current).toMatchObject({ panel: "docked", phoneResized: false });
    window({ width: 382, height: 598 });
    resize({ width: 382, height: 550 });
    expect(result.current).toMatchObject({ mode: "phone", panel: "overlay", phoneResized: true });
    window({ width: 951, height: 589 });
    resize({ width: 951, height: 541 });
    expect(result.current).toMatchObject({ mode: "tablet", panel: "docked" });
    resize({ width: 712, height: 541 });
    expect(result.current).toMatchObject({ panel: "closed", phoneResized: false });
  });

  test.each([
    { resize: "a desktop's window narrowing", pointer: "fine", from: { width: 1440, height: 900 }, to: { width: 1000, height: 900 } },
    { resize: "a desktop's window snapping to a phone's size", pointer: "fine", from: { width: 951, height: 589 }, to: { width: 382, height: 598 } },
    { resize: "an iPad turning", pointer: "coarse", from: { width: 1376, height: 1032 }, to: { width: 1032, height: 1376 } },
    { resize: "an iPad going to half its screen in Split View", pointer: "coarse", from: { width: 1376, height: 1032 }, to: { width: 678, height: 1032 } },
  ] as const)("$resize hides docked Comments, as BB's pane narrowing does, rather than open it over the code", ({ pointer, from, to }) => {
    stubPointer(pointer);
    const resize = stubResizeObserver({ width: 1056, height: 984 });
    const window = stubWindow(from.width, from.height);
    const el = document.createElement("div");
    const { result } = renderHook(() => useWorkspaceLayout(el, panelOnly));
    expect(result.current.panel).toBe("docked");
    window(to);
    resize({ width: 600, height: 984 });
    expect(result.current).toMatchObject({ panel: "closed", phoneResized: false });
  });

  test("a fold whose pane follows the window a frame late still carries docked Comments over the code", () => {
    stubPointer("coarse");
    const size = { width: 951, height: 541 };
    const resize = stubResizeObserver(size);
    const window = stubWindow(951, 589);
    const el = document.createElement("div");
    el.getBoundingClientRect = () => new DOMRect(0, 48, size.width, size.height);
    const { result } = renderHook(() => useWorkspaceLayout(el, panelOnly));
    expect(result.current.panel).toBe("docked");
    // The window has folded, and is measured as it reports so, while BB's pane is still the size it was.
    window({ width: 382, height: 598 });
    act(() => { globalThis.window.dispatchEvent(new Event("resize")); });
    expect(result.current.panel).toBe("docked");
    resize({ width: 382, height: 550 });
    expect(result.current).toMatchObject({ mode: "phone", panel: "overlay" });
  });

  test("measures again as the window resizes, before the observer reports, and a frame later", async () => {
    stubResizeObserver({ width: 951, height: 541 });
    const el = document.createElement("div");
    const { result } = renderHook(() => useWorkspaceLayout(el, panelOnly));
    expect(result.current.mode).toBe("tablet");
    el.getBoundingClientRect = () => new DOMRect(0, 48, 382, 550);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(result.current.mode).toBe("phone");
    el.getBoundingClientRect = () => new DOMRect(0, 48, 669, 821);
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    await vi.waitFor(() => expect(result.current.mode).toBe("tablet"));
  });

  test("without ResizeObserver, the window's media queries decide the mode", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    restores.push(() => vi.unstubAllGlobals());
    const phone = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(max-width: 599px)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    restores.push(() => phone.mockRestore());
    const el = document.createElement("div");
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("phone");
    phone.mockImplementation((query: string) => ({ matches: query === "(max-height: 499px)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("short");
    phone.mockImplementation((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    expect(renderHook(() => useWorkspaceLayout(el, both)).result.current.mode).toBe("tablet");
  });
});
