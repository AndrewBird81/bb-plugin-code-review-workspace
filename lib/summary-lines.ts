// The lines a review summary cites, as `file:line`, each with the comment there, so Finish review can open them and
// say which raise something no comment does.
import type { CommentItem } from "./comments";

export interface SummaryLine {
  /** The changed file it names, its whole path. */
  file: string;
  line: number;
  /** As the summary names it: "playlist.go:192", or "a.ts:10–15". */
  cited: string;
  /** A draft comment or GitHub thread on those lines; null when none is. */
  item: CommentItem | null;
}

// A path with an extension, then its line or lines: `src/a.ts:12`, `a.ts:10-15`. Not a URL's host and port.
const CITED = /(?<![\w./:-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]+):(\d+)(?:[-–](\d+))?/g;
// Lines either side of a comment's that still count as its: a summary can cite the line before the one it's on.
const NEAR = 2;

/** A cited path as one of the changed files: the same path, or the only one it ends. */
function changedFile(path: string, files: readonly string[]): string | null {
  if (files.includes(path)) return path;
  const ending = files.filter((file) => file.endsWith(`/${path}`));
  return ending.length === 1 ? ending[0] : null;
}

function commentOn(file: string, from: number, to: number, items: readonly CommentItem[]): CommentItem | null {
  return items.find((item) => {
    if ((item.kind !== "draft" && item.kind !== "thread") || item.at?.file !== file || item.at.line === null) return false;
    const start = item.kind === "draft" ? item.comment.startLine ?? item.at.line : item.at.line;
    return from <= item.at.line + NEAR && to >= start - NEAR;
  }) ?? null;
}

/**
 * Each changed file's line the summary cites, once, in its order, with the comment on it. Move to summary's lines, on
 * an earlier diff, aren't in this one, so they're left out.
 */
export function summaryLines(body: string, files: readonly string[], items: readonly CommentItem[]): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const match of body.matchAll(CITED)) {
    if (body.startsWith("` (an earlier diff", match.index + match[0].length)) continue;
    const file = changedFile(match[1], files);
    if (!file) continue;
    const line = Number(match[2]);
    const to = match[3] ? Math.max(line, Number(match[3])) : line;
    if (lines.some((l) => l.file === file && l.line === line)) continue;
    lines.push({ file, line, cited: `${match[1]}:${match[2]}${match[3] ? `–${match[3]}` : ""}`, item: commentOn(file, line, to, items) });
  }
  return lines;
}
