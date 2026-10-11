import { patchRows, splitPatchByFile } from "./patch";
import type { DraftComment } from "./draft";

export interface FilePositions {
  /** New-file lines a RIGHT-side comment may target (added + context), by number, with their text. */
  right: Map<number, string>;
  /** Old-file lines a LEFT-side comment may target (deleted + context), by number, with their text. */
  left: Map<number, string>;
}

// GitHub's review API rejects (422) any comment whose (path, line, side) is not
// part of the diff. Walk each file's hunks to enumerate the lines that ARE, so
// we can validate a draft before we ever call `gh` and give a clear message
// instead of an opaque "Unprocessable Entity".
export function diffPositions(patch: string): Map<string, FilePositions> {
  const map = new Map<string, FilePositions>();
  for (const f of splitPatchByFile(patch)) {
    if (!f.path) continue;
    const right = new Map<number, string>();
    const left = new Map<number, string>();
    for (const row of patchRows(f.text)) {
      const text = row.text.slice(1);
      if (row.kind === "+") right.set(row.newLine, text);
      else if (row.kind === "-") left.set(row.oldLine, text);
      else if (row.kind === " ") {
        right.set(row.newLine, text);
        left.set(row.oldLine, text);
      }
    }
    map.set(f.path, { right, left });
  }
  return map;
}

/** Draft comments GitHub would reject because their position isn't in the diff, or their range isn't one it takes. */
export function invalidComments(patch: string, comments: DraftComment[]): DraftComment[] {
  const pos = diffPositions(patch);
  return comments.filter((c) => {
    const p = pos.get(c.file);
    if (!p) return true; // file isn't in the diff at all
    return (c.side === "RIGHT" ? !p.right.has(c.line) : !p.left.has(c.line)) || rangeProblem(patch, c) !== null;
  });
}

type End = { line: number; side: "LEFT" | "RIGHT" };
type Place = { hunk: number; row: number };

/** Where each line a comment may target sits in a file's diff: its hunk, and its row; a context line is on both sides. */
function places(patch: string, file: string): Map<string, Place> {
  const map = new Map<string, Place>();
  const text = splitPatchByFile(patch).find((f) => f.path === file)?.text ?? "";
  let hunk = 0;
  patchRows(text).forEach((row, index) => {
    if (row.kind === "hunk") hunk++;
    if (row.kind === "+" || row.kind === " ") map.set(`RIGHT:${row.newLine}`, { hunk, row: index });
    if (row.kind === "-" || row.kind === " ") map.set(`LEFT:${row.oldLine}`, { hunk, row: index });
  });
  return map;
}

/**
 * Why GitHub would refuse a comment's range, or null when it has none or GitHub takes it: its
 * first line must be in the diff, in the same hunk as its last, and come before it.
 */
export function rangeProblem(patch: string, c: Pick<DraftComment, "file" | "line" | "side" | "startLine" | "startSide">): string | null {
  if (c.startLine === undefined) return null;
  const map = places(patch, c.file);
  const start = map.get(`${c.startSide ?? c.side}:${c.startLine}`);
  const end = map.get(`${c.side}:${c.line}`);
  if (!start) return `${c.file}:${c.startLine} isn’t in the current diff.`;
  if (!end) return `${c.file}:${c.line} isn’t in the current diff.`;
  if (start.hunk !== end.hunk) return `Lines ${c.startLine} and ${c.line} of ${c.file} are in different hunks of the diff. GitHub takes a range within one hunk.`;
  if (start.row > end.row) return `Line ${c.startLine} comes after line ${c.line} in the diff. Give the range's first line as its start.`;
  return null;
}

/** A selection's two ends, first line first, as the diff shows them; ends it doesn't show keep their order. */
export function orderRange(patch: string, file: string, a: End, b: End): [End, End] {
  const map = places(patch, file);
  const [pa, pb] = [map.get(`${a.side}:${a.line}`), map.get(`${b.side}:${b.line}`)];
  const after = pa && pb ? pa.row > pb.row : a.side === b.side && a.line > b.line;
  return after ? [b, a] : [a, b];
}
