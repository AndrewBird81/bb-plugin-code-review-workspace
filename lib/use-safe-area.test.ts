import { afterEach, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSafeArea } from "./use-safe-area";

const restores: Array<() => void> = [];
afterEach(() => { cleanup(); for (const restore of restores.splice(0)) restore(); document.body.innerHTML = ""; });

/** A window `width` × `height`, as documentElement's client size. */
function stubWindow(width: number, height: number) {
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: height });
  restores.push(() => { delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; });
}

function workspace(rect: DOMRect) {
  const el = document.body.appendChild(document.createElement("div"));
  el.getBoundingClientRect = () => rect;
  return el;
}

const safe = (el: HTMLElement, side: string) => el.style.getPropertyValue(`--gr-safe-${side}`);

test("covering the window (full screen on an iPhone), it keeps clear of each edge's whole inset", () => {
  stubWindow(382, 598);
  const el = workspace(new DOMRect(0, 0, 382, 598));
  renderHook(() => useSafeArea(el));
  for (const side of ["top", "right", "bottom", "left"]) expect(safe(el, side)).toBe(`max(0px, env(safe-area-inset-${side}) - 0px)`);
});

test("under BB's title bar and beside its thread list, only what of each inset reaches it", () => {
  stubWindow(932, 430);
  const el = workspace(new DOMRect(320, 48, 612, 382));
  renderHook(() => useSafeArea(el));
  expect(safe(el, "top")).toBe("max(0px, env(safe-area-inset-top) - 48px)");
  expect(safe(el, "left")).toBe("max(0px, env(safe-area-inset-left) - 320px)");
  expect(safe(el, "right")).toBe("max(0px, env(safe-area-inset-right) - 0px)");
  expect(safe(el, "bottom")).toBe("max(0px, env(safe-area-inset-bottom) - 0px)");
});

test("as the window resizes (a rotation), again", () => {
  stubWindow(430, 775);
  let rect = new DOMRect(0, 48, 430, 727);
  const el = workspace(rect);
  el.getBoundingClientRect = () => rect;
  renderHook(() => useSafeArea(el));
  expect(safe(el, "right")).toBe("max(0px, env(safe-area-inset-right) - 0px)");
  // BB keeps its pane 59px clear of each side held sideways.
  stubWindow(932, 430);
  rect = new DOMRect(59, 48, 814, 382);
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(safe(el, "left")).toBe("max(0px, env(safe-area-inset-left) - 59px)");
  expect(safe(el, "right")).toBe("max(0px, env(safe-area-inset-right) - 59px)");
});
