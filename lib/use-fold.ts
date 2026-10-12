// A foldable's fold, where the browser says where it is: the Viewport Segments API (Chrome on Android foldables; Safari
// 27.1 on an iPhone Duo behind a flag that's off by default). Without it nothing changes.
import { useLayoutEffect } from "react";

interface ViewportSegments {
  segments: ReadonlyArray<DOMRectReadOnly> | null;
}

/**
 * Sets `--gr-fold-end` on `el` while a fold runs down the screen across it: how far the fold's far edge is from `el`'s
 * left, inside its padding, for what opens over the code from the right to keep to the fold's other side.
 */
export function useFold(el: HTMLElement | null) {
  useLayoutEffect(() => {
    const viewport = (window as { viewport?: ViewportSegments }).viewport;
    if (!el || !viewport || !("segments" in viewport)) return;
    const update = () => {
      const [first, second, ...more] = viewport.segments ?? [];
      // Side by side, the fold is between them; one above the other, it runs across, and the sides already span it.
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const left = rect.left + (parseFloat(style.paddingLeft) || 0);
      const right = rect.right - (parseFloat(style.paddingRight) || 0);
      if (!first || !second || more.length || second.left < first.right || second.left <= left || first.right >= right) el.style.removeProperty("--gr-fold-end");
      else el.style.setProperty("--gr-fold-end", `${Math.round(second.left - left)}px`);
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
  }, [el]);
}
