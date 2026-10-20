// How Code Review Workspace draws a diff inside pierre's shadow root, on top of pierre's own styles (its `unsafeCSS`).
// No colors of its own: every color comes from pierre's --diffs-* variables, which the theme and code theme set, or from
// bb's theme tokens, so the same styles read in any theme, light or dark. Pierre's markup isn't its API: the selectors
// here are pinned by components/diff-css.test.tsx against pierre's own server renderer.

/**
 * The colors the rest derives: the marks (bars, rails, signs) in the theme's add and delete colors, stepped darker in a
 * light theme so they keep 3:1 on their rows; the band's inks, the code's ink mixed into the band; the split view's
 * empty side, the canvas a step darker; the mark for lines new since your review, the code's ink unless a theme names
 * its own (--gr-since-review), since no palette uses it for adding, deleting, or selecting; and a folded run's row,
 * tinted like the deleted lines it stands for.
 */
const DERIVED = `:host {
  --gr-add-mark: light-dark(oklch(from var(--diffs-addition-base) calc(l - 0.07) c h), var(--diffs-addition-base));
  --gr-del-mark: light-dark(oklch(from var(--diffs-deletion-base) calc(l - 0.07) c h), var(--diffs-deletion-base));
  --gr-band-ink: light-dark(color-mix(in lab, var(--diffs-fg) 92%, var(--diffs-bg-separator)), color-mix(in lab, var(--diffs-fg) 82%, var(--diffs-bg-separator)));
  --gr-band-context: light-dark(color-mix(in lab, var(--diffs-fg) 90%, var(--diffs-bg-separator)), color-mix(in lab, var(--diffs-fg) 72%, var(--diffs-bg-separator)));
  --gr-empty-side: oklch(from var(--diffs-bg) calc(l - 0.02) c h);
  --gr-thread-edge: color-mix(in lab, var(--diffs-fg-number) 75%, var(--diffs-bg));
  --gr-since-mark: var(--gr-since-review, var(--diffs-fg));
  --gr-fold-bg: light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-bg-deletion-override, var(--diffs-deletion-base))), color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-bg-deletion-override, var(--diffs-deletion-base))));
  --gr-fold-ink: light-dark(var(--diffs-fg), color-mix(in lab, var(--diffs-fg) 84%, var(--gr-fold-bg)));
  --gr-fold-quiet: light-dark(color-mix(in lab, var(--diffs-fg) 95%, var(--gr-fold-bg)), color-mix(in lab, var(--diffs-fg) 70%, var(--gr-fold-bg)));
}
`;

/**
 * "N unmodified lines" as one quiet band across the row, and across both sides of a split, not a pill in each, with
 * git's function context after it (decorate() stamps it). Its 32px and margins stay: DiffViewer's drawnHeight() counts them.
 * A band that expands both ways has its up and down side by side, as pierre draws them for touch, each the band's
 * height, rather than stacked 16px halves: every expand target is at least 24px square.
 */
const BANDS = `[data-separator="line-info"],
[data-additions] [data-content] [data-separator="line-info"] { background-color: var(--diffs-bg-separator); }
[data-separator="line-info"] [data-separator-wrapper] { background-color: transparent; padding-inline: 0; }
[data-unified] [data-separator="line-info"] [data-separator-wrapper] { padding-inline: 0; }
[data-separator="line-info"] :is([data-separator-content], [data-expand-button]) { border-radius: 0 !important; background-color: transparent; }
[data-additions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] { display: none; }
[data-gutter] [data-separator="line-info"] [data-separator-wrapper] { width: 100cqi; }
[data-separator="line-info"] [data-separator-content] { color: var(--gr-band-ink); flex: 1 1 auto; min-width: 0; gap: 1.5ch; font-size: 12px; letter-spacing: 0.01em; }
[data-separator="line-info"] [data-unmodified-lines] { flex: none; }
[data-separator-content][data-hunk-context]::after {
  content: attr(data-hunk-context);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
  font-family: var(--diffs-font-family, var(--diffs-font-fallback));
  color: var(--gr-band-context);
}
[data-separator="line-info"] [data-expand-button] { border-right: 1px solid var(--diffs-bg); color: var(--gr-band-ink); }
[data-separator="line-info"] [data-expand-button]:hover { color: var(--diffs-fg); background-color: color-mix(in lab, var(--diffs-bg-separator) 85%, var(--diffs-fg)); }
[data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] { grid-template-columns: 34px 34px auto; grid-template-rows: 100%; }
[data-separator="line-info"] [data-separator-multi-button] [data-expand-button] { grid-column: auto; border-block: 0; }
[data-separator="line-info"] [data-separator-multi-button] [data-separator-content] { grid-area: 1 / 3; }
`;

