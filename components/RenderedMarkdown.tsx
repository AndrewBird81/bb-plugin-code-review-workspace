import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { CommentLocation } from "../src/draft";
import { blockMarkdown, type MarkdownBlock } from "../lib/markdown-blocks";
import { markdownDiff, type BlockStatus, type RenderedBlock } from "../lib/markdown-diff";
import { blockAnchor, blockAt, fileLines, selectedBlocks, selectionAnchor, type LineAnchor, type SelectionEnd } from "../lib/markdown-anchor";
import { linkImages } from "../lib/link-images";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";
import { TOUCH_COMPACT } from "./touch";
import { InlineLocation, locationKey } from "./InlineDraft";
import { LineThreads } from "./LineThreads";
import { LineChecks } from "./CheckFailures";

/** A run of this many unchanged blocks folds, but for the one next to each change. */
const UNCHANGED_RUN = 6;
/** A run of this many removed blocks shows its first, and folds the rest. */
const REMOVED_RUN = 3;
/** How long a text selection rests before it picks its blocks' lines. */
const SELECTION_REST_MS = 150;

// The bar at a block's left edge, as the code's gutter bar: solid for added and changed, dashed for removed; its words
// for screen readers.
const BAR: Record<BlockStatus, string> = {
  added: "border-diff-added",
  changed: "border-warning",
  removed: "border-dashed border-diff-removed",
  unchanged: "border-transparent",
};
const SAID: Record<BlockStatus, string | null> = { added: "Added", changed: "Changed", removed: "Removed", unchanged: null };

/**
 * The room above a block, as BB's Markdown spaces a whole document: it draws one block alone with no margin above its
 * first element or below its last. Padding, not margin, so the bars of blocks next to each other join.
 */
function spaceAbove(block: MarkdownBlock, first: boolean): string {
  if (first) return "";
  if (block.kind === "heading") return block.depth! <= 2 ? "pt-4" : "pt-3";
  return "pt-2";
}

const linesSaid = (anchor: LineAnchor) => `${anchor.startLine !== undefined ? `lines ${anchor.startLine}–${anchor.line}` : `line ${anchor.line}`}${anchor.side === "LEFT" ? " (old)" : ""}`;

/** What shows in order: a block with what goes after it, or a fold of the blocks between `from` and `to`. */
type Row = { kind: "block"; index: number } | { kind: "fold"; key: string; from: number; to: number; removed: boolean };

/**
 * A Markdown file's change, rendered as GitHub's rich diff shows it, with the review's comments: each block of the new
 * file drawn by BB's Markdown, its images as links, with a bar for added or changed, and each removed block from the old
 * file, dimmed with a dashed bar, where it was. A changed block can show its version before above it. Runs of unchanged
 * blocks fold. Threads, drafts, CI failures and the comment box show after the block holding their line. A block the
 * diff shows has a "+" that opens the comment box on its lines; selecting text picks the lines of the blocks it's in, as
 * picking lines in the code does, or, in blocks GitHub takes no comment on, offers to ask the agent about them.
 */
