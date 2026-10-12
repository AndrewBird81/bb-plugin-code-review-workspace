// How ] and [ step through a review's comments: its Comments list registers how, in the list's own order and filter.
// Until one has, the workspace steps through the draft's lines itself. Where a step landed shows over the code: as
// the touch step bar after going to a comment from an overlay or sheet, or as a brief hint on a desktop.
import { useSyncExternalStore } from "react";

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

/** Where stepping landed: the stop's place in the list's order and filter, and whether the bar or a hint shows it. */
export interface CommentStep {
  /** The item gone to. */
  id: string;
  /** From 0. */
  index: number;
  total: number;
  /** The chip it steps in: "Not submitted". */
  filter: string;
  via: "bar" | "hint";
  /** A new step, even to the same place, shows the hint again. */
  nonce: number;
}

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
