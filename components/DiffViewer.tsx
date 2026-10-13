import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { areSelectionsEqual, parsePatchFiles, processFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { AnnotationSide, DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, SelectedLineRange } from "@pierre/diffs";
import { patchRows, splitPatchByFile } from "../src/patch";
import { droppedNear, filePart, hunksIn } from "../src/hunks";
import { hideWhitespaceChanges } from "../src/whitespace";
import type { FileInterdiff } from "../src/interdiff";
import type { FileOwners } from "../src/codeowners";
import { sameLocation, type CommentLocation } from "../src/draft";
import { cn } from "../lib/utils";
import { useOffFold } from "../lib/use-fold";
import { buildItems, fileCounts } from "../lib/comments";
import { classifyFile } from "../src/classify";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Badge } from "./ui/badge";
import { DiffStat } from "./ui/diff-stat";
import { FilePath } from "./ui/file-path";
import { InlineCode } from "./ui/inline-code";
import { FileTag } from "./FileTag";
import { useIsCompactViewport } from "./ui/hooks/use-compact-viewport";
import { TOUCH_COMPACT } from "./touch";
import { Segmented } from "./reading/DiffOptions";
import { InlineDraftContext, InlineLocation, locationKey } from "./InlineDraft";
import { DiffThreadsContext, LineThreads, OutdatedThreads, threadLocation } from "./LineThreads";
import { CheckFailuresContext, LineChecks, failureLocation } from "./CheckFailures";
import type { ReviewThread } from "../src/threads";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";

/** A changed file's whole contents, or why only its diff shows. */
export type FileContentsResult = z.infer<typeof rpcContract.getFileContents.output>;

export interface FileViewFlags {
  viewed: boolean;
  stale: boolean;
}

/** A line pierre shows CI failures, GitHub threads, a draft comment, a discussion, or the comment box under. Its content comes from CheckFailuresContext, DiffThreadsContext, and InlineDraftContext. */
type Annotation = CommentLocation;

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

const annotationSide = (side: "LEFT" | "RIGHT"): AnnotationSide => (side === "LEFT" ? "deletions" : "additions");

/** More changed lines than this start a file folded. */
const LARGE_DIFF = 1500;
/** Pierre highlights a file up to this many lines, and shows longer ones as plain text. */
const TOKENIZE_MAX_LENGTH = 5000;

/** Lockfiles, generated output, and huge diffs: noise to fold until asked for. */
function startsFolded(path: string, stats: { add: number; del: number }, declared: boolean): boolean {
  const { category } = classifyFile(path, declared);
  return category === "lockfile" || category === "generated" || stats.add + stats.del > LARGE_DIFF;
}

const NONE = new Set<string>();

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
 * move when it does: 20px rows, 16px of padding, and a 48px bar for each run of lines it skips.
 */
function drawnHeight(fileDiff: FileDiffMetadata, style: "split" | "unified"): number {
  return 16 + rowsOf(fileDiff, style) * 20 + fileDiff.hunks.filter((hunk) => hunk.collapsedBefore > 0).length * 48;
}

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

/** Outlines where a reveal landed for a moment, so it's clear which line or comment it is. */
function flash(el: HTMLElement) {
  el.animate?.([{ outline: "2px solid var(--primary)", outlineOffset: "-2px" }, { outline: "2px solid transparent", outlineOffset: "-2px" }], { duration: 1600, easing: "ease-in" });
}

/**
 * Highlights lines new since your review. Pierre marks each rendered row with its
 * line type and number: code rows carry data-line, gutter rows data-column-number,
 * and deletion rows use old-file numbers in both layouts.
 */
export function sinceReviewCSS(newLines: number[], newDeletions: number[]): string {
  const rows = (type: string, lines: number[]) => lines.map((n) => `[data-line-type="${type}"]:is([data-line="${n}"],[data-column-number="${n}"])`);
  const selectors = [...rows("change-addition", newLines), ...rows("change-deletion", newDeletions)];
  if (!selectors.length) return "";
  const tint = "color-mix(in oklab, var(--primary) 14%, transparent)";
  return `${selectors.join(",\n")} { box-shadow: inset 2px 0 0 var(--primary); background-image: linear-gradient(${tint}, ${tint}); }`;
}

