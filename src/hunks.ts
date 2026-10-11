// A guide can split a file that mixes unrelated changes across chapters, each showing some of its
// hunks: numbered from 1 in patch order.
import { patchRows, splitPatchByFile } from "./patch";

/** One hunk of a file's diff: its @@ header, its lines, the old- and new-file lines it shows, and where it starts in the old file. */
export interface FileHunk { header: string; lines: string[]; old: Set<number>; new: Set<number>; oldStart: number }

/** A file diff's header lines and hunks, in patch order. */
export function fileHunks(text: string): { headers: string[]; hunks: FileHunk[] } {
  const headers: string[] = [];
  const hunks: FileHunk[] = [];
  for (const row of patchRows(text)) {
    const hunk = hunks.at(-1);
    if (row.kind === "hunk") hunks.push({ header: row.text, lines: [row.text], old: new Set(), new: new Set(), oldStart: 0 });
    else if (!hunk) headers.push(row.text);
    // A blank line between hunks isn't part of either.
    else if (row.kind !== "other" || row.text) {
      hunk.lines.push(row.text);
      if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") continue;
      if (!hunk.old.size && !hunk.new.size) hunk.oldStart = row.oldLine;
      if (row.kind === "+" || row.kind === " ") hunk.new.add(row.newLine);
      if (row.kind === "-" || row.kind === " ") hunk.old.add(row.oldLine);
    }
  }
  return { headers, hunks };
}

/** The file diff with only the hunks `keep` picks, under its headers; "" when it picks none. */
export function keepHunks(text: string, keep: (hunk: FileHunk, index: number) => boolean): string {
  const { headers, hunks } = fileHunks(text);
  const kept = hunks.filter(keep);
  return kept.length ? [...headers, ...kept.flatMap((hunk) => hunk.lines)].join("\n") + "\n" : "";
}

/** A split file's part: its diff with only the given hunks. */
export function filePart(text: string, hunks: number[]): string {
  return keepHunks(text, (_, i) => hunks.includes(i + 1));
}

/** The hunks of `text` that `part` also has, such as the changes since your review in one chapter's part of a file. */
export function hunksIn(text: string, part: string): string {
  const shown = new Set(fileHunks(part).hunks.map((hunk) => hunk.header));
  return keepHunks(text, (hunk) => shown.has(hunk.header));
}

/** The changes gone since your review in `dropped` that sit nearest the given hunks of `text`, by where they were in the old file. */
export function droppedNear(dropped: string, text: string, hunks: number[]): string {
  const starts = fileHunks(text).hunks.map((hunk) => hunk.oldStart);
  return keepHunks(dropped, (gone) => {
    const nearest = starts.reduce((best, start, i) => Math.abs(start - gone.oldStart) < Math.abs(starts[best] - gone.oldStart) ? i : best, 0);
    return hunks.includes(nearest + 1);
  });
}

/** Each changed file's number of hunks. */
export function hunkCounts(patch: string): Map<string, number> {
  return new Map(splitPatchByFile(patch).map((file) => [file.path, patchRows(file.text).filter((row) => row.kind === "hunk").length]));
}

const list = (hunks: number[]) => `hunk${hunks.length === 1 ? "" : "s"} ${hunks.join(", ")}`;

/** Why a file's entries don't cover each of its `count` hunks exactly once. An entry is its `hunks`, or undefined for the whole file. */
export function hunkErrors(file: string, entries: Array<number[] | undefined>, count: number): string[] {
  if (entries.every((hunks) => !hunks)) return entries.length > 1 ? [`duplicate: ${file} appears ${entries.length} times`] : [];
  if (!count) return [`hunks: ${file} has no hunks to split; list it without hunks`];
  const beyond = [...new Set(entries.flatMap((hunks) => hunks ?? []).filter((n) => n > count))];
  if (beyond.length) return [`hunks: ${file} has ${count} hunk${count === 1 ? "" : "s"}, so there's no ${list(beyond)}`];
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const times = new Array<number>(count + 1).fill(0);
  for (const hunks of entries) for (const n of hunks ?? all) times[n]++;
  const doubled = all.filter((n) => times[n] > 1);
  const missing = all.filter((n) => !times[n]);
  return [
    ...(doubled.length ? [`duplicate: ${list(doubled)} of ${file} ${doubled.length === 1 ? "is" : "are"} in more than one chapter`] : []),
    ...(missing.length ? [`missing: ${list(missing)} of ${file} ${missing.length === 1 ? "isn't" : "aren't"} in any chapter`] : []),
  ];
}

type Entry = { file: string; hunks?: number[] };

/**
 * A guide whose hunks no longer fit the diff, such as one from an earlier revision, shows those
 * files whole, in the first chapter that lists them. A chapter left with no files goes.
 */
export function fitHunks<S extends { diffs: Entry[] }>(sections: S[], patch: string): S[] {
  if (!sections.some((section) => section.diffs.some((diff) => diff.hunks))) return sections;
  const counts = hunkCounts(patch);
  const entries = new Map<string, Array<number[] | undefined>>();
  for (const section of sections) for (const diff of section.diffs) entries.set(diff.file, [...(entries.get(diff.file) ?? []), diff.hunks]);
  const whole = new Set([...entries].filter(([file, hunks]) => hunks.some(Boolean) && hunkErrors(file, hunks, counts.get(file) ?? 0).length).map(([file]) => file));
  if (!whole.size) return sections;
  const placed = new Set<string>();
  return sections.map((section) => ({
    ...section,
    diffs: section.diffs.flatMap((diff) => {
      if (!whole.has(diff.file)) return [diff];
      if (placed.has(diff.file)) return [];
      placed.add(diff.file);
      const { hunks: _hunks, ...rest } = diff;
      return [rest];
    }),
  }) as S).filter((section) => section.diffs.length);
}

/** The chapter that shows a line of a file: the one with its hunk, or else the first with the file. */
export function chapterAt<S extends { diffs: Entry[] }>(sections: S[], patch: string, at: { file: string; line: number; side: "LEFT" | "RIGHT" }): S | undefined {
  const holding = sections.filter((section) => section.diffs.some((diff) => diff.file === at.file));
  if (holding.length < 2) return holding[0];
  const text = splitPatchByFile(patch).find((file) => file.path === at.file)?.text ?? "";
  const n = fileHunks(text).hunks.findIndex((hunk) => (at.side === "LEFT" ? hunk.old : hunk.new).has(at.line)) + 1;
  return holding.find((section) => section.diffs.some((diff) => diff.file === at.file && diff.hunks?.includes(n))) ?? holding[0];
}