/** The split view's empty side: a flat recess a step below the canvas, its gutter and code one block, no hatching. */
const EMPTY_SIDE = `[data-content-buffer] { background-image: none; background-color: var(--gr-empty-side); }
[data-gutter-buffer="buffer"] { --diffs-line-bg: var(--gr-empty-side); border-right-color: var(--gr-empty-side); }
`;

/**
 * Unified, old and new line numbers in their own columns (decorate() stamps the other side's): a deleted line shows
 * its old number, an added one its new number, an unchanged one both. A narrow diff keeps pierre's one column.
 */
const NUMBERS = `[data-unified] [data-column-number] { display: flex; justify-content: flex-end; column-gap: 1ch; }
[data-unified] [data-column-number] [data-line-number-content] { order: 2; }
[data-unified] [data-column-number]::after {
  content: attr(data-alt-line);
  order: 1;
  display: inline-block;
  min-width: var(--diffs-min-number-column-width, var(--diffs-min-number-column-width-default, 3ch));
  text-align: right;
}
[data-unified] [data-column-number][data-line-type="change-deletion"] [data-line-number-content] { order: 1; }
[data-unified] [data-column-number][data-line-type="change-deletion"]::after { content: ""; order: 2; }
[data-unified] [data-column-number][data-line-type="change-addition"]::after { content: ""; }
@container (max-width: 560px) {
  [data-unified] [data-column-number]::after { display: none; }
  [data-unified] [data-column-number][data-line-type="change-deletion"] [data-line-number-content] { order: 2; }
}
[data-column-number] { font-variant-numeric: tabular-nums; }
`;

/** + and a true minus (U+2212, as wide as +), both bold and in the marks' colors, never selected or copied with the code. */
const SIGNS = `[data-indicators="classic"] :is([data-line-type="change-addition"], [data-line-type="change-deletion"]):is([data-line], [data-no-newline])::before { font-weight: 700; -webkit-user-select: none; user-select: none; }
[data-indicators="classic"] [data-line-type="change-deletion"]:is([data-line], [data-no-newline])::before { content: "\\2212"; color: var(--gr-del-mark); }
[data-indicators="classic"] [data-line-type="change-addition"]:is([data-line], [data-no-newline])::before { color: var(--gr-add-mark); }
`;

/**
 * Beside the signs, a 3px bar at the gutter's outer edge: solid for added lines, dashed for deleted ones, 3px on and
 * 2px off, a period that divides the 20px row, so every row's dashes line up and stay crisp at 1x and 2x.
 */
const BARS = `[data-indicators="classic"] :is([data-line-type="change-addition"], [data-line-type="change-deletion"])[data-column-number]::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  -webkit-user-select: none;
  user-select: none;
  pointer-events: none;
  contain: strict;
}
[data-indicators="classic"] [data-line-type="change-addition"][data-column-number]::before { background-color: var(--gr-add-mark); }
[data-indicators="classic"] [data-line-type="change-deletion"][data-column-number]::before {
  background-image: linear-gradient(to bottom, var(--gr-del-mark) 0 60%, transparent 60% 100%);
  background-size: 100% calc(1lh / round(1lh / 5px));
}
`;

/**
 * A comment hangs from its line: the row behind its card is the canvas, the line's number reads in the code's ink at
 * 600, and a hairline runs down the gutter from it to the card's foot.
 */
const THREADS = `[data-line-annotation],
[data-gutter-buffer="annotation"] { --diffs-annotation-bg: var(--diffs-bg); }
[data-column-number]:has(+ [data-gutter-buffer="annotation"]:not([data-gr-fold-row])) [data-line-number-content],
[data-column-number]:has(+ [data-gutter-buffer="annotation"]:not([data-gr-fold-row]))::after { color: var(--diffs-fg); font-weight: 600; }
[data-gutter-buffer="annotation"]:not([data-gr-fold-row]) {
  background-image: linear-gradient(var(--gr-thread-edge), var(--gr-thread-edge));
  background-repeat: no-repeat;
  background-size: 1px calc(100% - 10px);
  background-position: right 1ch top 0;
}
`;

/**
 * A long run of deleted lines (lib/long-runs.ts) folded past its first lines: decorate() stamps the rows it hides, and
 * its fold row, which is tinted like the lines it stands for, the dashed bar running on through its gutter. Opening it
 * marks those rows open, with no redraw; in a split, the other side beside the fold is the empty side.
 */
