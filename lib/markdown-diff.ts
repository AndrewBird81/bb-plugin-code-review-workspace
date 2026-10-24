import { diffArrays } from "diff";
import { HUNK, patchRows } from "../src/patch";
import { CONFETTI_THRESHOLD } from "./confetti";
import { blockHolding, markdownBlocks, withNumber, type MarkdownBlock } from "./markdown-blocks";

/** How a rendered block changed: a block of the new file added, changed, or unchanged, or one of the old file removed. */
export type BlockStatus = "added" | "changed" | "unchanged" | "removed";

export interface RenderedBlock {
  status: BlockStatus;
  /** The file it's from: the old file's for a removed block (LEFT), else the new file's (RIGHT). */
  side: "LEFT" | "RIGHT";
  block: MarkdownBlock;
  /** A changed block's version before the change: the old block, or the old blocks joined into it. */
  previous?: MarkdownBlock[];
}

/** A Markdown file's change as rendered blocks in reading order, and each side's link reference definitions. */
export interface MarkdownDiff {
  blocks: RenderedBlock[];
  oldDefinitions: string;
  newDefinitions: string;
}

/** How far apart a run's removed and added blocks may pair by their words; past it, they pair greedily, in order. */
const PAIR_EDITS = 100;
/** Pairing greedily, how many added blocks ahead a removed block looks for one alike. */
const PAIR_AHEAD = 10;

const normal = (text: string) => text.replace(/\s+/g, " ").trim();
/** A block's text to compare: an ordered list's item draws with its number in the list, not the one its source gives. */
const textOf = (block: MarkdownBlock) => (block.list?.number !== undefined ? withNumber(block.source, 0) : block.source);

/** A block's words and runs of punctuation, as a word diff splits them, each with how often it's there; and their length. */
type Words = { counts: Map<string, number>; length: number };
function wordsOf(text: string): Words {
  const counts = new Map<string, number>();
  let length = 0;
  for (const [word] of text.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+/gu)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    length += word.length;
  }
  return { counts, length };
}

/** How much of two blocks' text, not counting spaces, is words they have in common, in any order: 1 for the same, 0 for none. */
function blockSimilarity(a: string | Words, b: string | Words): number {
  const [x, y] = [typeof a === "string" ? wordsOf(a) : a, typeof b === "string" ? wordsOf(b) : b];
  if (!x.length && !y.length) return 1;
  const [small, large] = x.counts.size <= y.counts.size ? [x, y] : [y, x];
  let common = 0;
  for (const [word, count] of small.counts) common += Math.min(count, large.counts.get(word) ?? 0) * word.length;
  return (2 * common) / (x.length + y.length);
}

/**
 * A Markdown file's change, from its old and new contents (null for a file added or deleted whole) and its diff, as
 * GitHub's rich diff shows it: the new file's blocks, added, changed or unchanged, each removed block of the old file
 * where it was among them.
 *
 * The two files' blocks line up by their text (`diffArrays`), whitespace aside: a block on both sides is unchanged, or
 * changed when only its whitespace differs, unless `hideWhitespace`. In each run of removed and added blocks between
 * them, an added block that keeps lines of removed ones, by the diff, changed from them, as a paragraph grows, splits or
 * joins, or a table gains a row; the rest pair, in order, when they share `CONFETTI_THRESHOLD` of their words, each with
 * the most alike of the removed blocks it could pair with. A block moved past others is removed where it was and added
 * where it went.
 */
