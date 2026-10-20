import { diffWordsWithSpace, type ChangeObject } from "diff";
import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * Word emphasis that is noise: pierre highlights the words that changed between a deleted line and the added line
 * paired with it, which for two lines that share almost nothing marks nearly every word, confetti that says less than
 * the row's own color. A pair whose words kept under `threshold` of their text (not counting spaces) loses that
 * emphasis; its rows and signs stay. Lines over 1,000 characters are left to pierre, which skips them too.
 */
export const CONFETTI_THRESHOLD = 0.4;
const LONGEST_LINE = 1000;

/** One deleted line and the added line paired with it, by their old and new numbers, and how much of them stayed. */
export interface ConfettiRow { old: number; new: number; similarity: number; noisy: boolean }

type Span = [changed: 0 | 1, text: string];

// Pierre's own joining of a line's word spans (@pierre/diffs utils/parseDiffDecorations.ts, Apache-2.0), copied so the
// similarity counts the spans pierre paints: a single neutral character between changed words joins them.
function pushOrJoinSpan({ item, arr, enableJoin, isNeutral = false, isLastItem = false }: { item: ChangeObject<string>; arr: Span[]; enableJoin: boolean; isNeutral?: boolean; isLastItem?: boolean }) {
  const lastItem = arr[arr.length - 1];
  if (lastItem == null || isLastItem || !enableJoin) {
    arr.push([isNeutral ? 0 : 1, item.value]);
    return;
  }
  const isLastItemNeutral = lastItem[0] === 0;
  if (isNeutral === isLastItemNeutral || (isNeutral && item.value.length === 1 && !isLastItemNeutral)) {
    lastItem[1] += item.value;
    return;
  }
  arr.push([isNeutral ? 0 : 1, item.value]);
}

const solid = (text: string) => text.replace(/\s/g, "").length;

/** Each pair of a deleted and an added line in the file's change blocks, and whether its word emphasis is noise. */
export function confettiRows(fileDiff: FileDiffMetadata, threshold = CONFETTI_THRESHOLD): ConfettiRow[] {
  const rows: ConfettiRow[] = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        oldLine += part.lines;
        newLine += part.lines;
        continue;
      }
      const pairs = Math.min(part.deletions, part.additions);
      for (let i = 0; i < pairs; i++) {
        const del = fileDiff.deletionLines[part.deletionLineIndex + i]?.replace(/\r?\n$/, "") ?? "";
        const add = fileDiff.additionLines[part.additionLineIndex + i]?.replace(/\r?\n$/, "") ?? "";
        if (del.length > LONGEST_LINE || add.length > LONGEST_LINE) continue;
        const delSpans: Span[] = [];
        const addSpans: Span[] = [];
        const items = diffWordsWithSpace(del, add);
        const last = items.at(-1);
        for (const item of items) {
          const isLastItem = item === last;
          if (!item.added && !item.removed) {
            pushOrJoinSpan({ item, arr: delSpans, enableJoin: true, isNeutral: true, isLastItem });
            pushOrJoinSpan({ item, arr: addSpans, enableJoin: true, isNeutral: true, isLastItem });
          } else pushOrJoinSpan({ item, arr: item.removed ? delSpans : addSpans, enableJoin: true, isLastItem });
        }
        const kept = (spans: Span[]) => spans.reduce((n, [changed, text]) => n + (changed ? 0 : solid(text)), 0);
        const total = solid(del) + solid(add);
        const similarity = total ? (kept(delSpans) + kept(addSpans)) / total : 1;
        rows.push({ old: oldLine + i, new: newLine + i, similarity, noisy: similarity < threshold });
      }
      oldLine += part.deletions;
      newLine += part.additions;
    }
  }
  return rows;
}

/** Styles that take the word emphasis off the noisy pairs' rows. */
export function confettiCSS(rows: ConfettiRow[]): string {
  const selectors = rows.filter((row) => row.noisy).flatMap((row) => [
    `[data-line-type="change-deletion"][data-line="${row.old}"] [data-diff-span]`,
    `[data-line-type="change-addition"][data-line="${row.new}"] [data-diff-span]`,
  ]);
  return selectors.length ? `${selectors.join(",\n")} { background-color: transparent; }\n` : "";
}
