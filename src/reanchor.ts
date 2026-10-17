import { diffPositions, type FilePositions } from "./review-positions";

export interface AnchoredComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** The line's text when the comment was drafted, without the diff prefix; absent for older comments. */
  code?: string;
}

export type Reanchored = { status: "same" } | { status: "moved"; line: number } | { status: "lost" };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function sideLines(positions: Map<string, FilePositions>, file: string, side: "LEFT" | "RIGHT"): Map<number, string> | undefined {
  const p = positions.get(file);
  return p && (side === "RIGHT" ? p.right : p.left);
}

/** The text of a line in a diff: RIGHT for added/context lines by new-file number, LEFT for deleted/context by old-file number. */
export function lineText(patch: string, file: string, line: number, side: "LEFT" | "RIGHT"): string | undefined {
  return sideLines(diffPositions(patch), file, side)?.get(line);
}

/** Where a draft comment's line is in the current diff: same number, the nearest line with the same code, or lost. */
export function reanchor(comment: AnchoredComment, previousPatch: string, currentPatch: string): Reanchored {
  return reanchorIn(comment, diffPositions(previousPatch), diffPositions(currentPatch));
}

/** reanchor, given both diffs' positions, for placing many comments with one parse of each diff. */
export function reanchorIn(comment: AnchoredComment, previous: Map<string, FilePositions>, current: Map<string, FilePositions>): Reanchored {
  const before = sideLines(previous, comment.file, comment.side);
  const code = comment.code ?? before?.get(comment.line);
  if (code === undefined) return { status: "lost" };
  const lines = sideLines(current, comment.file, comment.side);
  if (!lines) return { status: "lost" };
  const n = comment.line;
  // A line whose code is common, such as `}` or a blank, is the same one only where the lines around it are too.
  const sameAround = before !== undefined && (before.has(n - 1) || before.has(n + 1))
    && before.get(n - 1) === lines.get(n - 1) && before.get(n + 1) === lines.get(n + 1);
  if (lines.get(n) === code && sameAround) return { status: "same" };
  // The exact code, indentation included; re-indented code only when that's nowhere.
  let matches = [...lines].filter(([, text]) => text === code);
  if (!matches.length) {
    const want = normalize(code);
    matches = [...lines].filter(([, text]) => normalize(text) === want);
  }
  if (!matches.length) return { status: "lost" };
  const distances = matches.map(([line]) => ({ line, d: Math.abs(line - n) }));
  const best = distances.reduce((min, c) => Math.min(min, c.d), Infinity);
  const nearest = distances.filter((c) => c.d === best);
  if (nearest.length > 1) return { status: "lost" };
  if (nearest[0].line !== n) return { status: "moved", line: nearest[0].line };
  return matches.length === 1 ? { status: "same" } : { status: "lost" };
}