export function markdownDiff(oldText: string | null, newText: string | null, patch: string, hideWhitespace = false): MarkdownDiff {
  const before = oldText === null ? { blocks: [], definitions: "" } : markdownBlocks(oldText);
  const after = newText === null ? { blocks: [], definitions: "" } : markdownBlocks(newText);
  // Each old line the diff keeps, in its hunks or between them, at its new line; and so the old blocks each new one keeps
  // a line of. And the lines it removes and adds.
  const kept: [number, number][] = [];
  const [removedLines, addedLines] = [new Set<number>(), new Set<number>()];
  let [oldAt, newAt] = [1, 1];
  const keepTo = (oldLine: number) => { for (; oldAt < oldLine; oldAt++, newAt++) kept.push([oldAt, newAt]); };
  for (const row of patchRows(patch)) {
    if (row.kind === "hunk") {
      // A side with no lines in the hunk names the line before it.
      const [, oldStart, oldCount, newStart, newCount] = row.text.match(HUNK)!.map((n) => (n === undefined ? 1 : Number(n)));
      keepTo(oldStart + (oldCount ? 0 : 1));
      [oldAt, newAt] = [oldStart + (oldCount ? 0 : 1), newStart + (newCount ? 0 : 1)];
    } else if (row.kind === " ") { kept.push([row.oldLine, row.newLine]); [oldAt, newAt] = [row.oldLine + 1, row.newLine + 1]; }
    else if (row.kind === "-") { removedLines.add(row.oldLine); oldAt = row.oldLine + 1; }
    else if (row.kind === "+") { addedLines.add(row.newLine); newAt = row.newLine + 1; }
  }
  keepTo((before.blocks.at(-1)?.end ?? 0) + 1);
  const keptIn = new Map<MarkdownBlock, MarkdownBlock[]>();
  for (const [oldLine, newLine] of kept) {
    const [old, now] = [blockHolding(before.blocks, oldLine), blockHolding(after.blocks, newLine)];
    if (old && now && !keptIn.get(now)?.includes(old)) keptIn.set(now, [...keptIn.get(now) ?? [], old]);
  }
  const blocks: RenderedBlock[] = [];
  let [o, n] = [0, 0];
  let gone: MarkdownBlock[] = [];
  let come: MarkdownBlock[] = [];
  const flush = () => {
    const previous = new Map<MarkdownBlock, MarkdownBlock[]>();
    const [run, taken, linked] = [new Set(gone), new Set<MarkdownBlock>(), new Set<MarkdownBlock>()];
    // Each removed block is the version before of the first added block that keeps a line of it.
    for (const now of come) {
      const olds = (keptIn.get(now) ?? []).filter((old) => run.has(old));
      if (!olds.length) continue;
      linked.add(now);
      const own = olds.filter((old) => !taken.has(old)).sort((x, y) => x.start - y.start);
      own.forEach((old) => taken.add(old));
      if (own.length) previous.set(now, own);
    }
    const olds = gone.filter((old) => !taken.has(old));
    const news = come.filter((now) => !linked.has(now));
    // A list item's words are its text's, without the marker every item has.
    const words = new Map([...olds, ...news].map((block) => [block, wordsOf(block.list ? block.source.replace(/^\s*(?:[-*+]|\d{1,9}[.)])/, "") : block.source)]));
    const alike = (old: MarkdownBlock, now: MarkdownBlock) => blockSimilarity(words.get(old)!, words.get(now)!) >= CONFETTI_THRESHOLD;
    // Pairs of indexes into olds and news, in order.
    const paired: [number, number][] = [];
    const parts = diffArrays(olds, news, { comparator: alike, maxEditLength: PAIR_EDITS });
    if (parts) {
      let [i, j] = [0, 0];
      for (const part of parts) {
        if (part.removed) i += part.count!;
        else if (part.added) j += part.count!;
        else for (let k = 0; k < part.count!; k++) paired.push([i++, j++]);
      }
    } else {
      for (let i = 0, j = 0; i < olds.length && j < news.length; i++) {
        const at = news.slice(j, j + PAIR_AHEAD).findIndex((now) => alike(olds[i], now));
        if (at >= 0) { paired.push([i, j + at]); j += at + 1; }
      }
    }
    // In order, an added block pairs with the first alike removed block; a later one, before the next pair's, may be more
    // alike: it takes that one instead.
    const similarity = (old: number, now: number) => blockSimilarity(words.get(olds[old])!, words.get(news[now])!);
    paired.forEach((pair, at) => {
      const end = at + 1 < paired.length ? paired[at + 1][0] : olds.length;
      for (let other = pair[0] + 1; other < end; other++) if (similarity(other, pair[1]) > similarity(pair[0], pair[1])) pair[0] = other;
    });
    for (const [old, now] of paired) previous.set(news[now], [olds[old]]);
    // Each removed block shows before the first new block that was after it in the old file: where a changed block's
    // version before was. A block that keeps lines only of others' versions before is with them, so none goes before it;
    // an added block is where the next block with a version before was, or else after every removed block, as a diff
    // shows removed lines before added ones.
    const shown = new Set(paired.map(([old]) => olds[old]));
    const removed = olds.filter((old) => !shown.has(old));
    const wasAt = new Map<MarkdownBlock, number>();
    let next = Infinity;
    for (const now of [...come].reverse()) {
      const own = previous.get(now)?.[0].start;
      wasAt.set(now, own ?? (linked.has(now) ? -Infinity : next));
      if (own !== undefined) next = own;
    }
    for (const now of come) {
      while (removed.length && removed[0].start < wasAt.get(now)!) blocks.push({ status: "removed", side: "LEFT", block: removed.shift()! });
      const [only, ...more] = previous.get(now) ?? [];
      // Paired with a block of the same text, as one moved past a copy of it, it's unchanged.
      if (only && !more.length && same(only, now)) blocks.push({ status: "unchanged", side: "RIGHT", block: now });
      else blocks.push(previous.has(now) ? { status: "changed", side: "RIGHT", block: now, previous: previous.get(now)! } : { status: linked.has(now) ? "changed" : "added", side: "RIGHT", block: now });
    }
    for (const old of removed) blocks.push({ status: "removed", side: "LEFT", block: old });
    gone = [];
    come = [];
  };
  const same = (old: MarkdownBlock, now: MarkdownBlock) => textOf(old) === textOf(now) || hideWhitespace && normal(textOf(old)) === normal(textOf(now));
  // A block the diff removes or adds whole is gone or new, whatever other block has its text: it lines up with none.
  const whole = (block: MarkdownBlock, lines: Set<number>) => { for (let line = block.start; line <= block.end; line++) if (!lines.has(line)) return false; return true; };
  const key = (block: MarkdownBlock, lines: Set<number>, side: string) => (whole(block, lines) ? `${side}:${block.start}` : normal(textOf(block)));
  for (const part of diffArrays(before.blocks.map((b) => key(b, removedLines, "LEFT")), after.blocks.map((b) => key(b, addedLines, "RIGHT")))) {
    if (part.removed) { gone = gone.concat(before.blocks.slice(o, o += part.count!)); continue; }
    if (part.added) { come = come.concat(after.blocks.slice(n, n += part.count!)); continue; }
    flush();
    for (let k = 0; k < part.count!; k++, o++, n++) {
      const [old, now] = [before.blocks[o], after.blocks[n]];
      blocks.push(same(old, now) || hideWhitespace ? { status: "unchanged", side: "RIGHT", block: now } : { status: "changed", side: "RIGHT", block: now, previous: [old] });
    }
  }
  flush();
  return { blocks, oldDefinitions: before.definitions, newDefinitions: after.definitions };
}
