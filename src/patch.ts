/** A file's diff, keyed by its path after the change; `oldPath` is the name before a rename. */
export interface PatchFile { path: string; oldPath?: string; text: string }

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
    return { ...fileNames(text), text: text.endsWith("\n") ? text : text + "\n" };
  });
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Git C-quotes names with `"`, `\`, control or (by default) non-ASCII characters, writing their bytes in octal. */
function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  const bytes: number[] = [];
  for (let i = 1; i < name.length && name[i] !== '"'; i++) {
    if (name[i] !== "\\") {
      bytes.push(...new TextEncoder().encode(name[i]));
      continue;
    }
    const next = name[++i];
    const octal = name.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A `---`/`+++` name: null for /dev/null. Git ends an unquoted name that has a space with a tab. */
function markerName(rest: string, prefix: "a/" | "b/"): string | null {
  const raw = rest.replace(/\r$/, "");
  const name = raw.startsWith('"') ? unquote(raw) : raw.split("\t")[0];
  if (name === "/dev/null") return null;
  return name.startsWith(prefix) ? name.slice(2) : name;
}

/** The names in `diff --git a/X b/Y`, quote-aware. Unquoted, X and Y may hold " b/", so an unrenamed file's halves must match. */
function headerNames(line: string): { a: string; b: string } | null {
  const rest = line.slice("diff --git ".length).replace(/\r$/, "");
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/);
  if (quoted && (quoted[1].startsWith('"') || quoted[2].startsWith('"'))) {
    const [a, b] = [unquote(quoted[1]), unquote(quoted[2])];
    return a.startsWith("a/") && b.startsWith("b/") ? { a: a.slice(2), b: b.slice(2) } : null;
  }
  const half = (rest.length - 1) / 2;
  if (rest.startsWith("a/") && rest[half] === " " && rest.slice(half + 1) === "b/" + rest.slice(2, half)) {
    return { a: rest.slice(2, half), b: rest.slice(2, half) };
  }
  const m = rest.match(/^a\/(.+?) b\/(.+)$/);
  return m ? { a: m[1], b: m[2] } : null;
}

/** A file is keyed by its new path; a deleted one by its old path. */
function fileNames(text: string): { path: string; oldPath?: string } {
  let header: { a: string; b: string } | null = null;
  let renameFrom: string | undefined, renameTo: string | undefined;
  let minus: string | null | undefined, plus: string | null | undefined;
  for (const { kind, text: line } of patchRows(text)) {
    if (kind === "hunk") break;
    if (line.startsWith("diff --git ")) header = headerNames(line);
    else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12).replace(/\r$/, ""));
    else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10).replace(/\r$/, ""));
    else if (line.startsWith("--- ")) minus = markerName(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) plus = markerName(line.slice(4), "b/");
  }
  const path = plus ?? renameTo ?? (plus === null ? minus : undefined) ?? header?.b ?? "";
  return renameFrom === undefined ? { path } : { path, oldPath: renameFrom };
}

/** Old path → new path for every renamed file in a patch whose old path isn't a file in it too. */
export function renamedPaths(patch: string): Map<string, string> {
  if (!/^rename from /m.test(patch)) return new Map();
  const files = splitPatchByFile(patch);
  const paths = new Set(files.map((f) => f.path));
  return new Map(files.flatMap((f) => (f.oldPath && !paths.has(f.oldPath) ? [[f.oldPath, f.path] as const] : [])));
}

export function changedFiles(patch: string): string[] {
  return splitPatchByFile(patch).map((f) => f.path).filter(Boolean);
}
