// How ] and [ step through a review's comments: its Comments list registers how, in the list's own order and filter.
// Until one has, the workspace steps through the draft's lines itself. Where a step landed shows over the code: as
// the touch step bar after going to a comment from an overlay or sheet, or as a brief hint on a desktop. The comment
// keys act on where a step landed, through the list too.
import { useSyncExternalStore } from "react";
import { revealedComment } from "./comments-fold";

/** Go to the next (1) or previous (-1) comment from `file`, the file you're on. */
export type CommentStepper = (direction: 1 | -1, file: string | undefined) => void;

const steppers = new Map<string, CommentStepper>();

/** Step the review's ] and [ with `stepper`. The returned function withdraws it, unless a newer one replaced it. */
export function registerCommentStepper(targetKey: string, stepper: CommentStepper): () => void {
  steppers.set(targetKey, stepper);
  return () => {
    if (steppers.get(targetKey) === stepper) steppers.delete(targetKey);
  };
}

/** Step through the review's comments, if its list registered how: false if it hasn't. */
export function stepComment(targetKey: string, direction: 1 | -1, file: string | undefined): boolean {
  const stepper = steppers.get(targetKey);
  stepper?.(direction, file);
  return !!stepper;
}

/** What a comment key (e, x, 0–4, r) does to the comment stepping last landed on: false when it does nothing to it. */
export type CommentKeyHandler = (key: string) => boolean;

const keyHandlers = new Map<string, CommentKeyHandler>();

/** Act on the review's comment keys with `handler`. The returned function withdraws it, unless a newer one replaced it. */
export function registerCommentKeys(targetKey: string, handler: CommentKeyHandler): () => void {
  keyHandlers.set(targetKey, handler);
  return () => {
    if (keyHandlers.get(targetKey) === handler) keyHandlers.delete(targetKey);
  };
}

/** A comment key pressed: whether it acted on the comment stepping last landed on. Any key drops an r not yet answered. */
export function actOnComment(targetKey: string, key: string): boolean {
  answerReply(targetKey);
  return keyHandlers.get(targetKey)?.(key) ?? false;
}

/** An r not yet answered, and the step it was pressed on: another step since makes it stale. */
const replies = new Map<string, { id: string; step: object | null }>();
const replyListeners = new Set<() => void>();

/** r on a GitHub thread: its card in the code opens its reply box, now or once it mounts, as the thread's file draws. */
export function askReply(targetKey: string, id: string) {
  replies.set(targetKey, { id, step: revealedComment(targetKey) });
  for (const listener of replyListeners) listener();
}

/** The card opened its reply box, or another key came: the r is done. */
export function answerReply(targetKey: string) {
  if (!replies.delete(targetKey)) return;
  for (const listener of replyListeners) listener();
}

/** The thread whose reply box r asked for, until its card answers, or another step or key comes. */
export function useReplyAsked(targetKey: string): { id: string } | null {
  const asked = useSyncExternalStore((listener) => {
    replyListeners.add(listener);
    return () => { replyListeners.delete(listener); };
  }, () => replies.get(targetKey) ?? null);
  return asked && asked.step === revealedComment(targetKey) ? asked : null;
}

/** Where stepping landed: the stop's place in the list's order and filter, and whether the bar or a hint shows it. */
export interface CommentStep {
  /** The item gone to. */
  id: string;
  /** From 0. */
  index: number;
  total: number;
  /** How many more the chip counts than the list shows, as resolved threads folded or nits hidden: "· 2 hidden". */
  hidden: number;
  /** The chip it steps in: "Not submitted". */
  filter: string;
  via: "bar" | "hint";
  /** A new step, even to the same place, shows the hint again. */
  nonce: number;
}

/** "2 of 5 · Not submitted", or "2 of 5 · All · 2 hidden" when the chip counts more. */
export const stepLabel = (step: CommentStep) => `${step.index + 1} of ${step.total} · ${step.filter}${step.hidden > 0 ? ` · ${step.hidden} hidden` : ""}`;

const steps = new Map<string, CommentStep>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Show where a step landed; null hides the bar or hint. */
export function showCommentStep(targetKey: string, step: CommentStep | null) {
  if (!step && !steps.has(targetKey)) return;
  if (step) steps.set(targetKey, step);
  else steps.delete(targetKey);
  for (const listener of listeners) listener();
}

export function useCommentStep(targetKey: string): CommentStep | null {
  return useSyncExternalStore(subscribe, () => steps.get(targetKey) ?? null);
}
