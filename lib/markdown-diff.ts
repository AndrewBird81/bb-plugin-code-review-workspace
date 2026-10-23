import { diffArrays } from "diff";
import { patchRows } from "../src/patch";
import { CONFETTI_THRESHOLD } from "./confetti";
import { blockHolding, markdownBlocks, type MarkdownBlock } from "./markdown-blocks";

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

/**
 * Pairing a run of removed blocks with a run of added ones over this many pairs compares each removed block only with
 * the added ones about as far along their run, `PAIR_BAND` either side.
 */
const PAIR_AREA = 10_000;
const PAIR_BAND = 25;

const normal = (text: string) => text.replace(/\s+/g, " ").trim();

/** A block's words, each with how often it's there, and their length together. */
type Words = { counts: Map<string, number>; length: number };
function wordsOf(text: string): Words {
  const counts = new Map<string, number>();
  let length = 0;
  // Words, and runs of punctuation, as a word diff splits them.
  for (const [word] of text.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+/gu)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    length += word.length;
  }
  return { counts, length };
}

/**
 * How much of two blocks' text, not counting spaces, is words they have in common, in any order: 1 for the same words, 0
 * for none in common. Linear in their length, where a word diff was quadratic, and run on every pair of a rewrite.
 */
export function blockSimilarity(a: string | Words, b: string | Words): number {
  const [x, y] = [typeof a === "string" ? wordsOf(a) : a, typeof b === "string" ? wordsOf(b) : b];
  if (!x.length && !y.length) return 1;
  const [small, large] = x.counts.size <= y.counts.size ? [x, y] : [y, x];
  let common = 0;
  for (const [word, count] of small.counts) common += Math.min(count, large.counts.get(word) ?? 0) * word.length;
  return (2 * common) / (x.length + y.length);
}

/**
 * A Markdown file's change, from its old and new contents (null for a file added or deleted whole) and its diff, as
 * GitHub's rich diff shows it: each block of the new file, added, changed or unchanged, with each removed block of the
 * old file before the new blocks that follow where it was.
 *
 * A block is touched when the diff adds or removes a line in it, or between it and the block beside it. Blocks on the two
 * sides that keep a line of each other, where either is touched, are one change, whatever hunks it spans: changed, its
 * first new block showing the old ones as its version before, or unchanged when one block's text is the same on both
 * sides. The other touched blocks are all new or all gone: in each hunk, in order, a removed block pairs with the added
 * one most like it, sharing `CONFETTI_THRESHOLD` of their words, as a changed block, and the rest are added and removed.
 * With `hideWhitespace`, a pair that differs only in whitespace is unchanged.
 */
