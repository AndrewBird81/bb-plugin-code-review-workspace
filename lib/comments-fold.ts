// Comments in the code folded to one-line pills (Fold comments, `i`): the ones you opened anyway, and the one you went
// to last, which opens too and flashes. Module state by review, since the cards render inside the diff.
import { useSyncExternalStore } from "react";

const opened = new Map<string, ReadonlySet<string>>();
const revealed = new Map<string, { id: string; nonce: number }>();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notify() {
  for (const listener of listeners) listener();
}

/** Show a folded comment in full, or fold it again. */
export function setCommentOpen(targetKey: string, id: string, open: boolean) {
  const current = opened.get(targetKey) ?? NONE;
  if (current.has(id) === open) return;
  const next = new Set(current);
  if (open) next.add(id);
  else next.delete(id);
  opened.set(targetKey, next);
  notify();
}

/** Folding or unfolding them all starts over. */
export function clearOpenComments(targetKey: string) {
  if (!opened.get(targetKey)?.size) return;
  opened.delete(targetKey);
  notify();
}

/** Went to a comment, from the list or with ] and [: it opens, and shows where it is. */
export function revealComment(targetKey: string, id: string) {
  setCommentOpen(targetKey, id, true);
  revealed.set(targetKey, { id, nonce: Date.now() });
  notify();
}

export function useCommentOpen(targetKey: string | null | undefined, id: string): boolean {
  return useSyncExternalStore(subscribe, () => !!targetKey && (opened.get(targetKey) ?? NONE).has(id));
}

/** The comment last gone to, and when, so its card can flash once. */
export function useRevealedComment(targetKey: string | null | undefined): { id: string; nonce: number } | null {
  return useSyncExternalStore(subscribe, () => (targetKey ? revealed.get(targetKey) ?? null : null));
}
