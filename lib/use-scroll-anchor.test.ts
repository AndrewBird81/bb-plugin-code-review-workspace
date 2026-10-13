import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useScrollAnchor } from "./use-scroll-anchor";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (document as { elementsFromPoint?: unknown }).elementsFromPoint; document.body.innerHTML = ""; });

/** A ResizeObserver whose `resize()` reports, and the elements it watches (`observed`). */
function stubResizeObserver() {
  let report: (() => void) | null = null;
  const observed = new Set<Element>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { observed.add(target); report = () => this.notify([], this as unknown as ResizeObserver); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { report = null; observed.clear(); }
  });
  return Object.assign(() => act(() => report?.()), { observed });
}

/**
 * The code's box at y 100, 380 × 500 (`held.width`, `held.height`) and scrolled to 300: lines 40px tall, under a file
 * header `header` px tall held at its top. jsdom has no layout, so positions come from `scrollTop` and a height per
 * line, which a resize changes as lines rewrap. `cover`: what a sheet over the code puts first at every point; `inert`:
 * the code can't be hit at all.
 */
function code({ header = 0, cover = null as Element | null, inert = false } = {}) {
  const box = document.body.appendChild(document.createElement("div"));
  const sticky = box.appendChild(document.createElement("div"));
  sticky.setAttribute("data-file-header", "");
  const lines = Array.from({ length: 30 }, (_, i) => {
    const line = box.appendChild(document.createElement("div"));
    line.dataset.line = String(i + 1);
    return line;
  });
  const heights = lines.map(() => 40);
  const held = { header, inert, width: 380, height: 500 };
  box.scrollTop = 300;
  Object.defineProperty(box, "clientWidth", { get: () => held.width });
  Object.defineProperty(box, "clientHeight", { get: () => held.height });
  box.getBoundingClientRect = () => new DOMRect(0, 100, held.width, held.height);
  sticky.getBoundingClientRect = () => new DOMRect(0, 100, 380, held.header);
  const topOf = (index: number) => 100 - box.scrollTop + heights.slice(0, index).reduce((sum, h) => sum + h, 0);
  lines.forEach((line, i) => { line.getBoundingClientRect = () => new DOMRect(0, topOf(i), 380, heights[i]); });
  document.elementsFromPoint = (_x: number, y: number) => {
    const line = held.inert ? undefined : lines.find((_, i) => y >= topOf(i) && y < topOf(i) + heights[i]);
    return [...(cover ? [cover] : []), ...(line ? [line, box] : held.inert ? [] : [box]), document.body];
  };
  return { box, lines, heights, held };
}
const under = (el: Element, header: number) => el.getBoundingClientRect().top - 100 - header;

test("as the box resizes and the lines above rewrap, the line at its top stays where it was", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  renderHook(() => useScrollAnchor(box));
  const reading = lines[7];
  const offset = under(reading, 0);
  // Unfolded, the lines above unwrap: each of the first seven is 20px shorter.
  for (let i = 0; i < 7; i++) heights[i] = 20;
  held.width = 900;
  resize();
  expect(box.scrollTop).toBe(160);
  expect(under(reading, 0)).toBe(offset);
});

test("it stays as far under the file's sticky header as it was, when the header itself rewraps", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code({ header: 100 });
  renderHook(() => useScrollAnchor(box));
  // The first line wholly under the 100px header: line 11 (index 10), 0px under it.
  const reading = lines[10];
  expect(under(reading, 100)).toBe(0);
  // Wider, the header takes one row instead of three, and the lines above unwrap.
  held.header = 44;
  held.width = 900;
  for (let i = 0; i < 10; i++) heights[i] = 30;
  resize();
  expect(under(reading, 44)).toBe(0);
});

