import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { z } from "zod";
import { areSelectionsEqual, parsePatchFiles, processFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { AnnotationSide, DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, SelectedLineRange } from "@pierre/diffs";
import { patchRows, splitPatchByFile, unplacedSummary } from "../src/patch";
import { droppedNear, filePart, hunksIn } from "../src/hunks";
import { hideWhitespaceChanges } from "../src/whitespace";
import type { FileInterdiff } from "../src/interdiff";
import type { FileOwners } from "../src/codeowners";
import { sameLocation, type CommentLocation } from "../src/draft";
import { cn } from "../lib/utils";
import { useOffFold } from "../lib/use-fold";
import { buildItems, fileCounts } from "../lib/comments";
import { classifyFile, isChosenPath } from "../src/classify";
import { useKnob } from "../lib/settings";
import { testWeakening, weakeningChip, WEAKENING_COUNTED } from "../lib/test-weakening";
import { lockfileDigest, packagesChange } from "../lib/lockfile-digest";
import { hasHiddenBidi } from "../lib/hidden-bidi";
import { withBlankContext } from "../lib/blank-context";
import { DIFF_CSS, ONE_SIDE_CSS, WHOLE_FILE_CSS, sinceReviewCSS, tokenStyleCSS } from "../lib/diff-css";
import { applyOpen, decorate } from "../lib/diff-decorate";
import { FOLD_ROW, FOLD_ROW_COARSE, longRuns, runsHolding, type LongRun } from "../lib/long-runs";
import { confettiCSS, confettiRows } from "../lib/confetti";
import { isMarkdownPath } from "../lib/markdown-blocks";
import { RenderedMarkdown } from "./RenderedMarkdown";
import { LongRunFold, LongRunsContext } from "./LongRunFold";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { keyHint } from "../lib/review-shortcuts";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { DiffStat } from "./ui/diff-stat";
import { FilePath } from "./ui/file-path";
import { InlineCode } from "./ui/inline-code";
import { FileTag } from "./FileTag";
import { useIsCompactViewport } from "./ui/hooks/use-compact-viewport";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { TOUCH_COMPACT } from "./touch";
import { Segmented } from "./reading/DiffOptions";
import { InlineDraftContext, InlineLocation, locationKey } from "./InlineDraft";
import { DiffThreadsContext, LineThreads, OutdatedThreads, threadLocation } from "./LineThreads";
import { CheckFailuresContext, LineChecks, failureLocation } from "./CheckFailures";
import type { ReviewThread } from "../src/threads";
import { toast } from "sonner";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { ErrorBoundary } from "./ErrorBoundary";
import { FileEditorLink } from "./OpenInEditor";
import { ReviewLinksContext } from "../lib/review-links";
import type { rpcContract } from "../src/rpc-contract";

/** A changed file's whole contents, or why only its diff shows. */
export type FileContentsResult = z.infer<typeof rpcContract.getFileContents.output>;

export interface FileViewFlags {
  viewed: boolean;
  stale: boolean;
  /** When it was marked viewed, once the server says. */
  viewedAt?: number;
}

export { sinceReviewCSS } from "../lib/diff-css";

/** How a new or deleted file draws: as a file, its code with a rail beside it, or as a diff. */
export type NewFilesShow = "file" | "diff";

/** How a Markdown file opens: its diff, or rendered. */
export type MarkdownShow = "source" | "rendered";

/** A long run of deleted lines' fold row, under the last of its lines that show; `fold` is the run's index in its file. */
interface FoldAt { fold: number; file: string }

/**
 * A line pierre shows CI failures, GitHub threads, a draft comment, a discussion, or the comment box under, whose content
 * comes from CheckFailuresContext, DiffThreadsContext, and InlineDraftContext; or a long run's fold row.
 */
type Annotation = CommentLocation | FoldAt;

// NOTE: @pierre/diffs@1.3.6 — `parsePatchFiles` returns `ParsedPatch[]`, each
// with a nested `.files`; `FileDiff`'s prop is `fileDiff` and the theme lives
// under `options: { theme }`. (See the original task-14 note.)
function useTheme() {
  const darkTheme = document.documentElement.dataset.bbCodeThemeDark;
  const lightTheme = document.documentElement.dataset.bbCodeThemeLight;
  return darkTheme && lightTheme ? { dark: darkTheme, light: lightTheme } : undefined;
}

function diffStats(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const { kind } of patchRows(text)) {
    if (kind === "+") add++;
    else if (kind === "-") del++;
  }
  return { add, del };
}

const annotationSide = (side: CommentLocation["side"]): AnnotationSide => (side === "LEFT" ? "deletions" : "additions");

/** More changed lines than this start a file folded. */
const LARGE_DIFF = 1500;
/** Pierre highlights a file up to this many lines, and shows longer ones as plain text. */
const TOKENIZE_MAX_LENGTH = 5000;

/** Lockfiles and generated output, while Settings folds them (`foldGenerated`), and huge diffs: noise to fold until asked for. */
function startsFolded(path: string, stats: { add: number; del: number }, declared: boolean, chosen: boolean, foldGenerated: boolean): boolean {
  const category = foldGenerated ? classifyFile(path, declared, chosen).category : null;
  return category === "lockfile" || category === "generated" || stats.add + stats.del > LARGE_DIFF;
}

const NONE = new Set<string>();
const NO_RUNS: readonly LongRun[] = [];
const NO_FOLDS: ReadonlySet<number> = new Set();

/**
 * A chapter showing more rows than this draws each file's code only once it nears the screen:
 * highlighting 300 files at once held the page for over 40 seconds.
 */
const LAZY_ROWS = 3000;
/** How far beyond the visible diff a file starts drawing. */
const LAZY_MARGIN = "2000px 0px";

/** The rows a file's hunks draw in a layout. */
function rowsOf(fileDiff: FileDiffMetadata, style: "split" | "unified"): number {
  return fileDiff.hunks.reduce((rows, hunk) => rows + (style === "split" ? hunk.splitLineCount : hunk.unifiedLineCount), 0);
}

/**
 * The height pierre draws a file's diff at, held while it waits to draw so the files above it don't
 * move when it does: 20px rows, 16px of padding, a 48px bar for each run of lines it skips, and a fold row (`foldRow`
 * tall) for each long run of deleted lines it folds, less the rows its closed folds hide.
 */
function drawnHeight(fileDiff: FileDiffMetadata, style: "split" | "unified", hidden = 0, folds = 0, foldRow = FOLD_ROW): number {
  return 16 + (rowsOf(fileDiff, style) - hidden) * 20 + fileDiff.hunks.filter((hunk) => hunk.collapsedBefore > 0).length * 48 + folds * foldRow;
}

/**
 * A file waiting to draw its code, as rows of muted bars where its lines will be, past the gutter's room: drawn by its
 * background, so a chapter of hundreds of them adds no elements.
 */
const PENDING_ROWS = {
  backgroundImage: "repeating-linear-gradient(to bottom, transparent 0 6px, color-mix(in oklab, var(--muted) 80%, transparent) 6px 14px, transparent 14px 20px)",
  backgroundSize: "min(60%, 480px) calc(100% - 16px)",
  backgroundPosition: "64px 8px",
  backgroundRepeat: "no-repeat",
} as const;

/** Below this width the diff shows one column, whatever the reading layout: each side of a split needs about 480px. */
const UNIFIED_BELOW = 960;

// A line's row is in pierre's shadow root, so the way out of it goes through its host.
const outer = (el: Element): Element | null => el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>).host ?? null;

/** The element the diff scrolls in. */
function scrollParent(el: Element): Element | null {
  let box = outer(el);
  while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = outer(box);
  return box;
}

// Scrolls the review only vertically: scrollIntoView would also scroll the diff's code sideways.
// Centers `from` down to `el` in the part of the review the file's sticky header doesn't cover,
// or puts `from` just under the header when they don't fit.
function scrollToCenter(el: HTMLElement, behavior: ScrollBehavior, header = 0, from: HTMLElement = el) {
  let box = outer(el);
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = outer(box);
  if (!box) return;
  const top = from.getBoundingClientRect().top;
  const height = el.getBoundingClientRect().bottom - top;
  const view = box.getBoundingClientRect();
  const room = view.height - header;
  box.scrollBy({ top: top - view.top - header - Math.max(0, (room - height) / 2), behavior });
}

/** How long, in ms, ⇧J or ⇧K goes on from the change it last went to, in view yet or not. */
const CHANGE_STEP_RECENT = 1000;

/** Outlines where a reveal landed for a moment, so it's clear which line or comment it is. */
function flash(el: HTMLElement) {
  el.animate?.([{ outline: "2px solid var(--primary)", outlineOffset: "-2px" }, { outline: "2px solid transparent", outlineOffset: "-2px" }], { duration: 1600, easing: "ease-in" });
}

