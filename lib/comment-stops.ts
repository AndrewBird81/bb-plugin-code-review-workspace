// How ] and [ step through a review's comments: its Comments list registers how, in the list's own order and filter.
// Until one has, the workspace steps through the draft's lines itself.

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
