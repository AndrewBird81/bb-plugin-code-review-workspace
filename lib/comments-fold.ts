// Comments in the code folded to one-line pills (Fold comments, `i`): the ones you opened anyway, and the one you went
// to last, which opens too and flashes. Module state by review, since the cards render inside the diff.
import { useSyncExternalStore } from "react";

const opened = new Map<string, ReadonlySet<string>>();
// The reply boxes open in each card, by review: folding them all leaves those cards open, with their text and focus.
const writing = new Map<string, Map<string, number>>();
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

/** Folding or unfolding them all starts over, except for the cards you're writing a reply in. */
export function clearOpenComments(targetKey: string) {
  const current = opened.get(targetKey);
  if (!current?.size) return;
  const kept = [...current].filter((id) => writing.get(targetKey)?.has(id));
  if (kept.length === current.size) return;
  if (kept.length) opened.set(targetKey, new Set(kept));
  else opened.delete(targetKey);
  notify();
}

/** A reply box opened (`open`) or closed in a comment's card. The card opens with it, and stays open once it closes. */
export function setReplyWriting(targetKey: string, id: string, open: boolean) {
  const boxes = writing.get(targetKey) ?? new Map<string, number>();
  const count = (boxes.get(id) ?? 0) + (open ? 1 : -1);
  if (count > 0) boxes.set(id, count);
  else boxes.delete(id);
  if (boxes.size) writing.set(targetKey, boxes);
  else writing.delete(targetKey);
  if (open) setCommentOpen(targetKey, id, true);
}

/** The review closed: the comments opened and the one gone to last are forgotten, so it opens again as new. */
export function forgetOpenComments(targetKey: string) {
  if (!opened.has(targetKey) && !revealed.has(targetKey)) return;
  opened.delete(targetKey);
  revealed.delete(targetKey);
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
