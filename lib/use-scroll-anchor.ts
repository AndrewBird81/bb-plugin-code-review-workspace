// When the code's box resizes (a fold, an unfold, a rotation, a side docking beside it), the lines above the one you're
// reading rewrap and move it on screen, as does its file's sticky header. The browser's own scroll anchoring doesn't
// reach into the diff's shadow DOM, so this keeps that line where it was: as far under the header as it was.
import { useCallback, useEffect, useRef } from "react";
import type { LinePlace } from "./remount";

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

/** How far down the top of what shows of the code a line of code is looked for: past a chapter's intro and its switch. */
const LOOK_DOWN = 300;

/**
 * What has the focus, where it shows, such as the comment you're typing, unless it's taller than the box, such as a
 * file whose code has the focus (its shadow root's host); else the first line of code near the top of what shows,
 * looking down past what starts above it, such as a comment card half under the header, and past what isn't code, such
 * as the chapter's intro, which may fold away as the screen turns, and a re-review's switch over its files; else the
 * first thing that starts there; or, failing that, what's there.
 */
function anchorIn(box: HTMLElement, focus = true): Anchor | null {
  const rect = box.getBoundingClientRect();
  if (!rect.height) return null;
  const x = rect.left + rect.width / 2;
  const top = codeTop(box);
  const focused = document.activeElement;
  if (focus && focused && focused !== box && box.contains(focused)) {
    const { top: focusTop, bottom } = focused.getBoundingClientRect();
    if (bottom > top && focusTop < rect.bottom && bottom - focusTop <= rect.height) return { el: focused, offset: focusTop - top, size: sizeOf(box) };
  }
  let first: Element | null = null;
  let starting: Element | null = null;
  for (let y = top + 2; y < Math.min(rect.bottom, top + LOOK_DOWN); y += 8) {
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

/**
 * Where you are in the code in `box`, as the resize anchor keeps it: the box you're typing in, else the line of code at
 * the top of what shows, by its file and its index in pierre's diff rather than by pixels; and how far under the top.
 * Where a new workspace goes back to (lib/remount.ts). Null where there's neither.
 */
export function linePlace(box: HTMLElement): LinePlace | null {
  const anchor = anchorIn(box);
  if (anchor && anchor.el === document.activeElement) return { focus: true, offset: anchor.offset };
  const index = anchor?.el.getAttribute("data-line-index");
  const host = anchor && (anchor.el.getRootNode() as ShadowRoot).host;
  const file = index && host?.closest("[data-file]")?.getAttribute("data-file");
  return anchor && index && file ? { file, index, offset: anchor.offset } : null;
}

/** Scrolls `box` to put `place` as far under the code's top as it was: how far off it still is, or null while it isn't there. */
export function goToPlace(box: HTMLElement, place: LinePlace): number | null {
  let target: Element | null | undefined;
  if ("focus" in place) target = document.activeElement !== box && box.contains(document.activeElement) ? document.activeElement : null;
  else {
    const file = Array.from(box.querySelectorAll("[data-file]")).find((el) => el.getAttribute("data-file") === place.file);
    target = file?.querySelector("diffs-container")?.shadowRoot?.querySelector(`[data-line][data-line-index="${place.index}"]`);
  }
  if (!target) return null;
  box.scrollTop += target.getBoundingClientRect().top - codeTop(box) - place.offset;
  return Math.abs(target.getBoundingClientRect().top - codeTop(box) - place.offset);
}

/** A line of code by its numbers, which hold as a flip shows or hides the hunks above it: its index doesn't. */
const lineKey = (line: Element) => ["data-line-type", "data-line", "data-alt-line"].map((name) => line.getAttribute(name)).join(" ");

/** The lines of code `file` draws, in order down each column. */
const linesOf = (file: Element) => Array.from(file.querySelectorAll("diffs-container"), (host) => Array.from(host.shadowRoot?.querySelectorAll("[data-line]") ?? [])).flat();

/**
 * Where you are in the code as a chapter flips between Since your review and All changes, which shows more or fewer of
 * its files and hunks: the file at the box's top and the files after it; in it, the line at the top of what shows of
 * the code and the lines after it in its column, by their numbers, and how far under that top. Where the file has no
 * lines drawn (folded, or waiting to draw), how far under the box's top the file's own top is.
 */
export interface FlipPlace { file: string; after: string[]; lines: string[]; offset: number }

export function flipPlace(box: HTMLElement): FlipPlace | null {
  const boxTop = box.getBoundingClientRect().top;
  const files = Array.from(box.querySelectorAll<HTMLElement>("[data-file]"));
  const at = files.findIndex((el) => el.getBoundingClientRect().bottom > boxTop);
  if (at < 0) return null;
  const file = files[at];
  const place = { file: file.dataset.file!, after: files.slice(at + 1).map((el) => el.dataset.file!) };
  const top = codeTop(box);
  const lines = linesOf(file).filter((el) => el.getBoundingClientRect().height);
  // The first that starts at that top or under it; past the last, the last.
  const line = lines.find((el) => el.getBoundingClientRect().top >= top - 2) ?? lines.at(-1);
  if (!line) return { ...place, lines: [], offset: file.getBoundingClientRect().top - boxTop };
  const column = Array.from(line.parentElement!.children).filter((el) => el.hasAttribute("data-line"));
  return { ...place, lines: column.slice(column.indexOf(line)).map(lineKey), offset: line.getBoundingClientRect().top - top };
}

/**
 * Scrolls `box` to put a flip's `place` back: the first of its lines still shown, as far under the code's top as it
 * was; else the top of the first file after it still shown, or of the last file shown; or the chapter's top. Its file
 * shown but not drawn yet, it waits, at the file.
 */
export function goToFlipPlace(box: HTMLElement, place: FlipPlace) {
  const boxTop = box.getBoundingClientRect().top;
  const files = Array.from(box.querySelectorAll<HTMLElement>("[data-file]"));
  const file = files.find((el) => el.dataset.file === place.file);
  if (file && !place.lines.length) return void (box.scrollTop += file.getBoundingClientRect().top - boxTop - place.offset);
  if (file) {
    const drawn = new Map(linesOf(file).map((el) => [lineKey(el), el]));
    // Not drawn yet: a large chapter draws a file only as it nears the screen, so it's gone to, to draw.
    if (!drawn.size) {
      if (file.querySelector("[data-pending-diff]")) box.scrollTop += file.getBoundingClientRect().top - boxTop;
      return;
    }
    const line = place.lines.map((key) => drawn.get(key)).find((el) => el);
    // Twice: putting it back can stick or unstick a file's header at the top, which moves the code's top.
    if (line) return void [0, 1].forEach(() => { box.scrollTop += line.getBoundingClientRect().top - codeTop(box) - place.offset; });
  }
  const next = place.after.map((name) => files.find((el) => el.dataset.file === name)).find((el) => el) ?? files.at(-1);
  if (next) box.scrollTop += next.getBoundingClientRect().top - boxTop;
  else box.scrollTop = 0;
}

/**
 * Keeps what's at the top of the code in its scroll `box` in its place on screen as the box resizes. Returns what takes
 * what's at the top now as that place, where the code changed under it without a scroll.
 */
export function useScrollAnchor(box: HTMLElement | null) {
  const reanchor = useRef(() => {});
  useEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    let anchor = anchorIn(box);
    reanchor.current = () => { anchor = anchorIn(box); };
    let frame = 0;
    // Where the last correction left the box: its scroll event is this, not yours.
    let corrected: number | null = null;
    // A scroll the browser makes as the box resizes comes before the resize is reported: the place is still the old one.
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if ((!anchor || anchor.size === sizeOf(box)) && box.scrollTop !== corrected) anchor = anchorIn(box); });
    };
    // The box resized (a fold, a side docking beside it): what was at its top goes back there. Only what's in it did (a
    // comment unfolding, lines expanding above it): you saw that move the place, with no scroll, and it's where it went.
    const observer = new ResizeObserver(() => {
      const was = anchor;
      if (was?.el.isConnected && was.size !== sizeOf(box)) {
        // Twice: putting it back can stick or unstick a file's header at the top, which moves the code's top.
        for (let pass = 0; pass < 2; pass++) {
          const moved = was.el.getBoundingClientRect().top - codeTop(box) - was.offset;
          if (Math.abs(moved) < 1) break;
          box.scrollTop += moved;
          corrected = box.scrollTop;
        }
        // Still the place, where it now is: read again, a line above it that unwrapped into view would take its place,
        // and turning back would keep that one there instead.
        anchor = { el: was.el, offset: was.el.getBoundingClientRect().top - codeTop(box), size: sizeOf(box) };
        return;
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
      reanchor.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      content.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [box]);
  return useCallback(() => reanchor.current(), []);
}