function parseFileDiff(text: string): FileDiffMetadata | null {
  return parsePatchFiles(text).flatMap((p) => p.files)[0] ?? null;
}

/** Whether GitHub takes a comment at a line: only lines the diff shows. */
function diffLines(text: string): (at: CommentLocation) => boolean {
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
    disableFileHeader: true,
    tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
    overflow: wrap ? "wrap" : "scroll",
  }), [darkTheme, lightTheme, themeMode, wrap]);
  if (!fileDiff) return null;
  return <div className="overflow-x-auto"><FileDiff fileDiff={fileDiff} options={options} /></div>;
});

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

/** The code row pierre drew for a line with no comment under it. */
function lineRow(fileEl: HTMLElement, at: CommentLocation): HTMLElement | undefined {
  const shadow = fileEl.querySelector("diffs-container")?.shadowRoot;
  const [own, other, column] = at.side === "LEFT" ? ["change-deletion", "change-addition", "[data-deletions]"] : ["change-addition", "change-deletion", "[data-additions]"];
  return (shadow?.querySelector<HTMLElement>(`[data-line-type="${own}"][data-line="${at.line}"]`)
    ?? shadow?.querySelector<HTMLElement>(`:is(${column},[data-unified]) [data-line="${at.line}"]:not([data-line-type="${other}"])`)) ?? undefined;
}

/** A file's diff with its whole contents, from the diff text and contents it was made from. */
type FullDiff = { text: string; loaded: FileContentsResult; fileDiff: FileDiffMetadata; commentable: (at: CommentLocation) => boolean };

