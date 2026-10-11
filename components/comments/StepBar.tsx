/**
 * Over the code, at the workspace's bottom: the bar that steps through the comments after you go to one, and the "need
 * you" pill that offers Comments. Until the comments are one list, neither shows.
 */
export function StepBar(_: {
  /** Lines are selected: the selection bar is in its place. */
  hidden: boolean;
  /** The review came back to you, or 0.5 left it on Feedback or Threads, and Comments couldn't open beside the code. */
  pill: boolean;
}) {
  return null;
}
