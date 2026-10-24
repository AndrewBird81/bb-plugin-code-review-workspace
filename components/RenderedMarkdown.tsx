import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { CommentLocation } from "../src/draft";
import { blockMarkdown, type MarkdownBlock } from "../lib/markdown-blocks";
import { markdownDiff, rowChanges, type BlockStatus, type RenderedBlock } from "../lib/markdown-diff";
import { blockAnchor, blockAt, fileLines, rangeAnchor, selectedBlocks, selectionAnchor, type FileLines, type LineAnchor, type SelectionEnd } from "../lib/markdown-anchor";
import { linkImages, resolveLinks } from "../lib/link-images";
import { blockWords, changedLinks } from "../lib/markdown-words";
import { pointLine, textLines } from "../lib/markdown-points";
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
/** What a probe of BB's Markdown draws: marked words show only once it draws this with an `<ins>` element. */
const PROBE = "a<ins>b</ins>";

// Set by the first probe that draws an <ins>: every file after marks its words from the start. Never kept past the page.
let marksDrawn = false;
export function resetMarksForTests() { marksDrawn = false; }

/**
 * A hidden probe of BB's Markdown, which today draws sanitized `<del>` and `<ins>` though its contract doesn't promise
 * it: `onDrawn` once it draws the probe's `<ins>`. While its HTML loads, the first time, it draws without; a BB that drops
 * raw HTML never does, so words are never marked.
 */
function WordsProbe({ onDrawn }: { onDrawn: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current!;
    const look = () => { if (el.querySelector("ins")) { observer.disconnect(); marksDrawn = true; onDrawn(); } };
    const observer = new MutationObserver(look);
    observer.observe(el, { subtree: true, childList: true });
    look();
    return () => observer.disconnect();
  }, [onDrawn]);
  return <div ref={box} hidden aria-hidden><Markdown content={PROBE} /></div>;
}

// Marked words as GitHub's rich diff shows them: deleted ones struck on a red tint, inserted ones underlined on a green.
const WORDS = "[&_del]:rounded-sm [&_del]:bg-diff-removed/15 [&_del]:line-through [&_del]:decoration-diff-removed [&_ins]:rounded-sm [&_ins]:bg-diff-added/15 [&_ins]:underline [&_ins]:decoration-diff-added";

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
 * The room above a block, after the block drawn `before` it, as BB's Markdown spaces a whole document: it draws one block
 * alone with no margin above its first element or below its last. Padding, not margin, so the bars of blocks next to
 * each other join. A list's items sit together, a loose list's a paragraph's space apart.
 */
function spaceAbove(block: MarkdownBlock, before: MarkdownBlock | undefined): string {
  if (!before) return "";
  if (block.kind === "heading") return block.depth! <= 2 ? "pt-4" : "pt-3";
  if (block.list && before.list?.marker === block.list.marker && !block.list.loose) return "";
  return "pt-2";
}

// A list item draws as a list of one, whose bottom margin would hold its items apart: the next block's padding spaces it.
const ONE_ITEM = "[&_:is(ul,ol):not(li_*)]:mb-0";

const ROW_TINT = { added: "color-mix(in oklab, var(--diff-added) 12%, transparent)", changed: "color-mix(in oklab, var(--warning) 15%, transparent)" };

/**
 * A comment button in the gutter, for `anchor`'s lines, `top` px down its block: shown on keyboard focus, and while its
 * block is hovered, or as `shown` says. Where
 * there's no mouse to aim it, a tap passes through it, to select the text, and the keyboard still reaches it.
 */
function CommentButton({ anchor, onComment, top = 0, shown }: { anchor: LineAnchor; onComment: (at: LineAnchor) => void; top?: number; shown?: boolean }) {
  return (
    <button
      type="button"
      aria-label={`Comment on ${linesSaid(anchor)}`}
      style={{ top }}
      className={cn("absolute -left-[43px] flex size-5 items-center justify-center rounded-md bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity focus-visible:opacity-100 [@media_not_(any-pointer:fine)]:pointer-events-none", shown === undefined ? "group-hover/block:opacity-100" : shown && "opacity-100")}
      onClick={() => onComment(anchor)}
    >
      <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
    </button>
  );
}

/**
 * A table's comment buttons, one beside each row a comment can take, shown as the pointer is over it: measured from the
 * rows BB's Markdown drew (`tr`, in order), never changing them. Where it drew other rows than the source has, `whole`.
 */
