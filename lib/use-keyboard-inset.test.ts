// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useKeyboardInset } from "./use-keyboard-inset";

const restores: Array<() => void> = [];
afterEach(() => { cleanup(); document.body.innerHTML = ""; delete (window as { visualViewport?: unknown }).visualViewport; restores.splice(0).forEach((restore) => restore()); });

/** A window `width` × `height`, as documentElement's client size. */
function stubWindow(width: number, height: number) {
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: height });
  restores.push(() => { delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; });
}

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

test("with the keyboard up, the workspace says whether it leaves a phone held sideways' room or less", () => {
  // The Duo folded sideways: 386 tall, less BB's bar, less a 230px keyboard, leaves 108.
  stubWindow(594, 386);
  const short = fakeViewport(386);
  const { root, box } = workspace(386);
  renderHook(() => useKeyboardInset(root));
  expect(root.hasAttribute("data-keyboard")).toBe(false);
  act(() => box.focus());
  short.show(230);
  expect(root.getAttribute("data-keyboard")).toBe("short");
  act(() => box.blur());
  expect(root.hasAttribute("data-keyboard")).toBe(false);
});

test("held sideways, a 13\" iPad's keyboard leaves less than a phone held sideways has, and the band stays: only a phone's gives way", () => {
  // Safari's page on the 13" iPad held sideways is about 960 tall; its keyboard, with the suggestions bar, about 440.
  stubWindow(1376, 960);
  const viewport = fakeViewport(960);
  const { root, box } = workspace(960);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(440);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("440px");
  expect(root.getAttribute("data-keyboard")).toBe("up");
});

test("an iPad's keyboard leaves room to spare", () => {
  const viewport = fakeViewport(1376);
  const { root, box } = workspace(1376);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(400);
  expect(root.getAttribute("data-keyboard")).toBe("up");
});

test("a box taller than the room above the keyboard shows its top, where you type, under the file's sticky header", async () => {
  const viewport = fakeViewport(386);
  const root = document.createElement("div");
  const scroller = root.appendChild(document.createElement("div"));
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { value: 290 });
  // The diff's box scrolls sideways only, and so has overflow-y auto too.
  const sideways = scroller.appendChild(document.createElement("div"));
  sideways.style.overflowX = "auto";
  sideways.style.overflowY = "auto";
  const header = scroller.appendChild(document.createElement("div"));
  header.style.position = "sticky";
  const name = header.appendChild(document.createElement("span"));
  const box = sideways.appendChild(document.createElement("textarea"));
  document.body.append(root);
  root.getBoundingClientRect = () => new DOMRect(0, 48, 594, 338);
  scroller.scrollTop = 500;
  // Brought into view at its end, its top sits 40px under the header held at 48–112.
  box.scrollIntoView = vi.fn();
  box.getBoundingClientRect = () => new DOMRect(0, 72, 500, 80);
  header.getBoundingClientRect = () => new DOMRect(0, 48, 594, 64);
  document.elementsFromPoint = () => [name, header, scroller, root];
  try {
    renderHook(() => useKeyboardInset(root));
    act(() => box.focus());
    viewport.show(230);
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(460));
    expect(box.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  } finally {
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  }
});

/** A comment box with its buttons (`data-keyboard-box`) `height` tall, in the code's box showing 48–308 above the folded Duo's keyboard. */
function boxWithButtons(height: number) {
  const root = document.createElement("div");
  const scroller = root.appendChild(document.createElement("div"));
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { value: 260 });
  const whole = scroller.appendChild(document.createElement("div"));
  whole.setAttribute("data-keyboard-box", "");
  const field = whole.appendChild(document.createElement("textarea"));
  whole.appendChild(document.createElement("button"));
  document.body.append(root);
  root.getBoundingClientRect = () => new DOMRect(0, 48, 382, 550);
  scroller.getBoundingClientRect = () => new DOMRect(0, 48, 382, 260);
  whole.getBoundingClientRect = () => new DOMRect(0, 200, 382, height);
  field.getBoundingClientRect = () => new DOMRect(10, 210, 362, 80);
  whole.scrollIntoView = vi.fn();
  field.scrollIntoView = vi.fn();
  return { root, whole, field };
}

test("where the box fits above the keyboard with its buttons, all of it scrolls into view", async () => {
  const viewport = fakeViewport(598);
  const { root, whole, field } = boxWithButtons(250);
  renderHook(() => useKeyboardInset(root));
  act(() => field.focus());
  viewport.show(290);
  await vi.waitFor(() => expect(whole.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  expect(field.scrollIntoView).not.toHaveBeenCalled();
});

test("where the box with its buttons is taller than the room above the keyboard, its text box shows", async () => {
  const viewport = fakeViewport(598);
  const { root, whole, field } = boxWithButtons(270);
  renderHook(() => useKeyboardInset(root));
  act(() => field.focus());
  viewport.show(290);
  await vi.waitFor(() => expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  expect(whole.scrollIntoView).not.toHaveBeenCalled();
});

test("as what holds the workspace scrolls, bringing the box into view, the workspace's end follows", () => {
  const viewport = fakeViewport(598);
  const { root, box } = workspace(598);
  renderHook(() => useKeyboardInset(root));
  act(() => box.focus());
  viewport.show(290);
  expect(root.style.getPropertyValue("--gr-kb")).toBe("290px");
  // BB's frame scrolled 58px to show the box: the workspace's bottom is at 540, 232 of it under the keyboard.
  root.getBoundingClientRect = () => new DOMRect(0, -10, 390, 550);
  act(() => { document.body.dispatchEvent(new Event("scroll")); });
  expect(root.style.getPropertyValue("--gr-kb")).toBe("232px");
});
