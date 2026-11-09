// Whether you've seen a card: it was in view, mostly, for a moment, in a window you could see.
import { useEffect, useRef, type RefObject } from "react";

/** How long a card stays in view before it counts as seen. */
const DWELL_MS = 800;

/**
 * Call `onSeen` once the element at `ref` has been in view for a moment while `active`: most of it, or a screenful of a
 * tall one. Where the browser can't tell (no IntersectionObserver), it never calls: nothing counts as seen unseen.
 */
export function useSeenInView(ref: RefObject<Element | null>, active: boolean, onSeen: () => void) {
  const seen = useRef(onSeen);
  seen.current = onSeen;
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      const inView = !!entry?.isIntersecting && (entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= 240);
      if (inView) timer = setTimeout(() => { if (document.visibilityState !== "hidden") seen.current(); }, DWELL_MS);
    }, { threshold: [0, 0.6, 1] });
    observer.observe(element);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [ref, active]);
}
