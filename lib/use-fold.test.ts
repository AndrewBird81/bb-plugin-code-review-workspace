import { afterEach, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFold } from "./use-fold";

afterEach(() => { cleanup(); delete (window as { viewport?: unknown }).viewport; document.body.innerHTML = ""; });

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