function parseFileDiff(text: string): FileDiffMetadata | null {
  return parsePatchFiles(withBlankContext(text)).flatMap((p) => p.files)[0] ?? null;
}

/** Whether GitHub takes a comment at a line: only lines the diff shows. */
export function diffLines(text: string): (at: CommentLocation) => boolean {
  const right = new Set<number>(), left = new Set<number>();
  for (const row of patchRows(text)) {
    if (row.kind === "+" || row.kind === " ") right.add(row.newLine);
    if (row.kind === "-" || row.kind === " ") left.add(row.oldLine);
  }
  return (at) => (at.side === "LEFT" ? left : right).has(at.line);
}

/** A diff to read, not comment on: a removed file or changes gone since your review. */
const StaticDiff = memo(function StaticDiff({ text, darkTheme, lightTheme, themeMode, wrap }: { text: string; darkTheme?: string; lightTheme?: string; themeMode?: "light" | "dark"; wrap: boolean }) {
  const fileDiff = useMemo(() => parseFileDiff(text), [text]);
  const options = useMemo<FileDiffOptions<undefined>>(() => ({
    ...(darkTheme && lightTheme ? { theme: { dark: darkTheme, light: lightTheme } } : {}),
    themeType: themeMode,
    diffStyle: "unified",
    diffIndicators: "classic",
    disableFileHeader: true,
    tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
    overflow: wrap ? "wrap" : "scroll",
    unsafeCSS: DIFF_CSS + tokenStyleCSS(themeMode),
    onPostRender: (node, _diff, phase) => { if (fileDiff && phase !== "unmount") decorate(node, fileDiff); },
  }), [darkTheme, lightTheme, themeMode, wrap, fileDiff]);
  if (!fileDiff) return null;
  return <div className="overflow-x-auto"><FileDiff fileDiff={fileDiff} options={options} /></div>;
});

/** One file's diff to read, not comment on, elsewhere than the review's code (Not pushed yet): unified, wrapped, without its file's header. */
export function ReadOnlyDiff({ text, themeMode }: { text: string; themeMode?: "light" | "dark" }) {
  const theme = useTheme();
  return <StaticDiff text={text} darkTheme={theme?.dark} lightTheme={theme?.light} themeMode={themeMode} wrap />;
}

/** A collapsible diff that draws only while open. */
function DiffDetails({ summary, text, defaultOpen = false, className, theme, themeMode, wrap }: {
  summary: ReactNode; text: string; defaultOpen?: boolean; className?: string; theme?: { dark: string; light: string }; themeMode?: "light" | "dark"; wrap: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={className}>
      {summary}
      {open && <StaticDiff text={text} darkTheme={theme?.dark} lightTheme={theme?.light} themeMode={themeMode} wrap={wrap} />}
    </details>
  );
}

/** The code row pierre drew for a line with no comment under it, or in rendered Markdown the block or fold showing it. */
function lineRow(fileEl: HTMLElement, at: CommentLocation): HTMLElement | undefined {
  const shadow = fileEl.querySelector("diffs-container")?.shadowRoot;
  const [own, other, column] = at.side === "LEFT" ? ["change-deletion", "change-addition", "[data-deletions]"] : ["change-addition", "change-deletion", "[data-additions]"];
  return (shadow?.querySelector<HTMLElement>(`[data-line-type="${own}"][data-line="${at.line}"]`)
    ?? shadow?.querySelector<HTMLElement>(`:is(${column},[data-unified]) [data-line="${at.line}"]:not([data-line-type="${other}"])`))
    ?? Array.from(fileEl.querySelectorAll<HTMLElement>("[data-md-block], [data-md-fold]")).find((el) => el.dataset.side === at.side && Number(el.dataset.start) <= at.line && Number(el.dataset.end) >= at.line);
}

/**
 * Each change the chapter's drawn code shows, top to bottom: the first row of a block of added or deleted lines, its
 * file's card, and its line. A split's two sides of a block are one change, and so is a folded run with its block.
 */
