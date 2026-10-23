import { patchRows } from "../src/patch";
import { places, rangeProblem, type Place } from "../src/review-positions";
import type { RenderedBlock } from "./markdown-diff";

/** Where a comment on rendered Markdown goes: a line of the diff, or a range of them in one hunk, as GitHub takes it. */
export interface LineAnchor {
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
}

/** What of a file's diff rendered blocks anchor to. */
export interface FileLines {
  file: string;
  patch: string;
  /** Each line a comment may target, by `SIDE:line`: its hunk and row (src/review-positions.ts). */
  places: Map<string, Place>;
  added: Set<number>;
  removed: Set<number>;
  /** Each old line the diff shows to the new line it is (a context line), or that comes after it (a removed line). */
  oldToNew: Map<number, number>;
}

export function fileLines(patch: string, file: string): FileLines {
  const added = new Set<number>(), removed = new Set<number>(), oldToNew = new Map<number, number>();
  for (const row of patchRows(patch)) {
    if (row.kind === "+") added.add(row.newLine);
    else if (row.kind === "-") { removed.add(row.oldLine); oldToNew.set(row.oldLine, row.newLine); }
    else if (row.kind === " ") oldToNew.set(row.oldLine, row.newLine);
  }
  return { file, patch, places: places(patch, file), added, removed, oldToNew };
}

/**
 * The lines from `start` to `end` on `side` a comment can take, in one hunk: `hunk`, or else the first that has any. An
 * old-file block's are only the lines the diff removes, never its context lines: what a comment on it is about is gone.
 */
function linesIn(lines: FileLines, side: "LEFT" | "RIGHT", start: number, end: number, hunk?: number): LineAnchor | null {
  const taken: number[] = [];
  for (let line = start; line <= end; line++) {
    const place = lines.places.get(`${side}:${line}`);
    if (!place || (side === "LEFT" && !lines.removed.has(line))) continue;
    hunk ??= place.hunk;
    if (place.hunk === hunk) taken.push(line);
  }
  if (!taken.length) return null;
  const [first, last] = [taken[0], taken[taken.length - 1]];
  if (first === last || rangeProblem(lines.patch, { file: lines.file, line: last, side, startLine: first })) return { line: last, side };
  return { line: last, side, startLine: first };
}

/** The hunk of a block's first changed line, if it has one. */
function changedHunk(lines: FileLines, item: RenderedBlock): number | undefined {
  const changed = item.side === "RIGHT" ? lines.added : lines.removed;
  for (let line = item.block.start; line <= item.block.end; line++) {
    if (changed.has(line)) return lines.places.get(`${item.side}:${line}`)?.hunk;
  }
  return undefined;
}

/**
 * Where a comment on a block goes: its lines a comment can take, in the hunk of its change, or of its first line the diff
 * shows; null for a block the diff doesn't show, which GitHub takes no comment on.
 */
export function blockAnchor(lines: FileLines, item: RenderedBlock): LineAnchor | null {
  return linesIn(lines, item.side, item.block.start, item.block.end, changedHunk(lines, item));
}

/**
 * Where a comment on text selected across `items`, in order, goes: the lines of the side the selection ends on, from its
 * first block there to its last, in the hunk of the last of them that takes a comment. Null when none does.
 */
export function selectionAnchor(lines: FileLines, items: RenderedBlock[]): LineAnchor | null {
  const side = items[items.length - 1].side;
  const own = items.filter((item) => item.side === side);
  for (let i = own.length - 1; i >= 0; i--) {
    const anchor = blockAnchor(lines, own[i]);
    if (anchor) return linesIn(lines, side, own[0].block.start, own[own.length - 1].block.end, lines.places.get(`${side}:${anchor.line}`)!.hunk);
  }
  return null;
}

/**
 * The block a comment, thread, or CI failure at a line shows after: the block holding the line, on its side; an old line
 * in a changed block's version before goes with that block, and any other old line with the new line it is or comes
 * before. A line between blocks goes with the block before it.
 */
export function blockAt(items: RenderedBlock[], lines: FileLines, at: { line: number; side: "LEFT" | "RIGHT" }): number {
  const holds = (start: number, end: number) => at.line >= start && at.line <= end;
  if (at.side === "LEFT") {
    const old = items.findIndex((item) => item.side === "LEFT" ? holds(item.block.start, item.block.end) : !!item.previous && holds(item.previous.start, item.previous.end));
    if (old >= 0) return old;
    const line = lines.oldToNew.get(at.line);
    if (line === undefined) return items.length - 1;
    return blockAt(items, lines, { line: lines.removed.has(at.line) ? Math.max(line - 1, 1) : line, side: "RIGHT" });
  }
  let before = -1;
  for (const [index, item] of items.entries()) {
    if (item.side !== "RIGHT") continue;
    if (holds(item.block.start, item.block.end)) return index;
    if (item.block.start <= at.line) before = index;
  }
  return before >= 0 ? before : 0;
}
