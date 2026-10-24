import { patchRows } from "../src/patch";
import { places, type Place } from "../src/review-positions";
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
  return { file, places: places(patch, file), added, removed, oldToNew };
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
  // One hunk, first line first, as rangeProblem asks, read from the places already found: it would walk the whole diff again.
  if (first === last || lines.places.get(`${side}:${first}`)!.row >= lines.places.get(`${side}:${last}`)!.row) return { line: last, side };
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
 * Where a comment on the lines from `start` to `end` on `side` goes, as a table's row, a code block's lines, or part of a
 * block: those of them a comment can take, in the hunk of the last. Null when none does.
 */
export function rangeAnchor(lines: FileLines, side: "LEFT" | "RIGHT", start: number, end: number): LineAnchor | null {
  for (let line = end; line >= start; line--) {
    const place = lines.places.get(`${side}:${line}`);
    if (place && (side === "RIGHT" || lines.removed.has(line))) return linesIn(lines, side, start, end, place.hunk);
  }
  return null;
}

/**
 * Where a comment on text selected across `items`, in order, goes: the lines of the side the selection ends on, from its
 * first block there to its last, in the hunk of the last of them that takes a comment. Null when none does. Given the
 * lines the selection starts and ends on, `from` and `to`, only those of them: in the hunk of the last that takes one.
 */
export function selectionAnchor(lines: FileLines, items: RenderedBlock[], from?: number, to?: number): LineAnchor | null {
  const side = items[items.length - 1].side;
  const own = items.filter((item) => item.side === side);
  if (from !== undefined || to !== undefined) return rangeAnchor(lines, side, from !== undefined && items[0].side === side ? from : own[0].block.start, to ?? own[own.length - 1].block.end);
  for (let i = own.length - 1; i >= 0; i--) {
    const anchor = blockAnchor(lines, own[i]);
    if (anchor) return linesIn(lines, side, own[0].block.start, own[own.length - 1].block.end, lines.places.get(`${side}:${anchor.line}`)!.hunk);
  }
  return null;
}

/** An end of a text selection: the block it's in, by its index, and which of the block's versions before, if one. */
export interface SelectionEnd { index: number; ghost?: number }

/**
 * The blocks text selected from `from` to `to` is in, in order. A changed block's versions before show above it, so a
 * selection starting in one takes it and the block itself; one ending in one takes it, not the block after it.
 */
export function selectedBlocks(items: RenderedBlock[], from: SelectionEnd, to: SelectionEnd): RenderedBlock[] {
  const ghost = ({ index, ghost }: SelectionEnd): RenderedBlock => ({ status: "removed", side: "LEFT", block: items[index].previous![ghost!] });
  const picked = items.slice(from.index, to.index + 1);
  if (to.ghost !== undefined) picked[picked.length - 1] = ghost(to);
  if (from.ghost === undefined) return picked;
  if (from.index !== to.index || to.ghost === undefined) return [ghost(from), ...picked];
  return from.ghost === to.ghost ? [ghost(from)] : [ghost(from), ghost(to)];
}

/**
 * The block a comment, thread, or CI failure at a line shows after: the block holding the line, on its side; an old line
 * in a changed block's version before goes with that block, and any other old line with the new line it is or comes
 * before. A line between blocks goes with the block before it.
 */
export function blockAt(items: RenderedBlock[], lines: FileLines, at: { line: number; side: "LEFT" | "RIGHT" }): number {
  const holds = (start: number, end: number) => at.line >= start && at.line <= end;
  if (at.side === "LEFT") {
    const old = items.findIndex((item) => item.side === "LEFT" ? holds(item.block.start, item.block.end) : !!item.previous?.some((old) => holds(old.start, old.end)));
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