const FOLDS = `[data-gr-fold]:not([data-gr-fold-open]) { display: none !important; }
[data-line-annotation][data-gr-fold-row],
[data-gutter-buffer="annotation"][data-gr-fold-row] { --diffs-annotation-bg: var(--gr-fold-bg); }
[data-gutter-buffer="annotation"][data-gr-fold-row] {
  background-image: linear-gradient(to bottom, var(--gr-del-mark) 0 60%, transparent 60% 100%);
  background-repeat: repeat-y;
  background-size: 3px 5px;
  background-position: left 0 top 0;
}
[data-additions] [data-line-annotation][data-gr-fold-row],
[data-additions] [data-gutter-buffer="annotation"][data-gr-fold-row] { --diffs-annotation-bg: var(--gr-empty-side); background-image: none; }
`;

/** Every file's styles, after POINTER_CSS. */
export const DIFF_CSS = DERIVED + BANDS + EMPTY_SIDE + NUMBERS + SIGNS + BARS + THREADS + FOLDS;

/** A new or deleted file has one side, drawn as a file or as a diff: one column of numbers. */
export const ONE_SIDE_CSS = `[data-unified] [data-column-number]::after { display: none; }
[data-unified] [data-column-number][data-line-type="change-deletion"] [data-line-number-content] { order: 2; }
`;

/**
 * A new or deleted file drawn as a file (pierre's bars, no backgrounds): its code in full syntax on the canvas, neutral
 * numbers (but a selected line's number in pierre's selection color), and pierre's bars moved to the seam between
 * numbers and code, where each row's bar meets the next as one rail. A deleted file's rail is dashed, and its code keeps
 * its syntax colors, dimmed: in a light theme, each mixed 60/40 toward the muted text's ink and kept at OKLCH lightness
 * 0.5 or darker, so its palest colors still read at 4.5:1; in a dark theme, mixed half way toward the numbers' ink and
 * kept at OKLCH lightness 0.68 or lighter, so its darkest still read at 4.5:1 under a text selection.
 */
export const WHOLE_FILE_CSS = {
  new: `[data-indicators="bars"] [data-line-type="change-addition"][data-column-number]::before { left: auto; right: -2px; width: 3px; background-color: var(--gr-add-mark, var(--diffs-addition-base)); }
[data-line-type="change-addition"][data-column-number]:not([data-selected-line]) { color: var(--diffs-fg-number); }
`,
  deleted: `[data-indicators="bars"] [data-line-type="change-deletion"][data-column-number]::before {
  left: auto;
  right: -2px;
  width: 3px;
  background-image: linear-gradient(to bottom, var(--gr-del-mark, var(--diffs-deletion-base)) 0 60%, transparent 60% 100%);
  background-size: 100% calc(1lh / round(1lh / 5px));
}
[data-line-type="change-deletion"][data-column-number]:not([data-selected-line]) { color: var(--diffs-fg-number); }
:host { --gr-dim-anchor: light-dark(var(--muted-foreground, var(--diffs-fg-number)), var(--diffs-fg-number)); }
[data-line] span {
  color: light-dark(
    oklch(from color-mix(in oklab, var(--diffs-token-light, var(--diffs-light)) 60%, var(--gr-dim-anchor)) min(l, 0.5) c h),
    oklch(from color-mix(in oklab, var(--diffs-token-dark, var(--diffs-dark)) 50%, var(--gr-dim-anchor)) max(l, 0.68) c h));
}
`,
} as const;

/**
 * Pierre sets a token's italics through light-dark(), which takes colors only, so no token is ever italic: set them
 * for the mode the code draws in, or by the system's when it follows the system.
 */
export function tokenStyleCSS(mode?: "light" | "dark"): string {
  const rule = (scheme: "light" | "dark") => `[data-line] span { font-style: var(--diffs-token-${scheme}-font-style, inherit); }`;
  return mode ? `${rule(mode)}\n` : `${rule("dark")}\n@media (prefers-color-scheme: light) { ${rule("light")} }\n`;
}

/**
 * Lines new since your review: pierre marks each row with its line type and number, a gutter cell with
 * data-column-number, and deletions use old-file numbers in both layouts. Each such line's 2px seam between number and
 * code takes the mark, with no tint, so a deleted line keeps its color; in a file drawn as a file, whose seam is its
 * rail, the mark moves to the cell's outer edge.
 */
export function sinceReviewCSS(newLines: number[], newDeletions: number[], asFile = false): string {
  const rows = (type: string, lines: number[]) => lines.map((n) => `[data-line-type="${type}"][data-column-number="${n}"]`);
  const selectors = [...rows("change-addition", newLines), ...rows("change-deletion", newDeletions)];
  if (!selectors.length) return "";
  return `${selectors.join(",\n")} { ${asFile ? "box-shadow: inset 2px 0 0 var(--gr-since-mark)" : "border-right-color: var(--gr-since-mark)"}; }\n`;
}
