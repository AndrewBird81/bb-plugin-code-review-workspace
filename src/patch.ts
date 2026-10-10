export interface PatchFile { path: string; text: string }

/** A line of a diff: a file header, a hunk header, a hunk line with its old- and new-file numbers, or a "\ No newline" or blank line. */
export type PatchRow =
  | { kind: "header" | "hunk" | "other"; text: string }
  | { kind: "+" | "-" | " "; text: string; oldLine: number; newLine: number };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Classify a diff's lines. Inside a hunk, its header's counts say how many lines are left, so a
 * removed "-- note" (`--- note`) or an added "++i" (`+++i`) is a hunk line, not a file header.
 */
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const c = text[0];
    const counted = oldLeft > 0 || newLeft > 0;
    // Past the counts (a malformed hunk), go on reading change lines unless they look like the next file's headers.
    if (inHunk && (c === "+" || c === "-" || c === " ") && (counted || !/^(?:--- |\+\+\+ )/.test(text))) {
      rows.push({ kind: c, text, oldLine, newLine });
      if (c !== "+") { oldLine++; oldLeft--; }
      if (c !== "-") { newLine++; newLeft--; }
      continue;
    }
    if (inHunk && (c === "\\" || text === "")) {
      rows.push({ kind: "other", text });
      continue;
    }
    const h = text.match(HUNK);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      inHunk = true;
      rows.push({ kind: "hunk", text });
      continue;
    }
    inHunk = false;
    oldLeft = newLeft = 0;
    rows.push({ kind: "header", text });
  }
  return rows;
}

// Ensure each file block has a "diff --git a/<p> b/<p>" header. Real git/gh
// diffs already have one (with an `index ...` line before `--- a/...`); only
// header-less inputs need synthesis. Track presence per file block, not by the
// single previous output line.
export function ensureGitHeaders(patch: string): string {
  const out: string[] = [];
  let hasHeader = false;
  for (const { kind, text: line } of patchRows(patch)) {
    if (kind !== "header") {
      out.push(line);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      hasHeader = true;
      out.push(line);
      continue;
    }
    const minus = line.match(/^--- a\/(.+?)\r?$/); // old-file marker, CRLF-tolerant
    if (minus) {
      if (!hasHeader) out.push(`diff --git a/${minus[1]} b/${minus[1]}`);
      out.push(line);
      hasHeader = false; // next file block starts fresh
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function splitPatchByFile(patch: string): PatchFile[] {
  const normalized = ensureGitHeaders(patch);
  const chunks = normalized.split(/\n(?=diff --git )/g).filter((c) => c.startsWith("diff --git "));
  return chunks.map((text) => {
    const m = text.match(/^diff --git a\/(.+?) b\//);
    return { path: m ? m[1] : "", text: text.endsWith("\n") ? text : text + "\n" };
  });
}

export function changedFiles(patch: string): string[] {
  return splitPatchByFile(patch).map((f) => f.path).filter(Boolean);
}
