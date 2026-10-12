// An on-screen keyboard covers the bottom of the page without resizing it (iOS shrinks only the visual viewport), so
// what's under it, such as the comment box you're typing in, can't be scrolled into view. BB may shrink its pane to
// what shows above the keyboard itself, so the keyboard covers none of the workspace: it's up all the same.
import { useEffect } from "react";
import { TEXT_FIELD } from "./review-shortcuts";
import { SHORT_BELOW, phoneWindow } from "./workspace-layout";

/** Less than this between the window's height and what shows of it is a browser's bar or a keyboard's shortcuts, not a keyboard. */
const KEYBOARD_LEAST = 120;

/**
 * Brings the box you type in into view with its buttons (`data-keyboard-box`), all of it where it fits above the
 * keyboard; where it doesn't, the field's top, where you type. Either way not under a sticky header held over what
 * scrolls, such as a file's over the code.
 */
function bringIntoView(field: HTMLElement, viewport: VisualViewport) {
  let scroller = field.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const shown = scroller?.getBoundingClientRect();
  const room = Math.min(shown?.bottom ?? Infinity, viewport.offsetTop + viewport.height) - Math.max(shown?.top ?? 0, viewport.offsetTop);
  const whole = field.closest<HTMLElement>("[data-keyboard-box]");
  const box = whole && whole.getBoundingClientRect().height <= room ? whole : field;
  box.scrollIntoView({ block: "nearest" });
  const { left, top } = box.getBoundingClientRect();
  let cover: Element | null = document.elementsFromPoint?.(left + 8, top + 2)[0] ?? null;
  if (!cover || box.contains(cover)) return;
  while (cover && getComputedStyle(cover).position !== "sticky") cover = cover.parentElement;
  if (cover && scroller?.contains(cover)) scroller.scrollTop -= cover.getBoundingClientRect().bottom - top;
}

/**
 * While you type, how much of `el` the keyboard covers, as `--gr-kb` on it, for its layout to end above the keyboard;
 * and the box you type in, scrolled into view once it does, and again once the keyboard's gone, for its buttons where
 * they didn't fit above it. 0px while you don't, so zooming doesn't count. And `data-keyboard` on it while the keyboard
 * is up: "short" where it leaves no more room than a phone held sideways has, for what's over the code to give way, as a
 * phone's dock does. Only in a phone's window: an iPad's bars stay over its keyboard, as its own apps' do.
 */
export function useKeyboardInset(el: HTMLElement | null) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!el || !viewport) return;
    let frame = 0;
    let timer = 0;
    let shown = false;
    // The text field you typed in with the keyboard up, until the keyboard's gone.
    let lastField: HTMLElement | null = null;
    // Once the workspace's new size is laid out and reported, after the frame: as the code's box resizes,
    // lib/use-scroll-anchor.ts keeps what was showing where it was.
    const bringSoon = (field: HTMLElement) => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(() => { timer = window.setTimeout(() => bringIntoView(field, viewport)); });
    };
    const update = () => {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && el.contains(active) && (active.isContentEditable || !!active.closest(TEXT_FIELD));
      const rect = el.getBoundingClientRect();
      const covered = typing ? Math.max(0, Math.round(rect.bottom - viewport.offsetTop - viewport.height)) : 0;
      // Zoomed in, the visual viewport is smaller by its scale: that isn't a keyboard.
      const keyboard = window.innerHeight - viewport.height * (viewport.scale || 1) >= KEYBOARD_LEAST;
      const up = covered > 0 || (typing && keyboard);
      if (!up) el.removeAttribute("data-keyboard");
      else el.setAttribute("data-keyboard", rect.height - covered < SHORT_BELOW && phoneWindow() ? "short" : "up");
      if (up) lastField = active as HTMLElement;
      else if (lastField && !keyboard) {
        // Gone, as with Done: what the keyboard's room hid comes back, and the box may now show whole.
        if (lastField.isConnected) bringSoon(lastField);
        lastField = null;
      }
      if (el.style.getPropertyValue("--gr-kb") === `${covered}px` && up === shown) return;
      shown = up;
      el.style.setProperty("--gr-kb", `${covered}px`);
      if (up) bringSoon(active as HTMLElement);
      // Going, not gone yet: the box comes into view once it is.
      else if (lastField) { cancelAnimationFrame(frame); clearTimeout(timer); }
    };
    update();
    // BB resizing its pane after the keyboard came up, rather than the keyboard covering it.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    // What holds the workspace can scroll too, as a box you focus is brought into view: the workspace moves with it.
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer?.disconnect();
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      window.removeEventListener("scroll", update, true);
      el.style.removeProperty("--gr-kb");
      el.removeAttribute("data-keyboard");
    };
  }, [el]);
}