const lineEnd = (file: string, range: SelectedLineRange): CommentLocation => ({ file, line: range.end, side: (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT" });

function renderAnnotation({ metadata }: DiffLineAnnotation<Annotation>) {
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

// One file's diff. Pierre redraws a file whenever its options or annotations
// are new objects, which also takes focus from an open comment box, so both
// stay the same until something in them changes.
const FileBody = memo(function FileBody({ path, fileDiff, darkTheme, lightTheme, themeMode, diffStyle, wrap, annotations, selected, onLineSelected, onComment, unsafeCSS, wholeFile = false, commentable }: {
  path: string;
  fileDiff: FileDiffMetadata;
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
  /** Extra styles inside pierre's shadow root, such as lines new since your review. */
  unsafeCSS?: string;
  /** Show every line of a file loaded in full, not just around its changes. */
  wholeFile?: boolean;
  /** In a file loaded in full, the lines a comment can go on. */
  commentable?: (at: CommentLocation) => boolean;
}) {
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
    diffStyle,
    // The card's own header names the file, counts its changes, and marks it viewed.
    disableFileHeader: true,
    tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
    overflow: wrap ? "wrap" : "scroll",
    unsafeCSS: POINTER_CSS + (unsafeCSS ?? ""),
    expandUnchanged: wholeFile,
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
  }), [darkTheme, lightTheme, themeMode, diffStyle, wrap, path, onLineSelected, onComment, unsafeCSS, wholeFile, commentable]);
  // A drag the browser takes over as a scroll ends pierre's pick without onLineSelectionEnd: the lines go back.
  return (
    <div className="overflow-x-auto" onPointerDownCapture={(event) => { pointer.current = event.pointerType || "mouse"; }} onPointerCancelCapture={() => setDragging(undefined)}>
      <FileDiff fileDiff={fileDiff} options={options} lineAnnotations={annotations} selectedLines={shown} renderAnnotation={renderAnnotation} />
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
}: {
  diffLayout?: "split" | "unified";
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
  onLineSelected?: (file: string, range: SelectedLineRange | null) => void;
  /** The lines picked in the diff, highlighted until cleared. */
  selectedLines?: { file: string; range: SelectedLineRange } | null;
  /** Scroll to a comment's line, opening its file if it's collapsed. */
  reveal?: { at: CommentLocation; nonce: number };
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
}) {
  const theme = useTheme();
  // A phone's, or one held sideways: the workspace's layout says, not the window's width.
  const compact = useIsCompactViewport();
  const draft = useContext(InlineDraftContext);
  const github = useContext(DiffThreadsContext);
  const failures = useContext(CheckFailuresContext);
  const root = useRef<HTMLDivElement>(null);
  const filtering = sinceOnly && !!since;
  // The chapter's files by value: a reload's new array with the same files mustn't re-parse every diff.
  const fileKey = files.join("\0");
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
      return [{
        path: f.path,
        oldPath: f.oldPath,
        stats,
        noisy: startsFolded(f.path, stats, generated.has(f.path)),
        fileDiff,
        shown,
        whitespaceOnly: stats.add + stats.del > 0 && shownStats.add + shownStats.del === 0,
        // Only the PR's own diff can be shown in full, not changes since your review.
        source: text === f.text && fileDiff?.hunks.length ? f : null,
        change,
        // A split file changed here when its hunks in this chapter did, or changes near them went.
        changedHere: change?.status === "added" || (change?.status === "changed" && (!split || !!hunksIn(change.patch, own) || !!dropped)),
        css: change?.status === "changed" ? sinceReviewCSS(change.newLines, change.newDeletions) : "",
        split,
        first,
        dropped,
        // A split file's comments and threads show in the chapter with their line.
        inPart: split ? diffLines(own) : undefined,
      }];
    });
    // How many files changed since, as the filtered diff shows them: the switch counts them unfiltered too.
    return { perFile, unchanged: chapter.length - shown.length + partsUnchanged, changed: filtering ? perFile.length : perFile.filter((f) => f.changedHere).length };
  }, [patch, fileKey, since, filtering, generated, splitFiles, hideWhitespace]);
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
      const fileDiff = processFile(shown, { oldFile: { name: source.oldPath ?? path, contents: loaded.old ?? "" }, newFile: { name: path, contents: loaded.new ?? "" } });
      if (fileDiff) next.set(path, { text: shown, loaded, fileDiff, commentable: diffLines(source.text) });
    }
    fullDiffs.current = next;
    return next;
  }, [perFile, contents]);
  const removed = useMemo(() => (filtering && showRemoved ? [...since!.values()].filter((f) => f.status === "removed") : []), [since, filtering, showRemoved]);

  // Side-by-side needs room: squeezed between the chapters and the review panel, each side would clip its code.
  const [narrow, setNarrow] = useState(false);
  const hasFiles = perFile.length > 0;
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < UNIFIED_BELOW));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasFiles]);
  const unifiedOnly = compact || narrow;
  useEffect(() => onUnifiedOnly?.(unifiedOnly), [unifiedOnly, onUnifiedOnly]);
  const diffStyle = unifiedOnly ? "unified" : diffLayout;

  // In a large chapter, the files that have come near the screen, or been revealed: only they draw their code.
  // Large by the files that open unfolded: a big lockfile alone doesn't make a chapter slow.
  const lazy = useMemo(() => typeof IntersectionObserver !== "undefined"
    && perFile.reduce((rows, f) => rows + (f.fileDiff && !f.noisy ? rowsOf(f.fileDiff, "unified") : 0), 0) > LAZY_ROWS, [perFile]);
  const [near, setNear] = useState<Set<string>>(NONE);
  const draws = (path: string) => !lazy || near.has(path) || draft?.composer?.file === path;
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

  // Explicit collapse overrides; when unset a file follows its "viewed" flag, and noise starts folded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const noisy = useMemo(() => new Set(perFile.filter((f) => f.noisy).map((f) => f.path)), [perFile]);
  const isCollapsed = (file: string) => collapsed[file] ?? ((views.get(file)?.viewed ?? false) || noisy.has(file));
  const toggleCollapsed = (file: string) => setCollapsed((c) => ({ ...c, [file]: !isCollapsed(file) }));
  // Only a request made while it shows: a diff drawn again later starts as it would.
  const foldedAll = useRef(foldAll);
  useEffect(() => {
    if (!foldAll || foldAll === foldedAll.current) return;
    foldedAll.current = foldAll;
    setCollapsed((c) => ({ ...c, ...Object.fromEntries(perFile.map((f) => [f.path, foldAll.folded])) }));
  }, [foldAll]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleToggleViewed(file: string, next: boolean) {
    onToggleViewed(file, next);
    // Checking Viewed collapses the file; unchecking re-expands it.
    setCollapsed((c) => ({ ...c, [file]: next }));
  }
  // Likewise when it's marked another way: v, or Mark chapter viewed.
  const shownViews = useRef(views);
  useEffect(() => {
    const before = shownViews.current;
    shownViews.current = views;
    const flipped = [...new Set([...before.keys(), ...views.keys()])].filter((file) => (before.get(file)?.viewed ?? false) !== (views.get(file)?.viewed ?? false));
    if (flipped.length) setCollapsed((c) => ({ ...c, ...Object.fromEntries(flipped.map((file) => [file, views.get(file)?.viewed ?? false])) }));
  }, [views]);

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

  // The lines in each file with a GitHub thread, draft comment, discussion, or the comment box.
  // A file keeps its list until those lines change; their content comes from context.
  const previous = useRef(new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>());
  const inPart = useMemo(() => new Map(perFile.flatMap((f) => f.inPart ? [[f.path, f.inPart] as const] : [])), [perFile]);
  const annotations = useMemo(() => {
    const next = new Map<string, { key: string; list: DiffLineAnnotation<Annotation>[] }>();
    for (const path of files) {
      const composer = draft?.composer?.file === path ? draft.composer : null;
      const shows = inPart.get(path) ?? (() => true);
      const lines: CommentLocation[] = [];
      for (const { file, line, side } of [...(draft?.comments ?? []), ...(draft?.discussions ?? []), ...(fromGitHub.get(path)?.placed ?? [])]) {
        const at = { file, line, side };
        if (file === path && shows(at) && !(composer && sameLocation(at, composer)) && !lines.some((seen) => sameLocation(seen, at))) lines.push(at);
      }
      // The box's line comes first: pierre keys annotations by position, so lines coming and going don't remount it.
      if (composer) lines.unshift({ file: path, line: composer.line, side: composer.side });
      const key = JSON.stringify(lines.map((at) => [at.line, at.side]));
      const cached = previous.current.get(path);
      next.set(path, cached?.key === key ? cached : { key, list: lines.map((at) => ({ side: annotationSide(at.side), lineNumber: at.line, metadata: at })) });
    }
    previous.current = next;
    return next;
  }, [files, draft?.comments, draft?.discussions, draft?.composer, fromGitHub, inPart]);

  // Opens the file, then scrolls to the line once the chapter's diffs stop moving:
  // pierre draws each file once its highlighting loads, then sizes the rows beside comments.
  useEffect(() => {
    if (!reveal) return;
    const { at } = reveal;
    // A large chapter jumps: scrolling smoothly would draw every file on the way.
    const behavior = lazy || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    setCollapsed((c) => ({ ...c, [at.file]: false }));
    setNear((current) => current.has(at.file) ? current : new Set([...current, at.file]));
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

  // Above the files, what the diff shows, with how many of them changed since, and the other a tap away: past a fold
  // down the screen.
  const total = perFile.length + unchanged;
  const [switchEl, setSwitchEl] = useState<HTMLDivElement | null>(null);
  useOffFold(switchEl, !compact);
  const compareSwitch = since && onSinceOnly && (
    <div ref={setSwitchEl} className="flex">
      <Segmented label="Changes shown" value={filtering ? "since" : "all"} onChange={(value) => onSinceOnly(value === "since")}
        options={[{ value: "since", label: `Since ${sinceWhat} · ${changed} of ${total} file${total === 1 ? "" : "s"}` }, { value: "all", label: "All changes" }]} />
    </div>
  );
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
        {compareSwitch}
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{filtering ? `Nothing changed in this chapter since ${sinceWhat}.` : "No changes in this chapter."}</p>
        {removedCards}
        {unchangedNote}
      </div>
    );
  }

  return (
    <div ref={root} className="space-y-4">
      {compareSwitch}
      {perFile.map(({ path, oldPath, stats, fileDiff, whitespaceOnly, source, change, changedHere, css, split, first, dropped, noisy: noise }) => {
        const flags = views.get(path);
        const viewed = flags?.viewed ?? false;
        const stale = flags?.stale ?? false;
        const folded = isCollapsed(path);
        const count = counts.get(path);
        const comments = (count?.notSubmitted ?? 0) + (count?.onGitHub ?? 0);
        const commentLabel = [count?.notSubmitted && `${count.notSubmitted} not submitted`, count?.onGitHub && `${count.onGitHub} on GitHub`].filter(Boolean).join(" · ");
        const loaded = contentsFor(path, source);
        const loading = loaded === "loading";
        const full = expanded.get(path);
        const owned = owners?.get(path);
        const summary = summaries?.get(path);
        const added = change?.status === "added";
        const since = `${added ? "Added to the PR" : "Changed"} since ${sinceWhat}`;
        // Noise folded unseen shows what it is and how to see it; any other folded file is its row alone.
        const showDiff = folded && !viewed && noise;
        const detailed = !folded || showDiff;
        const tagged = classifyFile(path, generated.has(path)).category !== "code";
        const details = detailed && (summary || oldPath || split || owned || stale || tagged || showDiff || readContents && source && !folded);
        return (
          <div
            key={path}
            ref={(el) => registerFileEl?.(path, el)}
            data-file={path}
            className={cn(
              // clip, not hidden: the header sticks to the scrolling review, not to this card.
              "overflow-clip rounded-lg border border-border bg-card shadow-xs transition-opacity duration-150",
              viewed && folded && "opacity-75 focus-within:opacity-100 hover:opacity-100",
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
              <FilePath path={path} className="min-w-0 flex-1 text-xs" nameClassName="min-w-0 shrink-[0.01] truncate font-medium" />
              {changedHere && (
                <Badge tone="primary" size="sm" icon={<Icon name="GitCommit" aria-hidden />} title={since} className="text-[11px]">
                  {added ? "Added" : "Changed"}<span className="sr-only"> since {sinceWhat}</span>
                </Badge>
              )}
              {comments > 0 && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[11px] leading-5 text-primary" title={commentLabel}>
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  <span aria-hidden>{comments}</span>
                  <span className="sr-only">{commentLabel}</span>
                </span>
              )}
              <DiffStat add={stats.add} del={stats.del} className="hidden @min-[700px]/review:inline-flex" />
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
                  {summary && <p className="text-xs leading-snug text-muted-foreground"><InlineCode text={summary} /></p>}
                  {oldPath && <p className="truncate text-[11px] text-muted-foreground">Renamed from <span className="font-mono">{oldPath}</span></p>}
                  {split && <p className="truncate text-[11px] text-muted-foreground">Also in <InlineCode text={split.alsoIn.join(", ")} /></p>}
                  {owned && (
                    <p className={cn("flex items-center gap-1 text-[11px]", owned.mine ? "text-primary" : "text-muted-foreground")} title="From the repo's CODEOWNERS">
                      <Icon name="UserRound" className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">Owned by <span className="font-mono">{owned.owners.join(" ")}</span>{owned.mine && <span className="font-medium"> · yours</span>}</span>
                    </p>
                  )}
                  {stale && <p className="flex items-center gap-1 text-[11px] font-medium text-warning-text"><Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />Changed since you viewed it</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <FileTag file={path} generated={generated.has(path)} className="text-[11px]" />
                  {showDiff && (
                    <Button variant="ghost" size="sm" aria-label={`Show diff of ${path}`} className={cn("h-6 shrink-0 px-2 text-[11px]", TOUCH_COMPACT)} onClick={() => toggleCollapsed(path)}>Show diff</Button>
                  )}
                  {readContents && source && !folded && (full ? (
                    <Button variant="ghost" size="sm" aria-label={`Whole file ${path}`} aria-pressed={!!wholeFile[path]} className={cn("h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground aria-pressed:text-primary", TOUCH_COMPACT)} onClick={() => setWholeFile((w) => ({ ...w, [path]: !w[path] }))}>
                      <Icon name="FileText" className="size-3" aria-hidden />Whole file
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" aria-label={`Expand ${path} around its changes`} disabled={loading} className={cn("h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground", TOUCH_COMPACT)} onClick={() => void expand(path, source.text)}>
                      <Icon name={loading ? "Loading" : "ArrowUpDown"} className={cn("size-3", loading && "animate-spin motion-reduce:animate-none")} aria-hidden />Expand
                    </Button>
                  ))}
                </div>
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
              <div data-pending-diff style={{ height: drawnHeight(full?.fileDiff ?? fileDiff, diffStyle) }} />
            )}
            {!folded && fileDiff && draws(path) && (
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
              />
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
