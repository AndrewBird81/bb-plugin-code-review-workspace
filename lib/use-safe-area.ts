// A phone keeps parts of its screen clear: the notch or Dynamic Island, the Duo's rail, the home indicator. A page
// learns them as env(safe-area-inset-*), each from the window's edge, while BB's frame may already keep its pane clear
// of them; so the workspace keeps clear of what's left of each, side by side.
import { useLayoutEffect } from "react";

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Sets `--gr-safe-top|right|bottom|left` on `el`: how far each edge's inset reaches into it, which is the inset less
 * how far `el` already sits from that edge of the window. 0 where BB's frame keeps it clear, or there's no inset.
 */
export function useSafeArea(el: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const { clientWidth, clientHeight } = document.documentElement;
      const gaps = { top: rect.top, right: clientWidth - rect.right, bottom: clientHeight - rect.bottom, left: rect.left };
      for (const side of SIDES) el.style.setProperty(`--gr-safe-${side}`, `max(0px, env(safe-area-inset-${side}) - ${Math.max(0, Math.round(gaps[side]))}px)`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      for (const side of SIDES) el.style.removeProperty(`--gr-safe-${side}`);
    };
  }, [el]);
}
