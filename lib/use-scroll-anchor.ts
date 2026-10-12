// When the code's box resizes (a fold, an unfold, a rotation, a side docking beside it), the lines above the one you're
// reading rewrap and move it on screen, as does its file's sticky header. The browser's own scroll anchoring doesn't
// reach into the diff's shadow DOM, so this keeps that line where it was: as far under the header as it was.
import { useEffect } from "react";

interface Anchor {
  el: Element;
  /** Its top, down from the top of what shows of the code: under a sticky header held at the box's top. */
  offset: number;
  /** The box's size it was read at: a resize moves it, and is for the resize to put right. */
  size: string;
}

/** The deepest element of `box` at a point, under whatever covers it there (a sheet), and inside open shadow roots. */
function deepestAt(box: HTMLElement, x: number, y: number): Element | null {
  let el = document.elementsFromPoint(x, y).find((at) => at !== box && box.contains(at)) ?? null;
  while (el?.shadowRoot) {
    const root = el.shadowRoot;
    // Where a shadow root can't list what's at a point, its topmost.
    const inner = root.elementsFromPoint ? root.elementsFromPoint(x, y).find((at) => at.getRootNode() === root) : root.elementFromPoint(x, y);
    if (!inner) break;
    el = inner;
  }
  return el;
}

/** The top of what shows of the code in `box`: under the file's sticky header held at its top, if one is. */
function codeTop(box: HTMLElement): number {
  const top = box.getBoundingClientRect().top;
  for (const header of Array.from(box.querySelectorAll("[data-file-header]"))) {
    const rect = header.getBoundingClientRect();
    if (rect.height && Math.abs(rect.top - top) < 1) return rect.bottom;
  }
  return top;
}

const sizeOf = (box: HTMLElement) => `${box.clientWidth}x${box.clientHeight}`;

/**
 * What has the focus, where it shows, such as the comment you're typing, unless it's taller than the box, such as a
 * file whose code has the focus (its shadow root's host); else the first line of code near the top of what shows,
 * looking down past what starts above it, such as a comment card half under the header, and past what isn't code, such
 * as the chapter's intro, which may fold away as the screen turns; else the first thing that starts there; or, failing
 * that, what's there.
 */
function anchorIn(box: HTMLElement): Anchor | null {
  const rect = box.getBoundingClientRect();
  if (!rect.height) return null;
  const x = rect.left + rect.width / 2;
  const top = codeTop(box);
  const focused = document.activeElement;
  if (focused && focused !== box && box.contains(focused)) {
    const { top: focusTop, bottom } = focused.getBoundingClientRect();
    if (bottom > top && focusTop < rect.bottom && bottom - focusTop <= rect.height) return { el: focused, offset: focusTop - top, size: sizeOf(box) };
  }
  let first: Element | null = null;
  let starting: Element | null = null;
  for (let y = top + 2; y < Math.min(rect.bottom, top + 240); y += 8) {
    const at = deepestAt(box, x, y);
    if (!at) continue;
    const line = at.closest("[data-line]");
    const starts = (line ?? at).getBoundingClientRect().top >= top - 2;
    if (line && starts) { first = line; starting = line; break; }
    first ??= line ?? at;
    if (starts) starting ??= at;
  }
  const el = starting ?? first;
  return el && { el, offset: el.getBoundingClientRect().top - top, size: sizeOf(box) };
}

/** Keeps what's at the top of the code in its scroll `box` in its place on screen as the box resizes. */
export function useScrollAnchor(box: HTMLElement | null) {
  useEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    let anchor = anchorIn(box);
    let frame = 0;
    // A scroll the browser makes as the box resizes comes before the resize is reported: the place is still the old one.
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!anchor || anchor.size === sizeOf(box)) anchor = anchorIn(box); });
    };
    // The box resized (a fold, a side docking beside it): what was at its top goes back there. Only what's in it did (a
    // comment unfolding, lines expanding above it): you saw that move the place, with no scroll, and it's where it went.
    const observer = new ResizeObserver(() => {
      const was = anchor;
      if (was?.el.isConnected && was.size !== sizeOf(box)) {
        const moved = was.el.getBoundingClientRect().top - codeTop(box) - was.offset;
        if (Math.abs(moved) >= 1) box.scrollTop += moved;
      }
      // Under a phone's sheet the code is inert, out of reach of a pointer, and of reading what's at one: the place
      // stays the one it was, where it is now.
      anchor = anchorIn(box) ?? (was?.el.isConnected ? { el: was.el, offset: was.el.getBoundingClientRect().top - codeTop(box), size: sizeOf(box) } : null);
    });
    observer.observe(box);
    // What's in the box too, as it comes and goes with the chapter.
    for (const child of Array.from(box.children)) observer.observe(child);
    const content = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => { if (node instanceof Element) observer.unobserve(node); });
        record.addedNodes.forEach((node) => { if (node instanceof Element) observer.observe(node); });
      }
    });
    content.observe(box, { childList: true });
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      content.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [box]);
}