export const RenderedMarkdown = memo(function RenderedMarkdown({ path, patch, old, now, hideWhitespace, locations, selected, onComment, onLineSelected }: {
  path: string;
  /** The file's diff. */
  patch: string;
  /** Its contents before and after; null for a file added or deleted whole. */
  old: string | null;
  now: string | null;
  hideWhitespace: boolean;
  /** Where the file's comments, threads, failures and the comment box are. */
  locations: CommentLocation[];
  selected: SelectedLineRange | null;
  onComment?: (at: CommentLocation & { startLine?: number }) => void;
  onLineSelected?: (file: string, range: SelectedLineRange | null, askOnly?: { code: string }) => void;
}) {
  const diff = useMemo(() => markdownDiff(old, now, patch, hideWhitespace), [old, now, patch, hideWhitespace]);
  const lines = useMemo(() => fileLines(patch, path), [patch, path]);
  const items = diff.blocks;
  const anchors = useMemo(() => items.map((item) => blockAnchor(lines, item)), [items, lines]);
  const placed = useMemo(() => {
    const byBlock = new Map<number, CommentLocation[]>();
    if (!items.length) return byBlock;
    for (const at of locations) {
      const index = blockAt(items, lines, at);
      byBlock.set(index, [...byBlock.get(index) ?? [], at]);
    }
    for (const list of byBlock.values()) list.sort((a, b) => a.line - b.line);
    return byBlock;
  }, [items, lines, locations]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [previous, setPrevious] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => { setOpened(new Set()); setPrevious(new Set()); }, [diff]);

  const rows = useMemo((): Row[] => {
    const rows: Row[] = [];
    // A block with a comment or the box after it never folds.
    const kept = (index: number) => items[index].status !== "unchanged" || placed.has(index);
    for (let i = 0; i < items.length;) {
      const removed = items[i].status === "removed" && !placed.has(i);
      let j = i;
      while (j < items.length && (removed ? items[j].status === "removed" && !placed.has(j) : !kept(j))) j++;
      if (j === i) { rows.push({ kind: "block", index: i++ }); continue; }
      // Unchanged blocks keep one beside each change; removed ones show their first.
      const from = removed ? i + 1 : i > 0 ? i + 1 : i;
      const to = removed ? j : j < items.length ? j - 1 : j;
      const key = `${removed ? "removed" : "unchanged"}:${i}`;
      const folds = (removed ? j - i >= REMOVED_RUN : j - i >= UNCHANGED_RUN) && to - from > 0 && !opened.has(key);
      for (let k = i; k < j; k++) {
        if (folds && k === from) rows.push({ kind: "fold", key, from, to, removed });
        if (!folds || k < from || k >= to) rows.push({ kind: "block", index: k });
      }
      i = j;
    }
    return rows;
  }, [items, placed, opened]);

  // Text selected in the blocks, once it rests, picks their lines; a click in the document drops what it picked.
  const root = useRef<HTMLDivElement>(null);
  const sent = useRef<string | null>(null);
  const latest = useRef({ items, lines, path, onLineSelected });
  latest.current = { items, lines, path, onLineSelected };
  useEffect(() => {
    let rest: ReturnType<typeof setTimeout> | undefined;
    const blockOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-md-index]");
    const update = () => {
      const { items, lines, path, onLineSelected } = latest.current;
      const selection = document.getSelection();
      const el = root.current;
      if (!el || !selection?.rangeCount || !onLineSelected) return;
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      if (selection.isCollapsed) {
        if (sent.current) { sent.current = null; onLineSelected(path, null); }
        return;
      }
      // Text in a comment or the comment box isn't the document's.
      const ends = [range.startContainer, range.endContainer].map((node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-md-notes]") ? null : blockOf(node));
      if (!ends[0] || !ends[1]) return;
      // A changed block's versions before, above it, are the old file's.
      const [from, to] = [range.startContainer, range.endContainer].map((node, at): SelectionEnd => {
        const ghost = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-md-ghost]")?.dataset.mdGhost;
        return { index: Number(ends[at]!.dataset.mdIndex), ...(ghost !== undefined ? { ghost: Number(ghost) } : {}) };
      });
      const picked = selectedBlocks(items, from, to);
      const anchor = selectionAnchor(lines, picked);
      const last = picked[picked.length - 1];
      const side = (anchor?.side ?? last.side) === "LEFT" ? "deletions" : "additions";
      const lineRange: SelectedLineRange = anchor ? { start: anchor.startLine ?? anchor.line, end: anchor.line, side } : { start: picked[0].block.start, end: last.block.end, side };
      const askOnly = anchor ? undefined : { code: picked.map((item) => item.block.source).join("\n\n") };
      const key = JSON.stringify([path, lineRange, !!askOnly]);
      if (key === sent.current) return;
      sent.current = key;
      onLineSelected(path, lineRange, askOnly);
    };
    const changed = () => { clearTimeout(rest); rest = setTimeout(update, SELECTION_REST_MS); };
    document.addEventListener("selectionchange", changed);
    return () => { clearTimeout(rest); document.removeEventListener("selectionchange", changed); };
  }, []);
  // Lines cleared, as with Esc or ✕: the same text selected again picks them again.
  useEffect(() => { if (!selected) sent.current = null; }, [selected]);

  const pickedSide = selected && ((selected.endSide ?? selected.side) === "deletions" ? "LEFT" : "RIGHT");
  const isPicked = (item: RenderedBlock) => !!selected && item.side === pickedSide
    && item.block.start <= Math.max(selected.start, selected.end) && item.block.end >= Math.min(selected.start, selected.end);

  /** `ghost`: which of a changed block's versions before it is. */
  function blockView(item: RenderedBlock, index: number, first: boolean, ghost?: number) {
    const anchor = ghost !== undefined ? blockAnchor(lines, item) : anchors[index];
    const definitions = item.side === "LEFT" ? diff.oldDefinitions : diff.newDefinitions;
    const said = SAID[item.status];
    return (
      <div
        data-md-block={item.block.kind}
        data-md-ghost={ghost}
        data-side={item.side}
        data-start={item.block.start}
        data-end={item.block.end}
        className={cn("group/block relative flow-root border-l-[3px] pl-4", BAR[item.status], spaceAbove(item.block, first), ghost === undefined && isPicked(item) && "bg-primary/5")}
      >
        {said && <span className="sr-only">{ghost !== undefined ? "Before the change" : said}, {item.side === "LEFT" ? "old " : ""}{item.block.start === item.block.end ? `line ${item.block.start}` : `lines ${item.block.start}–${item.block.end}`}</span>}
        <div className="relative">
          {/* In the gutter left of the bar, where there's a mouse to aim it; a touch screen selects the text instead. */}
          {anchor && onComment && (
            <button
              type="button"
              aria-label={`Comment on ${linesSaid(anchor)}`}
              className="absolute -left-[43px] top-0 hidden size-5 items-center justify-center rounded-md bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 group-hover/block:opacity-100 any-pointer-fine:flex"
              onClick={() => onComment({ file: path, line: anchor.line, side: anchor.side, ...(anchor.startLine !== undefined ? { startLine: anchor.startLine } : {}) })}
            >
              <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
            </button>
          )}
          <div className={cn(item.status === "removed" && "opacity-60")}>
            <Markdown content={linkImages(blockMarkdown(item.block, definitions))} />
          </div>
        </div>
      </div>
    );
  }

  if (!items.length) return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing to render.</p>;
  return (
    <div ref={root} data-md-rendered className="py-3 pl-9 pr-4">
      {rows.map((row, at) => {
        if (row.kind === "fold") {
          const count = row.to - row.from;
          return (
            <div key={row.key} data-md-fold data-side={row.removed ? "LEFT" : "RIGHT"} data-start={items[row.from].block.start} data-end={items[row.to - 1].block.end}
              className={cn("border-l-[3px] pl-4", row.removed ? "border-dashed border-diff-removed" : "border-transparent", at > 0 && "pt-2")}>
              <button type="button" className={cn("flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground", TOUCH_COMPACT)}
                onClick={() => setOpened((open) => new Set([...open, row.key]))}>
                <Icon name="ArrowUpDown" className="size-3.5 shrink-0" aria-hidden />
                {row.removed ? `Show ${count} more removed section${count === 1 ? "" : "s"}` : `${count} unchanged section${count === 1 ? "" : "s"} · Show`}
              </button>
            </div>
          );
        }
        const item = items[row.index];
        const notes = placed.get(row.index) ?? [];
        const showing = previous.has(row.index);
        return (
          <div key={`${item.side}:${item.block.start}`} data-md-index={row.index} data-md-status={item.status}>
            {showing && item.previous?.map((old, k) => <Fragment key={k}>{blockView({ status: "removed", side: "LEFT", block: old }, row.index, at === 0 && k === 0, k)}</Fragment>)}
            {blockView(item, row.index, at === 0 && !showing)}
            {item.previous && (
              <div className="border-l-[3px] border-warning pl-4">
                <button type="button" aria-expanded={showing} className={cn("h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground", TOUCH_COMPACT)}
                  onClick={() => setPrevious((shown) => { const next = new Set(shown); if (!next.delete(row.index)) next.add(row.index); return next; })}>
                  {showing ? "Hide previous" : "Show previous"}
                </button>
              </div>
            )}
            {notes.length > 0 && (
              <div data-md-notes>
                {notes.map((note) => <div key={locationKey(note)}><LineChecks at={note} /><LineThreads at={note} /><InlineLocation at={note} /></div>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
RenderedMarkdown.displayName = "RenderedMarkdown";
