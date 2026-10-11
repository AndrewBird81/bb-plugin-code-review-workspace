import { patchRows } from "./patch";

/** A changed line, with any "\ No newline" marker that must stay after it. */
interface Changed { kind: "+" | "-"; text: string; marker?: string }

/** Matching a run of changes costs removed × added lines; past this, the run stays as it is. */
const MAX_CELLS = 4e6;

const squeeze = (line: Changed) => line.text.slice(1).replace(/\s+/g, "");
// A line gaining or losing its final newline isn't only a whitespace change.
const matchable = (line: Changed) => line.marker === undefined;

/** A run of changed lines, with each removed line equal to an added one but for whitespace as one unchanged line. */
function hideInRun(run: Changed[]): string[] {
  const lines = (list: Changed[]) => list.flatMap((line) => line.marker === undefined ? [line.text] : [line.text, line.marker]);
  const removed = run.filter((line) => line.kind === "-");
  const added = run.filter((line) => line.kind === "+");
  const n = removed.length, m = added.length;
  if (!n || !m || n * m > MAX_CELLS) return lines(run);
  const r = removed.map((line) => matchable(line) ? squeeze(line) : null);
  const a = added.map((line) => matchable(line) ? squeeze(line) : null);
  const same = (i: number, j: number) => r[i] !== null && r[i] === a[j];
  // dp[i*(m+1)+j] = longest order-preserving match of removed[i..] and added[j..].
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = same(i, j) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  if (!dp[0]) return lines(run);
  // Each match becomes one unchanged line, after the removed and added lines before it: both files' numbering holds.
  const out: string[] = [];
  let i = 0, j = 0, from = 0, to = 0;
  while (i < n && j < m) {
    if (same(i, j) && dp[i * w + j] === dp[(i + 1) * w + j + 1] + 1) {
      out.push(...lines(removed.slice(from, i)), ...lines(added.slice(to, j)), ` ${added[j].text.slice(1)}`);
      from = ++i;
      to = ++j;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  out.push(...lines(removed.slice(from)), ...lines(added.slice(to)));
  return out;
}

/**
 * The diff with changes that are only whitespace shown as unchanged lines, like `git diff -w`: in each
 * run of changed lines, a removed and an added line equal but for whitespace become one unchanged line,
 * showing the new text. Hunk counts stay the same, so every line keeps its numbers.
 */
export function hideWhitespaceChanges(patch: string): string {
  const out: string[] = [];
  let run: Changed[] = [];
  for (const row of patchRows(patch)) {
    if (row.kind === "+" || row.kind === "-") {
      run.push({ kind: row.kind, text: row.text });
      continue;
    }
    if (row.kind === "other" && row.text.startsWith("\\") && run.length && run.at(-1)!.marker === undefined) {
      run.at(-1)!.marker = row.text;
      continue;
    }
    if (run.length) out.push(...hideInRun(run));
    run = [];
    out.push(row.text);
  }
  if (run.length) out.push(...hideInRun(run));
  return out.join("\n");
}
