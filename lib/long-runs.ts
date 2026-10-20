import type { FileDiffMetadata } from "@pierre/diffs";

/** A change block deleting this many more lines than it adds folds the rest of them. */
export const LONG_RUN_MIN = 40;
/** The first lines of a folded run that show above its fold row. */
export const LONG_RUN_HEAD = 3;
/** A fold row's height, as drawnHeight() counts it: LongRunFold's h-8, and its pointer-coarse:h-11 on a touch screen. */
export const FOLD_ROW = 32;
export const FOLD_ROW_COARSE = 44;

/**
 * A long run of deleted lines: a change block's deletions past the ones its additions pair with, which a split draws
 * against an empty side and unified as one stretch of the block. All by old line numbers.
 */
export interface LongRun {
  /** The run's first and last lines. */
  first: number;
  last: number;
  /** The last line shown above the fold row, which pierre draws as this line's annotation. */
  anchor: number;
  /** The lines folded, and how many. */
  from: number;
  to: number;
  count: number;
}

/**
 * The file's long runs of deleted lines, each keeping its first `head` lines and folding the rest behind one row.
 * Added lines never fold: they're the change under review.
 */
export function longRuns(fileDiff: FileDiffMetadata, { min = LONG_RUN_MIN, head = LONG_RUN_HEAD } = {}): LongRun[] {
  const runs: LongRun[] = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        oldLine += part.lines;
        continue;
      }
      if (part.deletions - part.additions >= min) {
        const first = oldLine + part.additions;
        const last = oldLine + part.deletions - 1;
        runs.push({ first, last, anchor: first + head - 1, from: first + head, to: last, count: last - first + 1 - head });
      }
      oldLine += part.deletions;
    }
  }
  return runs;
}

/** The runs, by index, that fold any of these old lines away, or whose fold row shares a line with one of them. */
export function runsHolding(runs: readonly LongRun[], lines: readonly number[]): number[] {
  return runs.flatMap((run, index) => (lines.some((line) => line >= run.anchor && line <= run.to) ? [index] : []));
}
