import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFold } from "./use-fold";

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); delete (window as { viewport?: unknown }).viewport; document.body.innerHTML = ""; restores.splice(0).forEach((restore) => restore()); });

/** The Viewport Segments API, as Chrome on a foldable or Safari 27.1 with its flag reports it. */
function fakeSegments(segments: DOMRect[] | null) {
  const viewport = { segments };
  Object.defineProperty(window, "viewport", { configurable: true, value: viewport });
  return (next: DOMRect[] | null) => act(() => { viewport.segments = next; window.dispatchEvent(new Event("resize")); });
}

function workspace(rect: DOMRect) {
  const el = document.body.appendChild(document.createElement("div"));
  el.getBoundingClientRect = () => rect;
  return el;
}

// The unfolded iPhone Duo held sideways, partly folded: the fold is 40px, x 455.5–495.5.
const LEFT = new DOMRect(0, 0, 455.5, 589);
const RIGHT = new DOMRect(495.5, 0, 455.5, 589);

test("a fold down the screen, across the workspace, tells where its far edge is", () => {
  fakeSegments([LEFT, RIGHT]);
  const el = workspace(new DOMRect(0, 48, 951, 541));
  renderHook(() => useFold(el));
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("496px");
});

test("from the workspace's left, beside BB's thread list, and as the fold comes and goes", () => {
  const fold = fakeSegments([new DOMRect(0, 0, 951, 589)]);
  const el = workspace(new DOMRect(320, 48, 631, 541));
  renderHook(() => useFold(el));
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("");
  fold([LEFT, RIGHT]);
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("176px");
  fold([new DOMRect(0, 0, 951, 589)]);
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("");
});

test("nothing for a fold across the screen, one outside the workspace, or without the API", () => {
  fakeSegments([new DOMRect(0, 0, 669, 455.5), new DOMRect(0, 495.5, 669, 455.5)]);
  const upright = workspace(new DOMRect(0, 48, 669, 821));
  renderHook(() => useFold(upright));
  expect(upright.style.getPropertyValue("--gr-fold-end")).toBe("");
  fakeSegments([LEFT, RIGHT]);
  const right = workspace(new DOMRect(500, 48, 451, 541));
  renderHook(() => useFold(right));
  expect(right.style.getPropertyValue("--gr-fold-end")).toBe("");
  delete (window as { viewport?: unknown }).viewport;
  const plain = workspace(new DOMRect(0, 48, 951, 541));
  renderHook(() => useFold(plain));
  expect(plain.style.getPropertyValue("--gr-fold-end")).toBe("");
});

/** No Viewport Segments API, as in Safari 27.1 by default: a window `width` × `height`, touched or not. */
function fakeWindow(width: number, height: number, coarse = true) {
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => height });
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(pointer: coarse)" && coarse, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
  restores.push(() => {
    delete (root as { clientWidth?: number }).clientWidth;
    delete (root as { clientHeight?: number }).clientHeight;
    matchMedia.mockRestore();
  });
}

test("without the API, the unfolded Duo held sideways takes its window's middle, and 24px either side, for the fold", () => {
  // A home-screen app on the inner screen: the window is the screen, 951 wide; the fold, about x 455–496.
  fakeWindow(951, 669);
  const el = workspace(new DOMRect(0, 0, 951, 669));
  renderHook(() => useFold(el, true));
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("500px");
});

test("without the API, nothing taken for a fold but on a touch screen whose phone's window is held sideways with a tablet's layout", () => {
  const fold = (width: number, height: number, unfolded: boolean, coarse = true) => {
    fakeWindow(width, height, coarse);
    const el = workspace(new DOMRect(0, 0, width, height));
    renderHook(() => useFold(el, unfolded));
    const end = el.style.getPropertyValue("--gr-fold-end");
    cleanup();
    restores.splice(0).forEach((restore) => restore());
    return end;
  };
  // A phone held sideways has a short layout: the folded Duo, the 14 Pro Max.
  expect(fold(594, 386, false)).toBe("");
  expect(fold(932, 430, false)).toBe("");
  // Upright, the fold runs across the screen; an iPad's window and a desktop's have none.
  expect(fold(669, 951, true)).toBe("");
  expect(fold(1376, 1032, true)).toBe("");
  expect(fold(951, 589, true, false)).toBe("");
});

test("where the API says there's no fold, as Chrome does on a phone that doesn't fold, nothing is taken for one", () => {
  fakeSegments([new DOMRect(0, 0, 951, 589)]);
  fakeWindow(951, 589);
  const el = workspace(new DOMRect(0, 48, 951, 541));
  renderHook(() => useFold(el, true));
  expect(el.style.getPropertyValue("--gr-fold-end")).toBe("");
});
