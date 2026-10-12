// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useKeyboardInset } from "./use-keyboard-inset";

afterEach(() => { cleanup(); document.body.innerHTML = ""; delete (window as { visualViewport?: unknown }).visualViewport; });

/** iOS's visual viewport, which an on-screen keyboard shrinks while the page keeps its size. */
function fakeViewport(page = 844) {
  const viewport = Object.assign(new EventTarget(), { height: page, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return {
    /** The keyboard comes up `keyboard` tall; iOS may also pan the visual viewport down `pan`. */
    show: (keyboard: number, pan = 0) => act(() => { viewport.height = page - keyboard; viewport.offsetTop = pan; viewport.dispatchEvent(new Event("resize")); }),
  };
}

/** The workspace under BB's 48px title bar, down to the bottom of a `page` tall. */
function workspace(page = 844, top = 48) {
  const root = document.createElement("div");
  const box = document.createElement("textarea");
  const button = document.createElement("button");
  root.append(box, button);
  document.body.append(root);
  root.getBoundingClientRect = () => new DOMRect(0, top, 390, page - top);
  box.scrollIntoView = vi.fn();
  return { root, box, button };
}

// Each phone's page in Safari and its keyboard with the suggestions bar (research/devices.md; most are estimates).
test.each([
  { key: "pm-portrait", page: 775, keyboard: 346 },
  { key: "pm-landscape", page: 430, keyboard: 219 },
  { key: "duo-outer", page: 598, keyboard: 290 },
  { key: "duo-outer-landscape", page: 386, keyboard: 230 },
  { key: "duo-inner-landscape", page: 589, keyboard: 264 },
  { key: "duo-inner-portrait", page: 869, keyboard: 350 },
  { key: "duo-split", page: 589, keyboard: 264 },
])("$key: typing, the workspace ends above its $keyboard px keyboard", ({ page, keyboard }) => {
  const viewport = fakeViewport(page);
  const { root, box } = workspace(page);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(keyboard);
  expect(root.style.getPropertyValue("--gr-kb")).toBe(`${keyboard}px`);
});

test("where iOS pans the page up to show the box, the workspace ends at what's left above the keyboard", () => {
  const viewport = fakeViewport(598);
  const { root, box } = workspace(598);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(290, 40);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("250px");
});

test("covering the window (full screen on an iPhone), it ends above the keyboard just the same", () => {
  const viewport = fakeViewport(598);
  const { root, box } = workspace(598, 0);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(290);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("290px");
});

test("while you type, the workspace ends above the keyboard, and the box you type in scrolls into view", async () => {
  const keyboard = fakeViewport();
  const { root, box } = workspace();
  renderHook(() => useKeyboardInset(root));
  expect(root.style.getPropertyValue("--gr-kb")).toBe("0px");
  act(() => box.focus());
  keyboard.show(336);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("336px");
  await vi.waitFor(() => expect(box.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  act(() => box.blur());
  expect(root.style.getPropertyValue("--gr-kb")).toBe("0px");
});

test("a smaller visual viewport without a box to type in, as when zooming, leaves the workspace as it is", () => {
  const viewport = fakeViewport();
  const { root, button } = workspace();
  renderHook(() => useKeyboardInset(root));
  act(() => button.focus());
  viewport.show(400);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("0px");
});

test("without a visual viewport there's nothing to do", () => {
  const { root, box } = workspace();
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  expect(root.style.getPropertyValue("--gr-kb")).toBe("");
});
