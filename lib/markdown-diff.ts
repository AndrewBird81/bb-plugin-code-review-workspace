import { diffArrays, diffWordsWithSpace } from "diff";
import { patchRows } from "../src/patch";
import { CONFETTI_THRESHOLD } from "./confetti";
import { markdownBlocks, type MarkdownBlock } from "./markdown-blocks";

/** How a rendered block changed: a block of the new file added, changed, or unchanged, or one of the old file removed. */
export type BlockStatus = "added" | "changed" | "unchanged" | "removed";

export interface RenderedBlock {
  status: BlockStatus;
  /** The file it's from: the old file's for a removed block (LEFT), else the new file's (RIGHT). */
  side: "LEFT" | "RIGHT";
  block: MarkdownBlock;
  /** A changed block's version before the change. */
  previous?: MarkdownBlock;
}

/** A Markdown file's change as rendered blocks in reading order, and each side's link reference definitions. */
export interface MarkdownDiff {
  blocks: RenderedBlock[];
  oldDefinitions: string;
  newDefinitions: string;
}

/** Where a block's change is: the hunk of its first changed line, numbered from 1. */
type Touched = { block: MarkdownBlock; hunk: number };

const solid = (text: string) => text.replace(/\s/g, "").length;
const normal = (text: string) => text.replace(/\s+/g, " ").trim();

/** How much of two blocks' text, not counting spaces, their words keep: 1 for the same words, 0 for none in common. */
export function blockSimilarity(a: string, b: string): number {
  const total = solid(a) + solid(b);
  if (!total) return 1;
  const kept = diffWordsWithSpace(a, b).reduce((n, part) => n + (part.added || part.removed ? 0 : 2 * solid(part.value)), 0);
  return kept / total;
}

/**
 * A Markdown file's change, from its old and new contents (null for a file added or deleted whole) and its diff, as
 * GitHub's rich diff shows it: each block of the new file, added, changed or unchanged, with each removed block of the
 * old file before the new blocks that follow where it was. A block changed when the diff adds or removes a line in it, or
 * shares an unchanged line with a block on the other side that did. In each hunk, the old blocks it changes pair with its
 * new ones in order: the same text (by `diffArrays`), or words that keep `CONFETTI_THRESHOLD` of it; a pair is one
 * changed block, and the rest are added and removed. With `hideWhitespace`, a pair that differs only in whitespace is
 * unchanged.
 */
export function markdownDiff(oldText: string | null, newText: string | null, patch: string, hideWhitespace = false): MarkdownDiff {
  const before = oldText === null ? { blocks: [], definitions: "" } : markdownBlocks(oldText);
  const after = newText === null ? { blocks: [], definitions: "" } : markdownBlocks(newText);
  // Each line the diff adds or removes, by hunk, and each line it keeps, by its old and new numbers.
  const changes: { hunk: number; side: "LEFT" | "RIGHT"; line: number; at: number }[] = [];
  const kept: { hunk: number; old: number; new: number }[] = [];
  let hunk = 0;
  for (const row of patchRows(patch)) {
    if (row.kind === "hunk") hunk++;
    else if (row.kind === "+") changes.push({ hunk, side: "RIGHT", line: row.newLine, at: row.oldLine });
    else if (row.kind === "-") changes.push({ hunk, side: "LEFT", line: row.oldLine, at: row.newLine });
    else if (row.kind === " ") kept.push({ hunk, old: row.oldLine, new: row.newLine });
  }
  const holds = (block: MarkdownBlock, line: number) => line >= block.start && line <= block.end;
  const touchedOn = (blocks: MarkdownBlock[], side: "LEFT" | "RIGHT") => new Map(blocks.flatMap((block): [MarkdownBlock, Touched][] => {
    const change = changes.find((c) => c.side === side && holds(block, c.line));
    return change ? [[block, { block, hunk: change.hunk }]] : [];
  }));
  const oldTouched = touchedOn(before.blocks, "LEFT");
  const newTouched = touchedOn(after.blocks, "RIGHT");
  // A block that keeps a line of a changed block on the other side changed too, as a row added to a table does.
  const link = (from: Map<MarkdownBlock, Touched>, to: Map<MarkdownBlock, Touched>, blocks: MarkdownBlock[], own: "old" | "new", other: "old" | "new") => {
    for (const { block, hunk } of [...from.values()]) {
      for (const line of kept.filter((k) => holds(block, k[own]))) {
        const match = blocks.find((candidate) => holds(candidate, line[other]));
        if (match && !to.has(match)) to.set(match, { block: match, hunk });
      }
    }
  };
  const fromOld = new Map(oldTouched);
  link(newTouched, oldTouched, before.blocks, "new", "old");
  link(fromOld, newTouched, after.blocks, "old", "new");
  const statusOf = new Map<MarkdownBlock, { status: BlockStatus; previous?: MarkdownBlock }>();
  const removed: MarkdownBlock[] = [];
  for (let h = 1; h <= hunk; h++) {
    const inHunk = (touched: Map<MarkdownBlock, Touched>) => [...touched.values()].filter((t) => t.hunk === h).map((t) => t.block).sort((x, y) => x.start - y.start);
    const [olds, news] = [inHunk(oldTouched), inHunk(newTouched)];
    let [o, n] = [0, 0];
    const pairRuns = (gone: MarkdownBlock[], come: MarkdownBlock[]) => {
      let from = 0;
      for (const old of gone) {
        const at = come.findIndex((block, index) => index >= from && blockSimilarity(old.source, block.source) >= CONFETTI_THRESHOLD);
        if (at < 0) { removed.push(old); continue; }
        for (const added of come.slice(from, at)) statusOf.set(added, { status: "added" });
        statusOf.set(come[at], { status: "changed", previous: old });
        from = at + 1;
      }
      for (const added of come.slice(from)) statusOf.set(added, { status: "added" });
    };
    let gone: MarkdownBlock[] = [];
    let come: MarkdownBlock[] = [];
    for (const part of diffArrays(olds.map((b) => normal(b.source)), news.map((b) => normal(b.source)))) {
      if (part.removed) { gone = gone.concat(olds.slice(o, o += part.count!)); continue; }
      if (part.added) { come = come.concat(news.slice(n, n += part.count!)); continue; }
      pairRuns(gone, come);
      gone = [];
      come = [];
      for (let i = 0; i < part.count!; i++, o++, n++) {
        const same = olds[o].source === news[n].source || hideWhitespace;
        statusOf.set(news[n], same ? { status: "unchanged" } : { status: "changed", previous: olds[o] });
      }
    }
    pairRuns(gone, come);
  }
  // Each removed block goes before the first new block at or after where its first removed (or else kept) line was.
  const placeOf = (block: MarkdownBlock) => changes.find((c) => c.side === "LEFT" && holds(block, c.line))?.at ?? kept.find((k) => holds(block, k.old))?.new ?? Infinity;
  const queue = removed.map((block) => ({ block, at: placeOf(block) })).sort((a, b) => a.at - b.at || a.block.start - b.block.start);
  const blocks: RenderedBlock[] = [];
  for (const block of after.blocks) {
    while (queue.length && queue[0].at <= block.start) blocks.push({ status: "removed", side: "LEFT", block: queue.shift()!.block });
    const { status, previous } = statusOf.get(block) ?? { status: "unchanged" as const };
    blocks.push({ status, side: "RIGHT", block, ...(previous ? { previous } : {}) });
  }
  for (const { block } of queue) blocks.push({ status: "removed", side: "LEFT", block });
  return { blocks, oldDefinitions: before.definitions, newDefinitions: after.definitions };
}