export function markdownDiff(oldText: string | null, newText: string | null, patch: string, hideWhitespace = false): MarkdownDiff {
  const before = oldText === null ? { blocks: [], definitions: "" } : markdownBlocks(oldText);
  const after = newText === null ? { blocks: [], definitions: "" } : markdownBlocks(newText);
  // Each line the diff adds or removes, by hunk, and each line it keeps, by its old and new numbers.
  const changes: { hunk: number; side: "LEFT" | "RIGHT"; line: number; at: number }[] = [];
  const kept: { old: number; new: number }[] = [];
  let hunk = 0;
  for (const row of patchRows(patch)) {
    if (row.kind === "hunk") hunk++;
    else if (row.kind === "+") changes.push({ hunk, side: "RIGHT", line: row.newLine, at: row.oldLine });
    else if (row.kind === "-") changes.push({ hunk, side: "LEFT", line: row.oldLine, at: row.newLine });
    else if (row.kind === " ") kept.push({ old: row.oldLine, new: row.newLine });
  }
  const holds = (block: MarkdownBlock, line: number) => line >= block.start && line <= block.end;
  const touched = new Map<MarkdownBlock, number>();
  for (const change of changes) {
    const blocks = change.side === "LEFT" ? before.blocks : after.blocks;
    const holding = blockHolding(blocks, change.line);
    let next = 0;
    if (!holding) for (let high = blocks.length; next < high;) { const mid = (next + high) >> 1; if (blocks[mid].start > change.line) high = mid; else next = mid + 1; }
    for (const block of holding ? [holding] : [blocks[next - 1], blocks[next]]) if (block && !touched.has(block)) touched.set(block, change.hunk);
  }
  // Each block that keeps a line of a touched one, or is touched and keeps a line, with it: one change.
  const parent = new Map<MarkdownBlock, MarkdownBlock>();
  const root = (block: MarkdownBlock): MarkdownBlock => { let at = block; while (parent.get(at) !== at) at = parent.get(at)!; return at; };
  for (const line of kept) {
    const [old, now] = [blockHolding(before.blocks, line.old), blockHolding(after.blocks, line.new)];
    if (!old || !now || !(touched.has(old) || touched.has(now))) continue;
    for (const block of [old, now]) if (!parent.has(block)) parent.set(block, block);
    parent.set(root(old), root(now));
  }
  const oldSide = new Set(before.blocks);
  const byStart = (x: MarkdownBlock, y: MarkdownBlock) => x.start - y.start;
  const groups = new Map<MarkdownBlock, MarkdownBlock[]>();
  for (const block of parent.keys()) groups.set(root(block), [...groups.get(root(block)) ?? [], block]);
  const statusOf = new Map<MarkdownBlock, { status: BlockStatus; previous?: MarkdownBlock }>();
  for (const group of groups.values()) {
    const olds = group.filter((block) => oldSide.has(block)).sort(byStart);
    const news = group.filter((block) => !oldSide.has(block)).sort(byStart);
    if (olds.length === 1 && news.length === 1 && (olds[0].source === news[0].source || hideWhitespace && normal(olds[0].source) === normal(news[0].source))) {
      statusOf.set(news[0], { status: "unchanged" });
      continue;
    }
    // A paragraph split in two, or two joined, shows its old text once, above the first of the new.
    const previous = olds.length === 1 ? olds[0] : { kind: olds[0].kind, start: olds[0].start, end: olds[olds.length - 1].end, source: olds.map((block) => block.source).join("\n\n") };
    news.forEach((block, index) => statusOf.set(block, { status: "changed", ...(index === 0 ? { previous } : {}) }));
  }
  const removed: MarkdownBlock[] = [];
  // Pairs blocks of `gone` with blocks of `come`, in order: the most alike pair first, then those before and after it.
  const pairRuns = (gone: MarkdownBlock[], come: MarkdownBlock[]) => {
    const words = new Map<MarkdownBlock, Words>();
    const wordsFor = (block: MarkdownBlock) => words.get(block) ?? words.set(block, wordsOf(block.source)).get(block)!;
    const known = new Map<number, number>();
    const similarity = (i: number, j: number) => known.get(i * come.length + j) ?? known.set(i * come.length + j, blockSimilarity(wordsFor(gone[i]), wordsFor(come[j]))).get(i * come.length + j)!;
    const banded = gone.length * come.length > PAIR_AREA;
    const match = (g0: number, g1: number, c0: number, c1: number) => {
      let best: { i: number; j: number; similarity: number } | null = null;
      for (let i = g0; i < g1; i++) {
        for (let j = c0; j < c1; j++) {
          if (banded && Math.abs((i * come.length) / gone.length - j) > PAIR_BAND) continue;
          const s = similarity(i, j);
          if (s >= CONFETTI_THRESHOLD && (!best || s > best.similarity)) best = { i, j, similarity: s };
        }
      }
      if (!best) {
        removed.push(...gone.slice(g0, g1));
        for (const block of come.slice(c0, c1)) statusOf.set(block, { status: "added" });
        return;
      }
      match(g0, best.i, c0, best.j);
      statusOf.set(come[best.j], { status: "changed", previous: gone[best.i] });
      match(best.i + 1, g1, best.j + 1, c1);
    };
    match(0, gone.length, 0, come.length);
  };
  // The rest, by hunk, in order.
  const free = (blocks: MarkdownBlock[]) => {
    const byHunk = new Map<number, MarkdownBlock[]>();
    for (const block of blocks) if (touched.has(block) && !parent.has(block)) byHunk.set(touched.get(block)!, [...byHunk.get(touched.get(block)!) ?? [], block]);
    return byHunk;
  };
  const [oldFree, newFree] = [free(before.blocks), free(after.blocks)];
  for (let h = 1; h <= hunk; h++) {
    const [olds, news] = [oldFree.get(h) ?? [], newFree.get(h) ?? []];
    let [o, n] = [0, 0];
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
  // Each removed block goes before the first new block at or after where its first removed line was.
  const placeOf = (block: MarkdownBlock) => changes.find((c) => c.side === "LEFT" && holds(block, c.line))?.at ?? Infinity;
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
