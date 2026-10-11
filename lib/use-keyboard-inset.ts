// An on-screen keyboard covers the bottom of the page without resizing it (iOS shrinks only the visual viewport), so
// what's under it, such as the comment box you're typing in, can't be scrolled into view.
import { useEffect } from "react";
import { TEXT_FIELD } from "./review-shortcuts";

/**
 * While you type, how much of `el` the keyboard covers, as `--gr-kb` on it, for its layout to end above the keyboard;
 * and the box you type in, scrolled into view once it does. 0px while you don't, so zooming doesn't count.
 */
export function useKeyboardInset(el: HTMLElement | null) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!el || !viewport) return;
    let frame = 0;
    const update = () => {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && el.contains(active) && (active.isContentEditable || !!active.closest(TEXT_FIELD));
      const covered = typing ? Math.max(0, Math.round(el.getBoundingClientRect().bottom - viewport.offsetTop - viewport.height)) : 0;
      if (el.style.getPropertyValue("--gr-kb") === `${covered}px`) return;
      el.style.setProperty("--gr-kb", `${covered}px`);
      cancelAnimationFrame(frame);
      if (covered) frame = requestAnimationFrame(() => (active as HTMLElement).scrollIntoView({ block: "nearest" }));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      el.style.removeProperty("--gr-kb");
    };
  }, [el]);
}
