// How much there is to read in a review: changed lines, without the files a reviewer skims.
import { patchRows, splitPatchByFile } from "../src/patch";
import { classifyFile } from "../src/classify";
import { filePart } from "../src/hunks";

/** Changed lines a reviewer reads in an hour, roughly: studies of code review put it at 300–500. */
export const LINES_PER_HOUR = 400;

/** Lines added and removed in each file of the patch, by its path after the change. */
export function changedLines(patch: string): Map<string, number> {
  return new Map(splitPatchByFile(patch).map((file) => [file.path, patchRows(file.text).filter((row) => row.kind === "+" || row.kind === "-").length]));
}

/** The changed lines in these files worth reading: lockfiles and generated files, including those the repo declares, left out. */
export function readingLines(files: string[], lines: ReadonlyMap<string, number>, generated?: ReadonlySet<string>): number {
  return files.filter((file) => !classifyFile(file, generated?.has(file)).skippable).reduce((sum, file) => sum + (lines.get(file) ?? 0), 0);
}

/** Each chapter's changed lines worth reading, by its id: a file split across chapters counts in each only its hunks there. */
export function chapterReadingLines(sections: ReadonlyArray<{ id: string; diffs: ReadonlyArray<{ file: string; hunks?: number[] }> }>, patch: string, lines: ReadonlyMap<string, number>, generated?: ReadonlySet<string>): Map<string, number> {
  const texts = new Map(splitPatchByFile(patch).map((file) => [file.path, file.text]));
  return new Map(sections.map((section) => {
    const own = new Map(section.diffs.flatMap((diff) => diff.hunks && texts.has(diff.file) ? [[diff.file, changedLines(filePart(texts.get(diff.file)!, diff.hunks)).get(diff.file) ?? 0] as const] : []));
    return [section.id, readingLines(section.diffs.map((diff) => diff.file), own.size ? new Map([...lines, ...own]) : lines, generated)];
  }));
}

/** About how long reading that many changed lines takes, at LINES_PER_HOUR. */
export function readingTime(lines: number): string {
  const minutes = lines / LINES_PER_HOUR * 60;
  if (minutes < 5) return "a few minutes";
  if (minutes < 60) return `about ${Math.ceil(minutes / 5) * 5} min`;
  return `about ${Math.round(minutes / 30) / 2} h`;
}
