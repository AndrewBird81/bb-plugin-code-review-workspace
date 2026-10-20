import type { FileDiffMetadata } from "@pierre/diffs";
import type { LongRun } from "./long-runs";

const NONE: ReadonlySet<number> = new Set();

/**
 * The gutter cell drawn on the same row as a code column's element, each column's gutter and code being 1:1, if it's
 * the cell that row has: a line's has its line index, a comment's or a fold row's is an annotation buffer, a missing
 * newline's a metadata buffer, and an empty side's a buffer as many rows tall. Otherwise none.
 */
function twin(el: Element): Element | null {
  const content = el.parentElement;
  const gutter = content?.parentElement?.querySelector(":scope > [data-gutter]");
  const other = content && gutter?.children[Array.prototype.indexOf.call(content.children, el)];
  if (!other) return null;
  const index = el.getAttribute("data-line-index");
  const pairs = index !== null ? other.getAttribute("data-line-index") === index
    : el.matches("[data-line-annotation]") ? other.matches('[data-gutter-buffer="annotation"]')
    : el.matches("[data-no-newline]") ? other.matches('[data-gutter-buffer="metadata"]')
    : el.matches("[data-content-buffer]") && other.matches('[data-gutter-buffer="buffer"]') && other.getAttribute("data-buffer-size") === el.getAttribute("data-buffer-size");
  return pairs ? other : null;
}

/** A code column's element and its gutter cell, or nothing when its gutter cell isn't the one its row has. */
const withTwin = (el: Element): Element[] | null => {
  const other = twin(el);
  return other ? [el, other] : null;
};

/** The index of the run, of runs in line order, that folds this line, or -1. */
function runAt(runs: readonly LongRun[], line: number): number {
  let low = 0, high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (line < runs[mid].from) high = mid - 1;
    else if (line > runs[mid].to) low = mid + 1;
    else return mid;
  }
  return -1;
}

function stamp(el: Element | null | undefined, name: string, value: string) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * What pierre's markup doesn't say and the diff's styles (lib/diff-css.ts) need, stamped after each draw: in unified,
 * the other side's number on each gutter cell; on each "N unmodified lines" band, git's function context for the hunk
 * after it; and each long run's folded rows and its fold row (with, in a split, the empty side beside the folded rows),
 * open or not, or, when a comment shares the fold row, that row as shared, so it keeps the comment's look. A run whose
 * rows, or their gutter cells, can't all be found as expected is left unstamped, so it shows whole rather than
 * misaligned. Writes only what differs. Returns the runs it folded.
 */
export function decorate(host: Element, fileDiff: FileDiffMetadata, runs: readonly LongRun[] = [], open: ReadonlySet<number> = NONE): ReadonlySet<number> {
  const root = host.shadowRoot;
  if (!root) return NONE;
  const alt = new Map<string, string>();
  for (const row of Array.from(root.querySelectorAll<HTMLElement>("[data-unified] [data-line][data-alt-line]"))) alt.set(row.dataset.lineIndex!, row.dataset.altLine!);
  for (const cell of Array.from(root.querySelectorAll<HTMLElement>("[data-unified] [data-column-number]"))) {
    const other = alt.get(cell.dataset.lineIndex!);
    if (other) stamp(cell, "data-alt-line", other);
  }

  // A band says which hunk it comes before when it can expand; otherwise the bands are the hunks' gaps, in order.
  const gaps = fileDiff.hunks.filter((hunk) => hunk.collapsedBefore > 0);
  for (const column of Array.from(root.querySelectorAll("[data-gutter], [data-content]"))) {
    column.querySelectorAll<HTMLElement>("[data-separator-content]").forEach((label, order) => {
      const expandIndex = label.closest<HTMLElement>("[data-separator]")?.dataset.expandIndex;
      const hunk = expandIndex !== undefined ? fileDiff.hunks[Number(expandIndex)] : gaps[order];
      const context = hunk?.hunkContext?.trim();
      if (context) stamp(label, "data-hunk-context", context);
    });
  }

  const folded = new Set<number>();
  const unified = !!root.querySelector("[data-unified]");
  const own = unified ? "[data-unified]" : "[data-deletions]";
  // Each run's rows and their cells, from one pass over the file's deleted lines.
  const rowsOf = runs.map((): Element[] => []);
  if (runs.length) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`${own} [data-line-type="change-deletion"]:is([data-line], [data-column-number])`))) {
      const at = runAt(runs, Number(el.dataset.line ?? el.dataset.columnNumber));
      if (at >= 0) rowsOf[at].push(el);
    }
  }
  runs.forEach((run, index) => {
    const i = String(index);
    const rows = rowsOf[index];
    const anchor = root.querySelector(`${own} [data-content] > [data-line-type="change-deletion"][data-line="${run.anchor}"]`);
    const foldRow = anchor?.nextElementSibling?.matches("[data-line-annotation]") ? anchor.nextElementSibling : null;
    // The fold row shares its row with a comment on the run's last line shown: that row stays the comment's.
    const shared = (foldRow?.querySelectorAll(":scope > [data-annotation-content] > slot").length ?? 0) > 1;
    const rowsOfFold = foldRow ? withTwin(foldRow) : null;
    let ok = rows.length === run.count * 2 && !!rowsOfFold;
    const hidden = [...rows];
    if (ok && unified) {
      // A comment or a missing newline under a folded line folds with it.
      for (const row of rows) {
        let next = row.parentElement?.matches("[data-content]") ? row.nextElementSibling : null;
        while (ok && next?.matches("[data-line-annotation], [data-no-newline]")) {
          const both = withTwin(next);
          if (both) hidden.push(...both);
          else ok = false;
          next = next.nextElementSibling;
        }
      }
    } else if (ok) {
      // The other side beside the fold row, then the empty side beside the folded lines: one block of exactly as many.
      const otherRow = root.querySelector(`[data-additions] [data-line-annotation="${foldRow!.getAttribute("data-line-annotation")}"]`);
      const buffer = otherRow?.nextElementSibling;
      const others = otherRow && withTwin(otherRow);
      const empties = buffer?.matches("[data-content-buffer]") && Number(buffer.getAttribute("data-buffer-size")) === run.count ? withTwin(buffer) : null;
      ok = !!others && !!empties;
      if (ok) {
        rowsOfFold!.push(...others!);
        hidden.push(...empties!);
      }
    }
    if (ok) {
      for (const el of hidden) stamp(el, "data-gr-fold", i);
      for (const el of rowsOfFold!) {
        stamp(el, shared ? "data-gr-fold-shared" : "data-gr-fold-row", i);
        el.removeAttribute(shared ? "data-gr-fold-row" : "data-gr-fold-shared");
      }
      folded.add(index);
    } else {
      for (const el of Array.from(root.querySelectorAll(`[data-gr-fold="${i}"], [data-gr-fold-row="${i}"], [data-gr-fold-shared="${i}"]`))) {
        el.removeAttribute("data-gr-fold");
        el.removeAttribute("data-gr-fold-row");
        el.removeAttribute("data-gr-fold-shared");
      }
    }
  });
  applyOpen(host, open);
  return folded;
}

/** Shows the open runs' folded rows and hides the rest, as they're stamped: no redraw, so nothing loses the focus. */
export function applyOpen(host: Element, open: ReadonlySet<number>) {
  for (const el of Array.from(host.shadowRoot?.querySelectorAll<HTMLElement>("[data-gr-fold]") ?? [])) {
    const shown = open.has(Number(el.dataset.grFold));
    if (shown !== el.hasAttribute("data-gr-fold-open")) el.toggleAttribute("data-gr-fold-open", shown);
  }
}
