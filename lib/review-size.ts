// How much there is to read in a review: changed lines, without the files a reviewer skims.
import { patchRows, splitPatchByFile } from "../src/patch";
import { classifyFile } from "../src/classify";

/** Changed lines a reviewer reads in an hour, roughly: studies of code review put it at 300–500. */
export const LINES_PER_HOUR = 400;

/** Lines added and removed in each file of the patch, by its path after the change. */
export function changedLines(patch: string): Map<string, number> {
  return new Map(splitPatchByFile(patch).map((file) => [file.path, patchRows(file.text).filter((row) => row.kind === "+" || row.kind === "-").length]));
}

/** The changed lines in these files worth reading: lockfiles and generated files left out. */
export function readingLines(files: string[], lines: ReadonlyMap<string, number>): number {
  return files.filter((file) => !classifyFile(file).skippable).reduce((sum, file) => sum + (lines.get(file) ?? 0), 0);
}

/** About how long reading that many changed lines takes, at LINES_PER_HOUR. */
export function readingTime(lines: number): string {
  const minutes = lines / LINES_PER_HOUR * 60;
  if (minutes < 5) return "a few minutes";
  if (minutes < 60) return `about ${Math.ceil(minutes / 5) * 5} min`;
  return `about ${Math.round(minutes / 30) / 2} h`;
}