function changeStops(root: HTMLElement | null): { row: HTMLElement; card: HTMLElement; top: number; line: number; old: boolean }[] {
  const stops: { row: HTMLElement; card: HTMLElement; top: number; line: number; old: boolean }[] = [];
  for (const card of Array.from(root?.querySelectorAll<HTMLElement>("[data-file]") ?? [])) {
    // Rendered Markdown: each run of changed blocks.
    for (const unit of Array.from(card.querySelectorAll<HTMLElement>("[data-md-status]:not([data-md-status=unchanged])"))) {
      if (unit.previousElementSibling?.matches("[data-md-status]:not([data-md-status=unchanged])")) continue;
      // The block itself, not its version before above it.
      const block = unit.querySelector<HTMLElement>("[data-md-block]:not([data-md-ghost])")!;
      stops.push({ row: block, card, top: Math.round(block.getBoundingClientRect().top), line: Number(block.dataset.start), old: block.dataset.side === "LEFT" });
    }
    const tops = new Set<number>();
    for (const cell of Array.from(card.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[data-column-number][data-line-type^="change"]') ?? [])) {
      // A comment under a changed line doesn't start another change.
      let before = cell.previousElementSibling;
      while (before?.matches('[data-gutter-buffer="annotation"]')) before = before.previousElementSibling;
      if (before?.matches('[data-line-type^="change"]') || !cell.getClientRects().length) continue;
      const top = Math.round(cell.getBoundingClientRect().top);
      if (tops.has(top)) continue;
      tops.add(top);
      const row = cell.closest("code")?.querySelector<HTMLElement>(`:scope > [data-content] > [data-line-index="${cell.dataset.lineIndex}"]`) ?? cell;
      stops.push({ row, card, top, line: Number(cell.dataset.columnNumber), old: cell.dataset.lineType === "change-deletion" });
    }
  }
  return stops.sort((a, b) => a.top - b.top);
}

/** A file's diff with its whole contents, from the diff text and contents it was made from. */
type FullDiff = { text: string; loaded: FileContentsResult; fileDiff: FileDiffMetadata; commentable: (at: CommentLocation) => boolean };

const lineEnd = (file: string, range: SelectedLineRange): CommentLocation => ({ file, line: range.end, side: (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT" });

function renderAnnotation({ metadata }: DiffLineAnnotation<Annotation>) {
  if ("fold" in metadata) return <LongRunFold run={metadata.fold} />;
  return <><LineChecks at={metadata} /><LineThreads at={metadata} /><InlineLocation at={metadata} /></>;
}

// Pierre's styles for how a file's lines take a pointer. The gutter's "+" shows only where there's a fine pointer to aim
// it, and a code line keeps its text cursor: it takes a tap, which pierre marks with a pointer cursor, not a click.
const POINTER_CSS = `@media not (any-pointer: fine) { [data-gutter-utility-slot] { display: none; } }
@media (hover: hover) and (pointer: fine) { [data-interactive-lines] [data-line] { cursor: auto; } }
`;

/**
 * Where a tap on a line takes the lines picked in its file: a first tap picks the line, a later one moves the end of the
 * range there, and one on the first line again clears it.
 */
function tapLines(picked: SelectedLineRange | null, line: number, side: AnnotationSide): SelectedLineRange | null {
  if (!picked) return { start: line, end: line, side };
  const anchor = picked.side ?? side;
  if (picked.start === line && anchor === side) return null;
  return { start: picked.start, end: line, side: anchor, ...(side !== anchor ? { endSide: side } : {}) };
}

/** In place of a file's diff that failed to draw: the rest of the review still shows. */
function FileError({ path, prUrl, onRetry }: { path: string; prUrl?: string; onRetry: () => void }) {
  // GitHub names a file's place on the PR's Files page by its path's SHA-256.
  const [href, setHref] = useState(prUrl && `${prUrl}/files`);
  useEffect(() => {
    if (!prUrl) return;
    let cancelled = false;
    crypto.subtle?.digest("SHA-256", new TextEncoder().encode(path)).then((hash) => {
      if (!cancelled) setHref(`${prUrl}/files#diff-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
    }, () => {});
    return () => { cancelled = true; };
  }, [prUrl, path]);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
      <span className="min-w-0 flex-1">Couldn’t show this file’s diff.</span>
      <Button variant="outline" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_COMPACT)} onClick={onRetry}>Try again</Button>
      {href && <Button asChild variant="ghost" size="sm" className={cn("h-7 px-2 text-xs", TOUCH_COMPACT)}><UrlLink href={href}><Icon name="Github" aria-hidden />Open on GitHub</UrlLink></Button>}
    </div>
  );
}

// One file's diff. Pierre redraws a file whenever its options or annotations
// are new objects, which also takes focus from an open comment box, so both
// stay the same until something in them changes.
const FileBody = memo(function FileBody({ path, fileDiff, darkTheme, lightTheme, themeMode, diffStyle, wrap, annotations, selected, onLineSelected, onComment, unsafeCSS, wholeFile = false, commentable, kind, asFile = false, runs = NO_RUNS, openRuns = NO_FOLDS, onToggleRun }: {
  path: string;
  fileDiff: FileDiffMetadata;
  /** A file git adds or deletes whole, which has one side. */
  kind?: "new" | "deleted";
  /** Draw that file as a file: its code on the canvas, a rail beside it. */
  asFile?: boolean;
  /** Its long runs of deleted lines (lib/long-runs.ts), and the ones open. */
  runs?: readonly LongRun[];
  openRuns?: ReadonlySet<number>;
  onToggleRun?: (file: string, run: number) => void;
  darkTheme?: string;
  lightTheme?: string;
  themeMode?: "light" | "dark";
  diffStyle: "split" | "unified";
  wrap: boolean;
  annotations: DiffLineAnnotation<Annotation>[];
  /** The lines picked in this file, until the workspace is done with them. */
  selected: SelectedLineRange | null;
  onLineSelected?: (file: string, range: SelectedLineRange | null) => void;
  onComment?: (at: CommentLocation) => void;
  /** Extra styles inside pierre's shadow root: lines new since your review. */
  unsafeCSS?: string;
  /** Show every line of a file loaded in full, not just around its changes. */
  wholeFile?: boolean;
  /** In a file loaded in full, the lines a comment can go on. */
  commentable?: (at: CommentLocation) => boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // What each draw marks up (lib/diff-decorate.ts), read when it's done, so pierre's options stay the same object.
  const drawing = useRef({ fileDiff, runs, openRuns });
  drawing.current = { fileDiff, runs, openRuns };
  // The runs the last draw folded: one it couldn't shows whole, without its fold row.
  const [folded, setFolded] = useState<ReadonlySet<number>>(NO_FOLDS);
  // Word emphasis on pairs of lines that share almost nothing, taken off; worked out only for a file that draws.
  const confetti = useMemo(() => confettiCSS(confettiRows(fileDiff)), [fileDiff]);
  const toggle = useCallback((run: number) => onToggleRun?.(path, run), [onToggleRun, path]);
  const folds = useMemo(() => ({ runs, open: openRuns, folded, toggle }), [runs, openRuns, folded, toggle]);
  // Opening or closing a run shows or hides its lines where they are: no redraw.
  useEffect(() => {
    const host = box.current?.querySelector("diffs-container");
    if (host) applyOpen(host, openRuns);
  }, [openRuns]);
  const fromGutter = useRef(false);
  // Pierre paints the selection we give it: the lines being dragged over, then the workspace's.
  // Giving it a selection reports that selection back, which isn't the reviewer's pick.
  const [dragging, setDragging] = useState<SelectedLineRange | null>();
  const shown = dragging !== undefined ? dragging : selected;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const ended = useRef(false);
  // What last pressed on the file. A finger or pen picks lines by tapping them (onLineClick); pierre would take a tap on
  // a line's number as a pick of that line alone, so its picks count only when they're a drag over several lines.
  const pointer = useRef("mouse");
  const tapping = () => pointer.current !== "mouse";
  // Lines shown around the diff take no comment: GitHub would refuse it.
  const inDiff = (range: SelectedLineRange) => {
    if (!commentable || commentable(lineEnd(path, range))) return true;
    toast.info("GitHub takes comments only on lines in the diff.");
    return false;
  };
  const options = useMemo<FileDiffOptions<Annotation>>(() => ({
    ...(darkTheme && lightTheme ? { theme: { dark: darkTheme, light: lightTheme } } : {}),
    themeType: themeMode,
    // A new or deleted file has one side to show.
    diffStyle: kind ? "unified" : diffStyle,
    // + and − on changed lines, not their color alone; a file drawn as a file is all one kind, which its rail and
    // header say.
    diffIndicators: asFile ? "bars" : "classic",
    disableBackground: asFile,
    // The card's own header names the file, counts its changes, and marks it viewed.
    disableFileHeader: true,
    tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
    overflow: wrap ? "wrap" : "scroll",
    unsafeCSS: POINTER_CSS + DIFF_CSS + (kind ? ONE_SIDE_CSS : "") + (kind && asFile ? WHOLE_FILE_CSS[kind] : "") + tokenStyleCSS(themeMode) + confetti + (unsafeCSS ?? ""),
    onPostRender: (node, _diff, phase) => {
      if (phase === "unmount") return;
      const { fileDiff, runs, openRuns } = drawing.current;
      const done = decorate(node, fileDiff, runs, openRuns);
      setFolded((before) => (before.size === done.size && [...done].every((run) => before.has(run)) ? before : done));
    },
    expandUnchanged: wholeFile,
    expansionLineCount: 20,
    // GitHub-style line picking: drag to select a range to comment on or ask
    // about, or use the gutter "+" to open a comment box at a line.
    enableLineSelection: true,
    enableGutterUtility: true,
    onLineSelectionStart: (range) => { if (!tapping()) setDragging(range); },
    onLineSelectionChange: (range) => setDragging(range),
    onLineSelectionEnd: () => { ended.current = true; setDragging(undefined); },
    onLineSelected: (range) => {
      const picked = ended.current || !areSelectionsEqual(range ?? undefined, shownRef.current ?? undefined);
      ended.current = false;
      const tap = tapping() && (!range || range.start === range.end && (range.endSide ?? range.side) === range.side);
      if (picked && !tap && !fromGutter.current && (!range || inDiff(range))) onLineSelected?.(path, range);
    },
    // Touch: tap a line, or its number, to pick it; tap another to make a range.
    onLineClick: ({ lineNumber, annotationSide }) => {
      if (!tapping()) return;
      const range = tapLines(selectedRef.current, lineNumber, annotationSide);
      if (!range || inDiff(range)) onLineSelected?.(path, range);
    },
    onGutterUtilityClick: (range) => {
      if (!inDiff(range)) return;
      if (!onComment) return onLineSelected?.(path, range);
      // Pierre reports the "+" as a line selection too, which would offer the selection's actions over the box.
      fromGutter.current = true;
      queueMicrotask(() => { fromGutter.current = false; });
      onComment(lineEnd(path, range));
    },
  }), [darkTheme, lightTheme, themeMode, diffStyle, wrap, path, onLineSelected, onComment, unsafeCSS, wholeFile, commentable, kind, asFile, confetti]);
  // A drag the browser takes over as a scroll ends pierre's pick without onLineSelectionEnd: the lines go back.
  return (
    <div ref={box} className="overflow-x-auto" onPointerDownCapture={(event) => { pointer.current = event.pointerType || "mouse"; }} onPointerCancelCapture={() => setDragging(undefined)}>
      <LongRunsContext.Provider value={folds}>
        <FileDiff fileDiff={fileDiff} options={options} lineAnnotations={annotations} selectedLines={shown} renderAnnotation={renderAnnotation} />
      </LongRunsContext.Provider>
    </div>
  );
});

export const DiffViewer = memo(function DiffViewer({
  patch,
  files,
  summaries,
  splitFiles,
  views,
  onToggleViewed,
  registerFileEl,
  onLineSelected,
  selectedLines,
  themeMode,
  diffLayout = "split",
  wrapLines = false,
  hideWhitespace = false,
  reveal,
  since,
  sinceOnly = false,
  showRemoved = true,
  onUnifiedOnly,
  readContents,
  generated = NONE,
  sinceWhat = "your review",
  owners,
  foldAll,
  onSinceOnly,
  switchSlot,
  prUrl,
  newFiles = "file",
  onNewFiles,
  markdownFiles = "source",
  renderToggle,
  linkRoot,
  changeStep,
}: {
  diffLayout?: "split" | "unified";
  /** How a new or deleted file draws, which its row's Show as diff switches for every review (`onNewFiles`). */
  newFiles?: NewFilesShow;
  onNewFiles?: (show: NewFilesShow) => void;
  /** How a Markdown file opens, which its row's Source and Rendered switch for that file. */
  markdownFiles?: MarkdownShow;
  /** A PR's tree at its head on GitHub (`…/blob/<sha>/`), where a rendered Markdown file's relative links go. */
  linkRoot?: string;
  /** Set to switch a Markdown file between Source and Rendered (m): false for a file that isn't one. */
  renderToggle?: MutableRefObject<((file: string) => boolean) | null>;
  /** Set to step to the next or previous change in the code drawn (⇧J, ⇧K): false when there's none that way. */
  changeStep?: MutableRefObject<((direction: 1 | -1) => boolean) | null>;
  /** Wrap long lines instead of scrolling them sideways. */
  wrapLines?: boolean;
  /** Show lines whose change is only whitespace as unchanged. */
  hideWhitespace?: boolean;
  themeMode?: "light" | "dark";
  patch: string;
  files: string[];
  /** The guide's summary of each file, shown under its path. */
  summaries?: Map<string, string>;
  /** Files split across chapters: the hunks this chapter shows, numbered from 1, and the chapters with the rest. */
  splitFiles?: Map<string, { hunks: number[]; alsoIn: string[] }>;
  views: Map<string, FileViewFlags>;
  onToggleViewed: (file: string, viewed: boolean) => void;
  registerFileEl?: (file: string, el: HTMLElement | null) => void;
  /** `askOnly`: lines of rendered Markdown GitHub takes no comment on, with their source to ask the agent about. */
  onLineSelected?: (file: string, range: SelectedLineRange | null, askOnly?: { code: string }) => void;
  /** The lines picked in the diff, highlighted until cleared. */
  selectedLines?: { file: string; range: SelectedLineRange } | null;
  /** Scroll to a comment's line, opening its file if it's collapsed; with `focus`, as a key asked, the focus goes there. */
  /** `item`: the comment gone to with ] or [, whose card takes the focus when its line has others. */
  reveal?: { at: CommentLocation; nonce: number; focus?: boolean; item?: string };
  /** Each file compared with the diff at your last review. */
  since?: Map<string, FileInterdiff> | null;
  /** Show only what changed since your review. */
  sinceOnly?: boolean;
  /** Show files removed since your review here; they belong to no chapter, so the workspace shows them in the last one. */
  showRemoved?: boolean;
  /** Told whether the diff is too narrow for split, so it shows unified whatever the layout. */
  onUnifiedOnly?: (unifiedOnly: boolean) => void;
  /** A file's whole contents, to show the code around its changes. */
  readContents?: (file: string) => Promise<FileContentsResult>;
  /** Files the repo's .gitattributes marks generated or vendored. */
  generated?: Set<string>;
  /** What `since` compares with, as "since …" says it: "your review", or a commit. */
  sinceWhat?: string;
  /** Each file's CODEOWNERS owners, and whether you or a team you're on is one. */
  owners?: ReadonlyMap<string, FileOwners>;
  /** A new value folds every file, or unfolds them all. */
  foldAll?: { folded: boolean; nonce: number };
  /** Narrows the diff to what changed since, or shows it all. Given, the diff's top switches between them. */
  onSinceOnly?: (sinceOnly: boolean) => void;
  /** Where that switch goes, in the chapter's intro: else it's above the files. */
  switchSlot?: HTMLElement | null;
  /** The PR's link, where a file the diff can't show can be read. */
  prUrl?: string;
}) {
  const theme = useTheme();
  // A phone's, or one held sideways: the workspace's layout says, not the window's width.
  const compact = useIsCompactViewport();
  // A touch screen's fold rows are taller, and a file waiting to draw holds their height.
  const coarse = useMediaQuery("(pointer: coarse)");
  const draft = useContext(InlineDraftContext);
  const github = useContext(DiffThreadsContext);
  const failures = useContext(CheckFailuresContext);
  const { editor } = useContext(ReviewLinksContext);
  const root = useRef<HTMLDivElement>(null);
  const filtering = sinceOnly && !!since;
  // The chapter's files by value: a reload's new array with the same files mustn't re-parse every diff.
  const fileKey = files.join("\0");
  const foldGenerated = useKnob("foldGeneratedFiles");
  const flagWeakTests = useKnob("testWeakening");
  const digestLockfiles = useKnob("lockfileDigest");
  const shortcuts = useKnob("singleKeyShortcuts");
  const { perFile, unchanged, changed } = useMemo(() => {
    // In the guide's order, which reads the chapter's files on purpose.
    const order = new Map(fileKey.split("\0").map((path, index) => [path, index]));
    const chapter = splitPatchByFile(patch).filter((f) => order.has(f.path)).sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    const shown = filtering ? chapter.filter((f) => since!.get(f.path)?.status !== "unchanged") : chapter;
    // Split files changed only in their other chapters' hunks.
    let partsUnchanged = 0;
    const perFile = shown.flatMap((f) => {
      const change = since?.get(f.path);
      const split = splitFiles?.get(f.path);
      const own = split ? filePart(f.text, split.hunks) : f.text;
      // Threads outdated on a split file show with its first hunk; changes gone since your review, with the hunks nearest them.
      const first = !split || split.hunks.includes(1);
      const dropped = split && change?.dropped ? droppedNear(change.dropped, f.text, split.hunks) : change?.dropped ?? "";
      // Filtered, a changed file shows only the hunks that changed since your review.
      const text = filtering && change?.status === "changed" ? (split ? hunksIn(change.patch, own) : change.patch) : own;
      const shown = hideWhitespace ? hideWhitespaceChanges(text) : text;
      const fileDiff = shown ? parseFileDiff(shown) : null;
      // A file whose only change since your review is removed hunks shows just those.
      if (!fileDiff && !(filtering && dropped)) {
        if (filtering && split && !text) partsUnchanged++;
        return [];
      }
      const stats = diffStats(text);
      const shownStats = shown === text ? stats : diffStats(shown);
      const chosen = isChosenPath(f);
      // A file git adds or deletes whole, as pierre reads its `new file mode` or `deleted file mode`.
      const kind = fileDiff?.hunks.length && (fileDiff.type === "new" || fileDiff.type === "deleted") ? fileDiff.type : undefined;
      return [{
        path: f.path,
        oldPath: f.oldPath,
        stats,
        chosen,
        // A deleted file starts folded too: what it says is that it's gone.
        noisy: startsFolded(f.path, stats, generated.has(f.path), chosen, foldGenerated) || kind === "deleted",
        kind,
        // Long runs of deleted lines, folded past their first lines.
        runs: fileDiff && !kind ? longRuns(fileDiff) : NO_RUNS,
        fileDiff,
        shown,
        whitespaceOnly: stats.add + stats.del > 0 && shownStats.add + shownStats.del === 0,
        // Only the PR's own diff can be shown in full, not changes since your review.
        source: text === f.text && fileDiff?.hunks.length ? f : null,
        change,
        // A split file changed here when its hunks in this chapter did, or changes near them went.
        changedHere: change?.status === "added" || (change?.status === "changed" && (!split || !!hunksIn(change.patch, own) || !!dropped)),
        split,
        first,
        dropped,
        // A split file's comments and threads show in the chapter with their line.
        inPart: split ? diffLines(own) : undefined,
        // What the PR's diff of a test file takes out of its tests.
        weakening: flagWeakTests ? testWeakening(f.path, f.text, generated.has(f.path), chosen) : null,
        // What the PR's diff of a lockfile adds and removes.
        digest: digestLockfiles ? lockfileDigest(f.path, f.text) : null,
        // A diff with no hunks, such as a binary or a mode change, says what it does instead; the row names a rename.
        bare: text === f.text && fileDiff && !fileDiff.hunks.length ? unplacedSummary({ path: f.path, text: f.text }) : null,
        // Bidirectional controls in its path or added lines, which can make its code read differently than it runs.
        bidi: hasHiddenBidi(f.path, f.text),
      }];
    });
    // How many files changed since, as the filtered diff shows them: the switch counts them unfiltered too.
    return { perFile, unchanged: chapter.length - shown.length + partsUnchanged, changed: filtering ? perFile.length : perFile.filter((f) => f.changedHere).length };
  }, [patch, fileKey, since, filtering, generated, splitFiles, hideWhitespace, foldGenerated, flagWeakTests, digestLockfiles]);
  // Files loaded in full, each with the diff it was read for, and those showing every line. A new diff starts over.
  const [contents, setContents] = useState<Record<string, { text: string; result: "loading" | FileContentsResult }>>({});
  const [wholeFile, setWholeFile] = useState<Record<string, boolean>>({});
  useEffect(() => { setContents({}); setWholeFile({}); }, [patch]);
  async function expand(path: string, text: string) {
    setContents((c) => ({ ...c, [path]: { text, result: "loading" } }));
    const result = await readContents!(path).catch((): FileContentsResult => ({ ok: false, error: "Couldn’t load the file." }));
    // A reply for a diff since replaced would pair its contents with the new diff.
    setContents((c) => (c[path]?.text === text ? { ...c, [path]: { text, result } } : c));
  }
  const contentsFor = (path: string, source: { text: string } | null) => (source && contents[path]?.text === source.text ? contents[path].result : undefined);
  // Each file's full diff is made again only when its diff or contents change: a new one redraws the file.
  const fullDiffs = useRef(new Map<string, FullDiff>());
  const expanded = useMemo(() => {
    const next = new Map<string, FullDiff>();
    for (const { path, source, shown } of perFile) {
      const loaded = contentsFor(path, source);
      if (!source || typeof loaded !== "object" || !loaded.ok) continue;
      const cached = fullDiffs.current.get(path);
      if (cached?.text === shown && cached.loaded === loaded) { next.set(path, cached); continue; }
      const fileDiff = processFile(withBlankContext(shown), { oldFile: { name: source.oldPath ?? path, contents: loaded.old ?? "" }, newFile: { name: path, contents: loaded.new ?? "" } });
      if (fileDiff) next.set(path, { text: shown, loaded, fileDiff, commentable: diffLines(source.text) });
    }
    fullDiffs.current = next;
    return next;
  }, [perFile, contents]);
  const removed = useMemo(() => (filtering && showRemoved ? [...since!.values()].filter((f) => f.status === "removed") : []), [since, filtering, showRemoved]);

  // Markdown files switched between Source and Rendered, by file; unset, a file opens as Diff options say.
  const [rendered, setRendered] = useState<Record<string, boolean>>({});
  const wantsRendered = (path: string) => rendered[path] ?? markdownFiles === "rendered";
  // Why a Markdown file shows only its source, or null when it can render; undefined for a file that isn't Markdown.
  // Rendered draws the PR's whole change from the file's contents.
  const renderOff = (f: (typeof perFile)[number]): string | null | undefined => {
    if (!isMarkdownPath(f.path) || !readContents || !f.fileDiff?.hunks.length) return undefined;
    if (filtering) return `Rendered shows the whole change, not what changed since ${sinceWhat}.`;
    if (f.split) return "Rendered shows a file whole, and this one is split across chapters.";
    if (!f.source) return undefined;
    const loaded = contentsFor(f.path, f.source);
    return typeof loaded === "object" && !loaded.ok ? loaded.error : null;
  };
  const offId = useId();

  // Side-by-side needs room: squeezed between the chapters and the review panel, each side would clip its code. Measured
  // before the first paint, and until then no file draws its code: a narrow pane never draws side by side first.
  const [narrow, setNarrow] = useState<boolean | null>(null);
  const hasFiles = perFile.length > 0;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // A width of 0 is a pane not laid out, which says nothing of its room.
    const width = el.getBoundingClientRect().width;
    setNarrow(width > 0 && width < UNIFIED_BELOW);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < UNIFIED_BELOW));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasFiles]);
  const unifiedOnly = compact || !!narrow;
  useEffect(() => onUnifiedOnly?.(unifiedOnly), [unifiedOnly, onUnifiedOnly]);
  const diffStyle = unifiedOnly ? "unified" : diffLayout;

  // In a large chapter, the files that have come near the screen, or been revealed: only they draw their code.
  // Large by the files that open unfolded: a big lockfile alone doesn't make a chapter slow.
  const lazy = useMemo(() => typeof IntersectionObserver !== "undefined"
    && perFile.reduce((rows, f) => rows + (f.fileDiff && !f.noisy ? rowsOf(f.fileDiff, "unified") : 0), 0) > LAZY_ROWS, [perFile]);
  const [near, setNear] = useState<Set<string>>(NONE);
  const draws = (path: string) => narrow !== null && (!lazy || near.has(path) || draft?.composer?.file === path);
  useEffect(() => {
    const el = root.current;
    if (!lazy || !el) return;
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.flatMap((entry) => entry.isIntersecting ? [(entry.target as HTMLElement).dataset.file!] : []);
      if (seen.length) setNear((current) => seen.every((file) => current.has(file)) ? current : new Set([...current, ...seen]));
    }, { root: scrollParent(el), rootMargin: LAZY_MARGIN });
    el.querySelectorAll("[data-file]").forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [lazy, perFile]);

  // Explicit collapse overrides; when unset a file follows its "viewed" flag, unless Settings turns that off, and noise
  // starts folded.
  const foldViewed = useKnob("foldViewedFiles");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const noisy = useMemo(() => new Set(perFile.filter((f) => f.noisy).map((f) => f.path)), [perFile]);
  const isCollapsed = (file: string) => collapsed[file] ?? ((foldViewed && (views.get(file)?.viewed ?? false)) || noisy.has(file));
  const toggleCollapsed = (file: string) => setCollapsed((c) => ({ ...c, [file]: !isCollapsed(file) }));
  // Only a request made while it shows: a diff drawn again later starts as it would.
  const foldedAll = useRef(foldAll);
  useEffect(() => {
    if (!foldAll || foldAll === foldedAll.current) return;
    foldedAll.current = foldAll;
    setCollapsed((c) => ({ ...c, ...Object.fromEntries(perFile.map((f) => [f.path, foldAll.folded])) }));
  }, [foldAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Checking Viewed on a file read past its top folds it above the view: its row goes back to the top, the next file
  // under it, rather than the view keeping its scroll and landing files further on.
  const foldedByViewed = useRef<string | null>(null);
  function handleToggleViewed(file: string, next: boolean) {
    onToggleViewed(file, next);
    // Checking Viewed collapses the file; unchecking re-expands it.
    if (!foldViewed) return;
    setCollapsed((c) => ({ ...c, [file]: next }));
    if (next) foldedByViewed.current = file;
  }
  useLayoutEffect(() => {
    const file = foldedByViewed.current;
    foldedByViewed.current = null;
    const card = file && Array.from(root.current?.querySelectorAll<HTMLElement>("[data-file]") ?? []).find((el) => el.dataset.file === file);
    const box = card && scrollParent(card);
    if (!card || !box) return;
    const above = card.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (above < 0) box.scrollTop += above;
  }, [collapsed]);
  // Likewise when it's marked another way: v, or Mark chapter viewed.
  const shownViews = useRef(views);
  useEffect(() => {
    const before = shownViews.current;
    shownViews.current = views;
    const flipped = [...new Set([...before.keys(), ...views.keys()])].filter((file) => (before.get(file)?.viewed ?? false) !== (views.get(file)?.viewed ?? false));
    if (foldViewed && flipped.length) setCollapsed((c) => ({ ...c, ...Object.fromEntries(flipped.map((file) => [file, views.get(file)?.viewed ?? false])) }));
  }, [views, foldViewed]);

  // A Markdown file to show rendered loads its contents once it opens and nears the screen.
  const toRender = perFile.filter((f) => renderOff(f) === null && wantsRendered(f.path) && !isCollapsed(f.path) && draws(f.path) && contentsFor(f.path, f.source) === undefined);
  const renderKey = toRender.map((f) => f.path).join("\0");
  useEffect(() => { for (const f of toRender) void expand(f.path, f.source!.text); }, [renderKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // m: the current file's switch, or why it can't render.
  const renderable = useRef(new Map<string, string | null>());
  renderable.current = new Map(perFile.flatMap((f) => { const off = renderOff(f); return off === undefined ? [] : [[f.path, off] as const]; }));
  useEffect(() => {
    if (!renderToggle) return;
    renderToggle.current = (file) => {
      if (!renderable.current.has(file)) return false;
      const off = renderable.current.get(file);
      if (off) toast.info(off);
      else setRendered((shown) => ({ ...shown, [file]: !(shown[file] ?? markdownFiles === "rendered") }));
      return true;
    };
    return () => { renderToggle.current = null; };
  }, [renderToggle, markdownFiles]);

  // GitHub threads and CI failures go under their lines when this diff shows them; the rest of the threads are outdated.
  const fromGitHub = useMemo(() => {
    const byFile = new Map<string, { placed: CommentLocation[]; outdated: ReviewThread[] }>();
    if (!github?.threads.length && !failures.length) return byFile;
    const lines = new Map(splitPatchByFile(patch).map((f) => [f.path, diffLines(f.text)]));
    for (const failure of failures) {
      const at = failureLocation(failure);
      if (!lines.get(at.file)?.(at)) continue;
      const entry = byFile.get(at.file) ?? { placed: [], outdated: [] };
      entry.placed.push(at);
      byFile.set(at.file, entry);
    }
    for (const thread of github?.threads ?? []) {
      const inDiff = thread.path ? lines.get(thread.path) : undefined;
      if (!thread.path || !inDiff) continue;
      const entry = byFile.get(thread.path) ?? { placed: [], outdated: [] };
      const at = threadLocation(thread);
      if (at && inDiff(at)) entry.placed.push(at);
      else entry.outdated.push(thread);
      byFile.set(thread.path, entry);
    }
    return byFile;
  }, [github?.threads, failures, patch]);

  // The lines in each file with a GitHub thread, draft comment, discussion, or the comment box, then each long run's
  // fold row. A file keeps its list until those lines change; their content comes from context.
  const previous = useRef(new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>());
  const inPart = useMemo(() => new Map(perFile.flatMap((f) => f.inPart ? [[f.path, f.inPart] as const] : [])), [perFile]);
  const runsOf = useMemo(() => new Map(perFile.map((f) => [f.path, f.runs])), [perFile]);
  const annotations = useMemo(() => {
    const next = new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>();
    for (const path of files) {
      const runs = runsOf.get(path) ?? NO_RUNS;
      const composer = draft?.composer?.file === path ? draft.composer : null;
      const shows = inPart.get(path) ?? (() => true);
      const lines: CommentLocation[] = [];
      for (const { file, line, side } of [...(draft?.comments ?? []), ...(draft?.discussions ?? []), ...(fromGitHub.get(path)?.placed ?? [])]) {
        const at = { file, line, side };
        if (file === path && shows(at) && !(composer && sameLocation(at, composer)) && !lines.some((seen) => sameLocation(seen, at))) lines.push(at);
      }
      // The box's line comes first: pierre keys annotations by position, so lines coming and going don't remount it.
      if (composer) lines.unshift({ file: path, line: composer.line, side: composer.side });
      const key = JSON.stringify([lines.map((at) => [at.line, at.side]), runs.map((run) => run.anchor)]);
      const cached = previous.current.get(path);
      next.set(path, cached?.key === key ? cached : { key, list: [
        ...lines.map((at): DiffLineAnnotation<Annotation> => ({ side: annotationSide(at.side), lineNumber: at.line, metadata: at })),
        ...runs.map((run, fold): DiffLineAnnotation<Annotation> => ({ side: "deletions", lineNumber: run.anchor, metadata: { fold, file: path } })),
      ] });
    }
    previous.current = next;
    return next;
  }, [files, draft?.comments, draft?.discussions, draft?.composer, fromGitHub, inPart, runsOf]);
  // The same lines, for rendered Markdown, which shows them after their blocks.
  const locations = useMemo(() => new Map([...annotations].map(([path, { list }]) => [path, list.flatMap((a) => "fold" in a.metadata ? [] : [a.metadata])])), [annotations]);

  // Long runs of deleted lines opened or closed, by file. Unset, a run starts open when a comment, the comment box, a CI
  // failure, or the lines picked are in it. A new diff starts over.
  const [runsShown, setRunsShown] = useState<Record<string, Record<number, boolean>>>({});
  useEffect(() => { setRunsShown({}); }, [patch]);
  const openRunsCache = useRef(new Map<string, ReadonlySet<number>>());
  const openRuns = useMemo(() => {
    const next = new Map<string, ReadonlySet<number>>();
    for (const [path, runs] of runsOf) {
      if (!runs.length) continue;
      const holding = runsHolding(runs, (annotations.get(path)?.list ?? []).flatMap((a) => a.side === "deletions" && !("fold" in a.metadata) ? [a.lineNumber] : []));
      // Lines picked across a run, which picks its folded lines too: by old numbers from where the pick starts.
      const picked = selectedLines?.file === path && selectedLines.range.side === "deletions" ? selectedLines.range : null;
      const end = picked && (picked.endSide ?? "deletions") === "deletions" ? picked.end : picked?.start;
      const across = (run: LongRun) => !!picked && Math.min(picked.start, end!) <= run.to && Math.max(picked.start, end!) >= run.anchor;
      const open = new Set(runs.flatMap((run, index) => (runsShown[path]?.[index] ?? (holding.includes(index) || across(run))) ? [index] : []));
      const cached = openRunsCache.current.get(path);
      next.set(path, cached && cached.size === open.size && [...open].every((run) => cached.has(run)) ? cached : open);
    }
    openRunsCache.current = next;
    return next;
  }, [runsOf, annotations, selectedLines, runsShown]);
  const openRunsNow = useRef(openRuns);
  openRunsNow.current = openRuns;
  const toggleRun = useCallback((file: string, run: number) => {
    const open = !openRunsNow.current.get(file)?.has(run);
    setRunsShown((shown) => ({ ...shown, [file]: { ...shown[file], [run]: open } }));
  }, []);

  // Opens the file, then scrolls to the line once the chapter's diffs stop moving:
  // pierre draws each file once its highlighting loads, then sizes the rows beside comments.
  useEffect(() => {
    if (!reveal) return;
    const { at } = reveal;
    // A large chapter jumps: scrolling smoothly would draw every file on the way.
    const behavior = lazy || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    setCollapsed((c) => ({ ...c, [at.file]: false }));
    setNear((current) => current.has(at.file) ? current : new Set([...current, at.file]));
    // A line in a folded run: the run opens, so its line shows.
    const holding = at.side === "LEFT" ? runsHolding(runsOf.get(at.file) ?? NO_RUNS, [at.line]) : [];
    if (holding.length) setRunsShown((shown) => ({ ...shown, [at.file]: { ...shown[at.file], ...Object.fromEntries(holding.map((run) => [run, true])) } }));
    const drawn = () => Array.from(root.current?.querySelectorAll("diffs-container") ?? []).every((el) => el.shadowRoot?.querySelector("[data-line]"));
    let tries = 0;
    let lastHeight = -1;
    let frame = requestAnimationFrame(function attempt() {
      const fileEl = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-file]") ?? []).find((el) => el.dataset.file === at.file);
      const row = fileEl ? lineRow(fileEl, at) : undefined;
      const landOn = (el: HTMLElement, center: boolean) => {
        // A comment lands with its line, which is above it, and the threads between them.
        if (center) scrollToCenter(el, behavior, fileEl!.querySelector("[data-file-header]")?.getBoundingClientRect().height, row?.getClientRects().length ? row : el);
        else el.scrollIntoView({ behavior, block: "start" });
        flash(el);
        // The focus goes with the view: to the comment's card, or else the file's toggle. A GitHub thread's card is its own.
        const own = reveal.item ? Array.from(fileEl?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []).find((card) => card.dataset.commentId === reveal.item) : undefined;
        const card = own?.querySelector<HTMLElement>("article[tabindex]") ?? (el !== fileEl ? el.querySelector<HTMLElement>("article[tabindex]") : null);
        if (reveal.focus) (card ?? fileEl?.querySelector<HTMLElement>("[data-file-header] button"))?.focus({ preventScroll: true });
      };
      // No line: just the file.
      if (at.line < 1 && fileEl) return landOn(fileEl, false);
      const target = Array.from(fileEl?.querySelectorAll<HTMLElement>("[data-draft-at]") ?? []).find((el) => el.dataset.draftAt === locationKey(at)) ?? row;
      const shown = !!target?.getClientRects().length;
      const height = root.current?.offsetHeight ?? 0;
      const settled = height === lastHeight;
      lastHeight = height;
      if (shown && drawn() && settled) landOn(target!, true);
      else if (++tries < 90) frame = requestAnimationFrame(attempt);
      else if (shown) landOn(target!, true);
      else if (fileEl) landOn(fileEl, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);

  // ⇧J and ⇧K: on from the change last gone to while it's in view, or gone to a moment ago (a smooth scroll there may
  // not have brought it into view yet, and a held key repeats faster), else from the view's top, to the next or
  // previous change drawn, centered and outlined a moment, and said.
  const [changeSaid, setChangeSaid] = useState("");
  const lastChange = useRef<{ row: HTMLElement; at: number } | null>(null);
  useEffect(() => {
    if (!changeStep) return;
    changeStep.current = (direction) => {
      const box = root.current && scrollParent(root.current);
      const stops = changeStops(root.current);
      if (!box || !stops.length) return false;
      const view = box.getBoundingClientRect();
      const inView = (el: HTMLElement) => { const rect = el.getBoundingClientRect(); return rect.bottom > view.top && rect.top < view.bottom; };
      // Still drawn, as it's among the stops.
      const from = stops.findIndex((stop) => stop.row === lastChange.current?.row);
      const recent = from >= 0 && performance.now() - lastChange.current!.at < CHANGE_STEP_RECENT;
      // Below the file's sticky row, which is about 36px.
      const top = view.top + 40;
      const index = from >= 0 && (recent || inView(stops[from].row)) ? from + direction
        : direction === 1 ? stops.findIndex((stop) => stop.top >= top) : stops.reduce((last, stop, at) => (stop.top < top ? at : last), -1);
      const stop = stops[index];
      if (!stop) return false;
      lastChange.current = { row: stop.row, at: performance.now() };
      const header = stop.card.querySelector("[data-file-header]")?.getBoundingClientRect().height;
      scrollToCenter(stop.row, lazy || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", header);
      flash(stop.row);
      setChangeSaid(`Change ${index + 1} of ${stops.length} · ${stop.card.dataset.file}:${stop.line}${stop.old ? " (old line)" : ""}`);
      return true;
    };
    return () => { changeStep.current = null; };
  }, [changeStep, lazy]);

  // Each file's ▤ n, counted as the comments list counts: its drafts and its threads on GitHub that aren't resolved. In a
  // split file, those in this chapter's part; without the nits Hide nits hides (never one that needs you).
  const counts = useMemo(() => {
    const parts = new Map(perFile.map((f) => [f.path, f]));
    const items = buildItems({
      draft: draft ? { draft: { targetKey: "", verdict: "COMMENT", body: "", comments: draft.comments }, stale: draft.stale } : null,
      threads: github?.threads ?? [], feedback: null, sections: [], patch: "",
    });
    return fileCounts(items.filter((item) => {
      const part = item.at && parts.get(item.at.file);
      if (!item.at || !part || item.kind === "draft" && draft?.hideNits && item.comment.severity === "nit" && !item.needs) return false;
      return item.at.line === null ? part.first : part.inPart?.({ file: item.at.file, line: item.at.line, side: item.at.side }) ?? true;
    }));
  }, [draft?.comments, draft?.stale, draft?.hideNits, github?.threads, perFile]);

  // In the chapter's intro, else above the files, what the diff shows, with how many of them changed since, and the
  // other a tap away: past a fold down the screen.
  const total = perFile.length + unchanged;
  const count = `${changed} of ${total} file${total === 1 ? "" : "s"}`;
  const [switchEl, setSwitchEl] = useState<HTMLDivElement | null>(null);
  useOffFold(switchEl, !compact);
  const segmented = since && onSinceOnly && (
    <div ref={setSwitchEl} className="flex">
      <Segmented label="Changes shown" value={filtering ? "since" : "all"} onChange={(value) => onSinceOnly(value === "since")}
        options={[{ value: "since", label: `Since ${sinceWhat} · ${count}` }, { value: "all", label: "All changes" }]} />
    </div>
  );
  const compareSwitch = segmented && switchSlot ? createPortal(segmented, switchSlot) : segmented;
  // The diff narrows by itself as a re-review's comparison arrives: that's said, by a status there before it arrives.
  const narrowedStatus = onSinceOnly && <span role="status" className="sr-only">{filtering ? `Showing changes since ${sinceWhat} · ${count}` : ""}</span>;
  const unchangedNote = unchanged > 0 && <p className="text-center text-xs text-muted-foreground">{unchanged} file{unchanged === 1 ? "" : "s"} unchanged since {sinceWhat}</p>;
  const removedCards = removed.map((file) => (
    <section key={file.file} aria-label={`${file.file} removed`} className="overflow-clip rounded-lg border border-dashed border-border bg-card">
      <DiffDetails text={file.dropped} theme={theme} themeMode={themeMode} wrap={wrapLines} summary={
        <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-2 py-1.5 text-xs">
          <Icon name="FileX2" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <FilePath path={file.file} className="min-w-0 flex-1 line-through decoration-muted-foreground/50" />
          <span className="shrink-0 text-muted-foreground">Removed from the PR since {sinceWhat}</span>
        </summary>
      } />
    </section>
  ));

  if (perFile.length === 0) {
    return (
      <div className="space-y-4">
        {narrowedStatus}
        {compareSwitch}
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{filtering ? `Nothing changed in this chapter since ${sinceWhat}.` : "No changes in this chapter."}</p>
        {removedCards}
        {unchangedNote}
      </div>
    );
  }

  return (
    <div ref={root} className="space-y-4">
      {narrowedStatus}
      {changeStep && <span role="status" className="sr-only">{changeSaid}</span>}
      {compareSwitch}
      {perFile.map(({ path, oldPath, stats, chosen, fileDiff, whitespaceOnly, source, change, changedHere, kind, runs, split, first, dropped, noisy: noise, weakening, digest, bare, bidi }, index) => {
        const asFile = !!kind && newFiles === "file";
        const lines = kind === "deleted" ? stats.del : stats.add;
        const opened = openRuns.get(path) ?? NO_FOLDS;
        const css = change?.status === "changed" ? sinceReviewCSS(change.newLines, change.newDeletions, asFile) : "";
        const flags = views.get(path);
        const viewed = flags?.viewed ?? false;
        const stale = flags?.stale ?? false;
        const folded = isCollapsed(path);
        const count = counts.get(path);
        const comments = (count?.notSubmitted ?? 0) + (count?.onGitHub ?? 0);
        const commentLabel = [count?.notSubmitted && `${count.notSubmitted} not submitted`, count?.onGitHub && `${count.onGitHub} on GitHub`].filter(Boolean).join(" · ");
        const loaded = contentsFor(path, source);
        const loading = loaded === "loading";
        const off = renderOff(perFile[index]);
        const showsRendered = off === null && wantsRendered(path);
        const full = expanded.get(path);
        const owned = owners?.get(path);
        const summary = summaries?.get(path);
        const added = change?.status === "added";
        const since = `${added ? "Added to the PR" : "Changed"} since ${sinceWhat}`;
        // Noise folded unseen shows what it is and how to see it; any other folded file is its row alone.
        const showDiff = folded && !viewed && noise;
        const detailed = !folded || showDiff;
        const tagged = classifyFile(path, generated.has(path), chosen).category !== "code";
        // A local review's file that's still in its checkout opens in an editor.
        const inEditor = !!editor && fileDiff?.type !== "deleted";
        // Hidden bidirectional Unicode is said on a folded file too.
        const details = detailed && (summary || bare || oldPath || split || owned || stale || tagged || showDiff || readContents && source && !folded || off !== undefined && !folded || inEditor) || bidi;
        return (
          <div
            key={path}
            ref={(el) => registerFileEl?.(path, el)}
            data-file={path}
            // A screen reader's region list goes from file to file.
            role="region"
            aria-label={path}
            className={cn(
              // clip, not hidden: the header sticks to the scrolling review, not to this card.
              "group/file overflow-clip rounded-lg border border-border bg-card shadow-xs",
            )}
          >
            {/* The file's row, which sticks while its code scrolls: what it is, how it changed, its comments, Viewed.
                Not with the keyboard up leaving a phone held sideways' room or less: the box you type in gets it. */}
            <div data-file-header className={cn("sticky top-0 z-10 flex h-9 [[data-keyboard=short]_&]:relative items-center gap-1.5 bg-[color-mix(in_oklab,var(--muted)_30%,var(--background))] pl-1 pr-1.5 pointer-coarse:h-11", (details || !folded) && "border-b border-border")}>
              <button
                type="button"
                aria-label={`${folded ? "Expand" : "Collapse"} ${path}`}
                className={cn("flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground", TOUCH_COMPACT)}
                onClick={() => toggleCollapsed(path)}
              >
                <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", folded && "-rotate-90")} aria-hidden />
              </button>
              {/* A viewed file, folded, dims its path alone: dimmed, the row's smaller text fell to about 3:1. */}
              <FilePath path={path} className={cn("min-w-0 flex-1 text-xs transition-opacity duration-150", viewed && folded && "opacity-60 group-focus-within/file:opacity-100 group-hover/file:opacity-100")} nameClassName="min-w-0 shrink-[0.01] truncate font-medium" />
              {changedHere && (
                <Badge tone="primary" size="sm" icon={<Icon name="GitCommit" aria-hidden />} title={since} className="text-[11px]">
                  {/* In words: "Added" alone reads as a file new to the repo. A phone-sized pane keeps the path's room. */}
                  {added ? "New" : "Changed"}<span className="@max-[480px]/review:sr-only"> since {sinceWhat}</span>
                </Badge>
              )}
              {comments > 0 && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[11px] leading-5 text-primary" title={commentLabel}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  <span aria-hidden>{comments}</span>
                  <span className="sr-only">{commentLabel}</span>
                </span>
              )}
              {/* A file added or deleted whole says so, and how long it is, rather than counting its lines as changes. */}
              {kind && (
                <Badge tone={kind === "new" ? "added" : "removed"} size="sm" icon={<Icon name={kind === "new" ? "FilePlus2" : "FileMinus2"} aria-hidden />} className="text-[11px]">
                  {kind === "new" ? "New file" : "Deleted file"}
                </Badge>
              )}
              {kind
                ? <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground @min-[700px]/review:inline">{lines.toLocaleString()} line{lines === 1 ? "" : "s"}</span>
                : <DiffStat add={stats.add} del={stats.del} className="hidden @min-[700px]/review:inline-flex" />}
              {kind && !folded && onNewFiles && !showsRendered && (
                <Button variant="ghost" size="sm" aria-pressed={!asFile} className={cn("hidden h-6 shrink-0 px-2 text-[11px] text-muted-foreground aria-pressed:text-primary @min-[700px]/review:inline-flex", TOUCH_COMPACT)} onClick={() => onNewFiles(asFile ? "diff" : "file")}>
                  Show as diff
                </Button>
              )}
              <label className={cn(
                "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
                TOUCH_COMPACT,
                viewed ? "border-success/30 bg-success/10 text-diff-added" : "border-border text-muted-foreground hover:border-input hover:text-foreground",
              )}>
                <input
                  type="checkbox"
                  className="size-3.5 accent-(--success)"
                  checked={viewed}
                  aria-label={`Viewed ${path}`}
                  onChange={(e) => handleToggleViewed(path, e.target.checked)}
                />
                Viewed
              </label>
            </div>
            {/* What the guide says of it, and what else there is to do with it, which scroll away. The actions end the row
                where they fit, and start a line of their own where they don't. */}
            {details && (
              <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-[color-mix(in_oklab,var(--muted)_30%,var(--background))] px-3 py-1.5", !folded && "border-b border-border")}>
                <div className="min-w-0 flex-1 basis-60 space-y-0.5 empty:hidden">
                  {bidi && <p className="flex items-center gap-1 text-[11px] font-medium text-warning-text"><Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />Hidden bidirectional Unicode in this file can make code read differently than it runs.</p>}
                  {detailed && <>
                    {summary && <p className="text-xs leading-snug text-muted-foreground"><InlineCode text={summary} /></p>}
                    {bare && <p className="text-[11px] text-muted-foreground">{bare}</p>}
                    {oldPath && <p className="truncate text-[11px] text-muted-foreground">Renamed from <span className="font-mono">{oldPath}</span></p>}
                    {split && <p className="truncate text-[11px] text-muted-foreground">Also in <InlineCode text={split.alsoIn.join(", ")} /></p>}
                    {owned && (
                      <p className={cn("flex items-center gap-1 text-[11px]", owned.mine ? "text-primary" : "text-muted-foreground")} title="From the repo's CODEOWNERS">
                        <Icon name="UserRound" className="size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">Owned by <span className="font-mono">{owned.owners.join(" ")}</span>{owned.mine && <span className="font-medium"> · yours</span>}</span>
                      </p>
                    )}
                    {(weakening || digest) && <p className="flex flex-wrap items-center gap-1.5">
                      {weakening && <Badge tone="warning" size="sm" title={WEAKENING_COUNTED}>{weakeningChip(weakening)}</Badge>}
                      {digest && packagesChange(digest) && <Badge size="sm" title="Packages the lockfile adds and removes; a version change counts in neither">{packagesChange(digest)}</Badge>}
                      {digest?.hosts.map((host) => <Badge key={host} tone="warning" size="sm" title="An added package downloads from this host, which isn’t its registry or already in the lockfile">Downloads from {host}</Badge>)}
                    </p>}
                    {stale && <p className="flex items-center gap-1 text-[11px] font-medium text-warning-text"><Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />Changed since you viewed it</p>}
                  </>}
                </div>
                {detailed && <div className="flex flex-wrap items-center gap-1.5">
                  <FileTag file={path} generated={generated.has(path)} chosen={chosen} className="text-[11px]" />
                  {/* Why a file of code folded: its tag says why a lockfile or generated file did. */}
                  {showDiff && (kind === "deleted"
                    ? <span className="text-[11px] tabular-nums text-muted-foreground">Deleted · {lines.toLocaleString()} line{lines === 1 ? "" : "s"}</span>
                    : stats.add + stats.del > LARGE_DIFF && <span className="text-[11px] tabular-nums text-muted-foreground">Large diff · {(stats.add + stats.del).toLocaleString()} lines</span>)}
                  {showDiff && (
                    <Button variant="ghost" size="sm" aria-label={`Show diff of ${path}`} className={cn("h-6 shrink-0 px-2 text-[11px]", TOUCH_COMPACT)} onClick={() => toggleCollapsed(path)}>Show diff</Button>
                  )}
                  {/* A Markdown file: its diff, or rendered; why it can't render, as the choice's tooltip. */}
                  {off !== undefined && !folded && (
                    <Hint label={off ?? keyHint("Source or rendered", "m", shortcuts)}>
                      <span className="flex">
                        <Segmented label={`How ${path} shows`} value={showsRendered ? "rendered" : "source"} onChange={(value) => setRendered((shown) => ({ ...shown, [path]: value === "rendered" }))}
                          options={[{ value: "source", label: "Source" }, { value: "rendered", label: "Rendered", disabled: !!off, reason: off ? `${offId}-${index}` : undefined }]} />
                        {off && <span id={`${offId}-${index}`} className="sr-only">{off}</span>}
                      </span>
                    </Hint>
                  )}
                  {readContents && source && !folded && !showsRendered && (full ? (
                    <Button variant="ghost" size="sm" aria-label={`Whole file ${path}`} aria-pressed={!!wholeFile[path]} className={cn("h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground aria-pressed:text-primary", TOUCH_COMPACT)} onClick={() => setWholeFile((w) => ({ ...w, [path]: !w[path] }))}>
                      <Icon name="FileText" className="size-3" aria-hidden />Whole file
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" aria-label={`Expand ${path} around its changes`} disabled={loading} className={cn("h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground", TOUCH_COMPACT)} onClick={() => void expand(path, source.text)}>
                      <Icon name={loading ? "Loading" : "ArrowUpDown"} className={cn("size-3", loading && "animate-spin motion-reduce:animate-none")} aria-hidden />Expand
                    </Button>
                  ))}
                  {inEditor && <FileEditorLink file={path} line={fileDiff?.hunks[0]?.additionStart ?? null} />}
                </div>}
              </div>
            )}
            {!folded && first && <OutdatedThreads threads={fromGitHub.get(path)?.outdated ?? []} />}
            {!folded && whitespaceOnly && (
              <p role="status" className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                <Icon name="Space" className="size-3.5 shrink-0" aria-hidden />Only whitespace changed.
              </p>
            )}
            {!folded && typeof loaded === "object" && !loaded.ok && (
              <p role="status" className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                <Icon name="Info" className="size-3.5 shrink-0" aria-hidden />{loaded.error}
              </p>
            )}
            {!folded && fileDiff && !draws(path) && (
              <div data-pending-diff aria-hidden style={{ ...PENDING_ROWS, height: drawnHeight(full?.fileDiff ?? fileDiff, kind ? "unified" : diffStyle, runs.reduce((hidden, run, index) => hidden + (opened.has(index) ? 0 : run.count), 0), runs.length, coarse ? FOLD_ROW_COARSE : FOLD_ROW) }} />
            )}
            {!folded && showsRendered && loading && (
              <p role="status" className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                <Icon name="Loading" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />Loading the file to render it…
              </p>
            )}
            {!folded && fileDiff && draws(path) && showsRendered && typeof loaded === "object" && loaded.ok && (
              <ErrorBoundary resetKey={loaded} fallback={(retry) => <FileError path={path} prUrl={prUrl} onRetry={retry} />}>
                <RenderedMarkdown
                  path={path}
                  patch={source!.text}
                  old={loaded.old}
                  now={loaded.new}
                  hideWhitespace={hideWhitespace}
                  locations={locations.get(path) ?? []}
                  selected={selectedLines?.file === path ? selectedLines.range : null}
                  onComment={draft?.editable ? draft.open : undefined}
                  onLineSelected={onLineSelected}
                  linkRoot={linkRoot}
                />
              </ErrorBoundary>
            )}
            {!folded && fileDiff && draws(path) && !(showsRendered && typeof loaded === "object" && loaded.ok) && (
              <ErrorBoundary resetKey={full?.fileDiff ?? fileDiff} fallback={(retry) => <FileError path={path} prUrl={prUrl} onRetry={retry} />}>
              <FileBody
                path={path}
                fileDiff={full?.fileDiff ?? fileDiff}
                wholeFile={!!full && !!wholeFile[path]}
                commentable={full?.commentable}
                darkTheme={theme?.dark}
                lightTheme={theme?.light}
                themeMode={themeMode}
                diffStyle={diffStyle}
                wrap={wrapLines}
                annotations={annotations.get(path)?.list ?? []}
                selected={selectedLines?.file === path ? selectedLines.range : null}
                onLineSelected={onLineSelected}
                onComment={draft?.editable ? draft.open : undefined}
                unsafeCSS={css}
                kind={kind}
                asFile={asFile}
                runs={runs}
                openRuns={opened}
                onToggleRun={toggleRun}
              />
              </ErrorBoundary>
            )}
            {!folded && filtering && dropped && (
              <DiffDetails text={dropped} defaultOpen={!fileDiff} theme={theme} themeMode={themeMode} wrap={wrapLines} className={cn(fileDiff && "border-t border-border")}
                summary={<summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">Changes gone since {sinceWhat}</summary>} />
            )}
          </div>
        );
      })}
      {removedCards}
      {unchangedNote}
    </div>
  );
});
DiffViewer.displayName = "DiffViewer";
