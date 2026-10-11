// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useKeyboardInset } from "./use-keyboard-inset";

afterEach(() => { cleanup(); document.body.innerHTML = ""; delete (window as { visualViewport?: unknown }).visualViewport; });

/** iOS's visual viewport, which an on-screen keyboard shrinks while the page keeps its size. */
function fakeViewport() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return { show: (keyboard: number) => act(() => { viewport.height = 844 - keyboard; viewport.dispatchEvent(new Event("resize")); }) };
}

function workspace() {
  const root = document.createElement("div");
  const box = document.createElement("textarea");
  const button = document.createElement("button");
  root.append(box, button);
  document.body.append(root);
  root.getBoundingClientRect = () => new DOMRect(0, 48, 390, 796);
  box.scrollIntoView = vi.fn();
  return { root, box, button };
}

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
