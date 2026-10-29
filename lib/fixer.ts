// Whether a PR's review sends to a fixer (notes/design/E7-plan.md Part 2 §5): one answer for the server's routes and
// messages and the page's buttons, so none of them tells a fixer to check out the PR's branch.
import type { MainThread, ReviewLifecycle } from "../src/store";

/** A thread the review started to fix the PR, fresh or forked, at its head: recorded so as it was made, before any send. */
export const isFixer = (main: Partial<MainThread> | null | undefined): boolean => !!main?.fixer;

/**
 * Whether the review's Sends start, and go to, a fixer at its PR's head: a PR with no folder of its own, or whose folder
 * BB removed, or that reads a fresh thread's worktree since (`workBranch`), or whose main thread is a fixer.
 */
export const usesFixer = (review: Pick<ReviewLifecycle, "feature" | "mainThread"> & { kind?: "pr" | "ref" }): boolean =>
  review.kind === "pr" && (!review.feature || !!review.feature.folderGone || !!review.feature.workBranch || isFixer(review.mainThread));
