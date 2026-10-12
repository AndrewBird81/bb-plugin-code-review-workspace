// A foldable's fold, where the browser says where it is: the Viewport Segments API (Chrome on Android foldables; Safari
// 27.1 on an iPhone Duo behind a flag that's off by default). Where the browser has no such API, the unfolded Duo's held
// sideways is taken to be at its window's middle.
import { useLayoutEffect } from "react";
import { phoneWindow } from "./workspace-layout";

interface ViewportSegments {
  segments: ReadonlyArray<DOMRectReadOnly> | null;
}

/** Either side of the window's middle, what's taken for the fold where the browser can't say: the Duo's is about 40px. */
export const FOLD_HALF = 24;

/**
 * Where a fold runs down the window, its edges' x: between two segments side by side, as the browser reports them;
 * else, with no such API, in a phone's window held sideways on a touch screen with a tablet's layout (`unfolded`: only
 * the iPhone Duo's inner screen), the window's middle, FOLD_HALF either side (estimated). Null for none.
 */
function foldDown(unfolded: boolean): { start: number; end: number } | null {
  const viewport = (window as { viewport?: ViewportSegments }).viewport;
  if (viewport && "segments" in viewport) {
    const [first, second, ...more] = viewport.segments ?? [];
    // Side by side, the fold is between them; one above the other, it runs across, and the sides already span it.
    return first && second && !more.length && second.left >= first.right ? { start: first.right, end: second.left } : null;
  }
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  if (!unfolded || width <= height || !phoneWindow({ width, height }) || !window.matchMedia?.("(pointer: coarse)").matches) return null;
  return { start: width / 2 - FOLD_HALF, end: width / 2 + FOLD_HALF };
}

/**
 * Sets `--gr-fold-end` on `el` while a fold runs down the screen across it: how far the fold's far edge is from `el`'s
 * left, inside its padding, for what opens over the code from the right to keep to the fold's other side. `unfolded`:
 * `el` has a tablet's layout, which in a phone's window held sideways is the unfolded iPhone Duo's.
 */
export function useFold(el: HTMLElement | null, unfolded = false) {
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => {
      const fold = foldDown(unfolded);
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const left = rect.left + (parseFloat(style.paddingLeft) || 0);
      const right = rect.right - (parseFloat(style.paddingRight) || 0);
      if (!fold || fold.end <= left || fold.start >= right) el.style.removeProperty("--gr-fold-end");
      else el.style.setProperty("--gr-fold-end", `${Math.round(fold.end - left)}px`);
    };
    update();
    const posture = (navigator as { devicePosture?: EventTarget }).devicePosture;
    window.addEventListener("resize", update);
    posture?.addEventListener("change", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      posture?.removeEventListener("change", update);
      observer?.disconnect();
      el.style.removeProperty("--gr-fold-end");
    };
  }, [el, unfolded]);
}
