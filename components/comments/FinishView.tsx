/**
 * Finish review, the side panel's view for it: the summary, the verdict, what goes to GitHub and what stays in BB, and
 * Submit. Until it has a body of its own, Comments shows the draft for it, since the draft's panel mounts only once.
 */
export function FinishView(_: {
  /** Finish is the panel's view. */
  shown: boolean;
  /** The review revision the page shows, for draft changes. */
  revision: string;
}) {
  return null;
}