function TableRows({ block, side, lines, onComment, whole }: { block: MarkdownBlock; side: "LEFT" | "RIGHT"; lines: FileLines; onComment: (at: LineAnchor) => void; whole: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<number[] | null>(null);
  const [over, setOver] = useState<number | null>(null);
  useLayoutEffect(() => {
    const drawn = box.current!.parentElement!;
    const rows = () => Array.from(drawn.querySelectorAll("tr"));
    const measure = () => {
      const found = rows();
      const at = drawn.getBoundingClientRect().top;
      const next = found.length === block.rows!.length ? found.map((row) => Math.round(row.getBoundingClientRect().top - at)) : null;
      setTops((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
    };
    const move = (event: PointerEvent) => { const row = (event.target as Element).closest?.("tr"); setOver(row ? rows().indexOf(row) : null); };
    const leave = () => setOver(null);
    measure();
    const changes = new MutationObserver(measure);
    changes.observe(drawn, { subtree: true, childList: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    sizes?.observe(drawn);
    drawn.addEventListener("pointermove", move);
    drawn.addEventListener("pointerleave", leave);
    return () => { changes.disconnect(); sizes?.disconnect(); drawn.removeEventListener("pointermove", move); drawn.removeEventListener("pointerleave", leave); };
  }, [block]);
  return (
    <div ref={box} className="contents">
      {tops ? block.rows!.map((line, row) => {
        const anchor = rangeAnchor(lines, side, line, line);
        return anchor && <CommentButton key={line} anchor={anchor} onComment={onComment} top={tops[row]} shown={over === row} />;
      }) : whole}
    </div>
  );
}

const linesSaid = (anchor: LineAnchor) => `${anchor.startLine !== undefined ? `lines ${anchor.startLine}–${anchor.line}` : `line ${anchor.line}`}${anchor.side === "LEFT" ? " (old)" : ""}`;

/** What shows in order: a block with what goes after it, or a fold of the blocks between `from` and `to`. */
type Row = { kind: "block"; index: number } | { kind: "fold"; key: string; from: number; to: number; removed: boolean };

/**
 * A Markdown file's change, rendered as GitHub's rich diff shows it, with the review's comments: each block of the new
 * file drawn by BB's Markdown, its images as links, with a bar for added or changed, and each removed block from the old
 * file, dimmed with a dashed bar, where it was. A changed block marks its changed words, struck or underlined, where its
 * Markdown lets it (lib/markdown-words.ts), and can show its version before above it. Runs of unchanged
 * blocks fold. Threads, drafts, CI failures and the comment box show after the block holding their line. A block the
 * diff shows has a "+" that opens the comment box on its lines; selecting text picks the lines of the blocks it's in, as
 * picking lines in the code does, or, in blocks GitHub takes no comment on, offers to ask the agent about them.
 */
export const RenderedMarkdown = memo(function RenderedMarkdown({ path, patch, old, now, hideWhitespace, locations, selected, onComment, onLineSelected, linkRoot }: {
  path: string;
  /** Where its relative links go, a PR's tree at its head on GitHub (`…/blob/<sha>/`); without it they stay as written. */
  linkRoot?: string;
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
  // Images as links, and relative links to their files in the PR's tree, both sides at its head.
  const prepare = useCallback((markdown: string) => {
    const linked = linkImages(markdown);
    return linkRoot ? resolveLinks(linked, { root: linkRoot, folder: path.slice(0, path.lastIndexOf("/") + 1) }) : linked;
  }, [linkRoot, path]);
  const id = useId();
  const anchors = useMemo(() => items.map((item) => blockAnchor(lines, item)), [items, lines]);
  // Each changed block's Markdown with its changed words marked, where they can be: drawn once BB's Markdown draws marks.
  const words = useMemo(() => new Map(items.flatMap((item, index) => {
    const marked = item.status === "changed" && item.previous?.length === 1 ? blockWords(item.previous[0], item.block, diff.newDefinitions, prepare) : null;
    return marked ? [[index, marked] as const] : [];
  })), [items, diff, prepare]);
  const [marks, setMarks] = useState(() => marksDrawn);
  // Each changed block's links that now go elsewhere, which its marks can't show: their words are the same.
  const links = useMemo(() => new Map(items.flatMap((item, index) => {
    const changed = item.status === "changed" && item.previous?.length === 1 ? changedLinks(blockMarkdown(item.previous[0], diff.oldDefinitions), blockMarkdown(item.block, diff.newDefinitions)) : [];
    return changed.length ? [[index, changed] as const] : [];
  })), [items, diff]);
  const drawsMarks = useCallback(() => setMarks(true), []);
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
      const [first, last] = [picked[0], picked[picked.length - 1]];
      // The lines the selection starts and ends on: a table's row, a code line, or the line of the words around each end.
      const drawnAt = (node: Node) => (node instanceof Element ? node : node.parentElement)!.closest("[data-md-block]")!;
      const start = pointLine(first.block, drawnAt(range.startContainer), range.startContainer, range.startOffset, "start");
      const end = pointLine(last.block, drawnAt(range.endContainer), range.endContainer, range.endOffset, "end");
      const anchor = selectionAnchor(lines, picked, start, end);
      const side = (anchor?.side ?? last.side) === "LEFT" ? "deletions" : "additions";
      const oneSide = picked.every((item) => item.side === last.side);
      const lineRange: SelectedLineRange = anchor ? { start: anchor.startLine ?? anchor.line, end: anchor.line, side } : oneSide ? { start, end, side } : { start: first.block.start, end: last.block.end, side };
      const askOnly = anchor ? undefined : { code: oneSide ? textLines(picked.map((item) => item.block), start, end) : picked.map((item) => item.block.source).join("\n\n") };
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
  function blockView(item: RenderedBlock, index: number, before: MarkdownBlock | undefined, ghost?: number) {
    const anchor = ghost !== undefined ? blockAnchor(lines, item) : anchors[index];
    const definitions = item.side === "LEFT" ? diff.oldDefinitions : diff.newDefinitions;
    const said = SAID[item.status];
    const marked = ghost === undefined && marks ? words.get(index) : undefined;
    // A changed table's new and changed rows, tinted from a style of its own: BB's Markdown draws the rows.
    const scope = `${id}-${index}`;
    const rowStates = ghost === undefined && item.block.rows && item.previous?.length === 1 && item.previous[0].rows ? rowChanges(item.previous[0], item.block) : [];
    const tints = rowStates.flatMap((state, row) => state ? [`[data-md-rows="${scope}"] ${row ? `tbody tr:nth-child(${row})` : "thead tr:first-child"} { background-color: ${ROW_TINT[state]}; }`] : []).join("\n");
    return (
      <div
        data-md-block={item.block.kind}
        data-md-ghost={ghost}
        data-md-words={marked !== undefined || undefined}
        data-side={item.side}
        data-start={item.block.start}
        data-end={item.block.end}
        className={cn("group/block relative flow-root border-l-[3px] pl-4", BAR[item.status], spaceAbove(item.block, before), item.block.list && ONE_ITEM, marked !== undefined && WORDS, ghost === undefined && isPicked(item) && "bg-primary/5")}
      >
        {said && <span className="sr-only">{ghost !== undefined ? "Before the change" : said}, {item.side === "LEFT" ? "old " : ""}{item.block.start === item.block.end ? `line ${item.block.start}` : `lines ${item.block.start}–${item.block.end}`}</span>}
        <div className="relative">
          {/* In the gutter left of the bar. A table has one for each row, or else, where it draws other rows than its source
              has, this one. */}
          {item.block.rows && onComment ? (
            <TableRows block={item.block} side={item.side} lines={lines} onComment={(at) => onComment({ file: path, ...at })}
              whole={anchor && <CommentButton anchor={anchor} onComment={(at) => onComment({ file: path, ...at })} />} />
          ) : anchor && onComment && <CommentButton anchor={anchor} onComment={(at) => onComment({ file: path, ...at })} />}
          {tints && <style>{tints}</style>}
          <div data-md-rows={tints ? scope : undefined} className={cn(item.status === "removed" && "opacity-60")}>
            <Markdown content={marked ?? prepare(blockMarkdown(item.block, definitions))} />
          </div>
        </div>
      </div>
    );
  }

  if (!items.length) return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing to render.</p>;
  return (
    <div ref={root} data-md-rendered className="py-3 pl-9 pr-4">
      {words.size > 0 && !marks && <WordsProbe onDrawn={drawsMarks} />}
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
        const above = rows[at - 1];
        const before = above?.kind === "block" ? items[above.index].block : undefined;
        const ghosts = showing ? item.previous ?? [] : [];
        return (
          <div key={`${item.side}:${item.block.start}`} data-md-index={row.index} data-md-status={item.status}>
            {ghosts.map((old, k) => <Fragment key={k}>{blockView({ status: "removed", side: "LEFT", block: old }, row.index, k ? ghosts[k - 1] : before, k)}</Fragment>)}
            {blockView(item, row.index, ghosts.at(-1) ?? before)}
            {item.previous && (
              <div className="border-l-[3px] border-warning pl-4">
                {links.get(row.index)?.map((link, k) => (
                  <p key={k} role="note" aria-label="Link changed" className="flex min-w-0 flex-wrap items-center gap-x-1.5 px-1.5 pt-1 text-[11px] text-muted-foreground">
                    <span>Link changed: <span className="text-foreground">{link.text}</span></span>
                    <span className="min-w-0 truncate font-mono line-through decoration-diff-removed" title={link.from}>{link.from}</span>
                    <Icon name="ArrowRight" className="size-3 shrink-0" aria-hidden /><span className="sr-only"> to </span>
                    <span className="min-w-0 truncate font-mono" title={link.to}>{link.to}</span>
                  </p>
                ))}
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