test("turned and turned back, the line you read comes back where it was, though a line above it unwrapped into view meanwhile", async () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  // A long line wrapped to three rows, its first under the box's top: the first line wholly in view is the next.
  heights[7] = 120;
  renderHook(() => useScrollAnchor(box));
  const reading = lines[8];
  const offset = under(reading, 0);
  // Turned, it unwraps, and the lines above it are now first in view; turned back, it wraps again.
  heights[7] = 40;
  held.width = 900;
  resize();
  expect(under(reading, 0)).toBe(offset);
  // The scroll that put it back tells the box, as a scroll of yours would, a frame later.
  box.dispatchEvent(new Event("scroll"));
  await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
  heights[7] = 120;
  held.width = 380;
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("a resize that moves nothing, such as the keyboard shortening the box, scrolls nothing", () => {
  const resize = stubResizeObserver();
  const { box, held } = code();
  renderHook(() => useScrollAnchor(box));
  held.height = 210;
  resize();
  expect(box.scrollTop).toBe(300);
});

test("it reads the place again after you scroll, and keeps that one", async () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  renderHook(() => useScrollAnchor(box));
  box.scrollTop = 400;
  box.dispatchEvent(new Event("scroll"));
  await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
  const reading = lines[10];
  const offset = under(reading, 0);
  for (let i = 0; i < 10; i++) heights[i] = 60;
  held.width = 300;
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("with a sheet over the code it reads what's under the sheet, and keeps the place while the code can't be hit", () => {
  const resize = stubResizeObserver();
  const sheet = document.createElement("div");
  const { box, lines, heights, held } = code({ cover: sheet });
  renderHook(() => useScrollAnchor(box));
  const reading = lines[7];
  const offset = under(reading, 0);
  // On a phone the code under the sheet is inert: unfolded and folded again, the place is the same line.
  held.inert = true;
  for (let i = 0; i < 7; i++) heights[i] = 20;
  held.width = 900;
  resize();
  expect(under(reading, 0)).toBe(offset);
  for (let i = 0; i < 7; i++) heights[i] = 40;
  held.width = 380;
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("a line of code below what isn't code, such as the chapter's intro, is what stays, as the intro folds away", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  // The chapter's intro at the box's top, light DOM, not lines; the code under it.
  lines.forEach((line, i) => { if (i < 8) delete line.dataset.line; });
  box.scrollTop = 280;
  renderHook(() => useScrollAnchor(box));
  const reading = lines[8];
  const offset = under(reading, 0);
  // Held sideways, the intro folds 30px shorter.
  heights[7] = 10;
  Object.assign(held, { width: 900, height: 300 });
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("a line of code 270px down, under the chapter's intro and a re-review's switch over its files, is what stays as the intro folds away", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  lines.forEach((line, i) => { if (i < 8) delete line.dataset.line; });
  box.scrollTop = 50;
  renderHook(() => useScrollAnchor(box));
  const reading = lines[8];
  const offset = under(reading, 0);
  expect(offset).toBe(270);
  heights[3] = 10;
  Object.assign(held, { width: 900, height: 300 });
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("what has the focus in the code, such as the comment you're typing, is what stays where it was", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  const typing = lines[9].appendChild(document.createElement("textarea"));
  typing.getBoundingClientRect = () => lines[9].getBoundingClientRect();
  act(() => typing.focus());
  renderHook(() => useScrollAnchor(box));
  const offset = under(typing, 0);
  for (let i = 0; i < 9; i++) heights[i] = 25;
  held.width = 900;
  resize();
  expect(under(typing, 0)).toBe(offset);
});

test("after the fold, what the new layout redraws, such as comments unfolding, is put right too", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  renderHook(() => useScrollAnchor(box));
  const reading = lines[7];
  const offset = under(reading, 0);
  for (let i = 0; i < 7; i++) heights[i] = 20;
  held.width = 900;
  resize();
  expect(under(reading, 0)).toBe(offset);
  // The band appears over the code and a comment above unfolds: the box resizes again.
  heights[3] = 120;
  held.height = 456;
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("what grows above the line at the top with no scroll, such as a comment unfolding, moves it, and that's the place: a resize after it scrolls nothing", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  renderHook(() => useScrollAnchor(box));
  // A comment under line 7 unfolds 150px taller: line 8, at the top, moves down 150px with no scroll.
  heights[6] += 150;
  resize();
  expect(box.scrollTop).toBe(300);
  const reading = lines[7].getBoundingClientRect().top;
  // The box resizes and nothing rewraps, as when a phone's dock hides as you tap a line.
  held.height += 52;
  resize();
  expect(box.scrollTop).toBe(300);
  expect(lines[7].getBoundingClientRect().top).toBe(reading);
});

test("what has the focus but is taller than the box, such as a file whose code holds it, isn't the place: the line at the top is", () => {
  const resize = stubResizeObserver();
  const { box, lines, heights, held } = code();
  // Inside the diff's shadow DOM, the focus shows as the file's host: all of its code.
  const file = box.appendChild(document.createElement("div"));
  file.tabIndex = -1;
  file.getBoundingClientRect = () => new DOMRect(0, lines[0].getBoundingClientRect().top, 380, 1200);
  act(() => file.focus());
  renderHook(() => useScrollAnchor(box));
  const reading = lines[8];
  const offset = under(reading, 0);
  for (let i = 0; i < 7; i++) heights[i] = 20;
  held.width = 900;
  resize();
  expect(under(reading, 0)).toBe(offset);
});

test("it watches what's in the box as well as the box, as it comes and goes", async () => {
  const resize = stubResizeObserver();
  const { box, lines } = code();
  renderHook(() => useScrollAnchor(box));
  expect(resize.observed).toEqual(new Set([box, ...Array.from(box.children)]));
  const added = box.appendChild(document.createElement("div"));
  lines[0].remove();
  await act(() => Promise.resolve());
  expect(resize.observed.has(added)).toBe(true);
  expect(resize.observed.has(lines[0])).toBe(false);
});
