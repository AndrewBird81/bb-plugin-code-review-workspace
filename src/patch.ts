/** A file's diff, keyed by its path after the change; `oldPath` is the name before a rename. */
export interface PatchFile { readonly path: string; readonly oldPath?: string; readonly text: string }

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
    // A blank context line written as "" (diff.suppressBlankEmpty, or a lost trailing space) is still counted.
    if (inHunk && text === "" && oldLeft > 0 && newLeft > 0) {
      rows.push({ kind: " ", text, oldLine: oldLine++, newLine: newLine++ });
      oldLeft--;
      newLeft--;
      continue;
    }
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

/** The last split, since a review's views each split the same patch. */
let lastSplit: { patch: string; files: readonly PatchFile[] } | undefined;

/**
 * A patch's files, frozen so that callers can share one split. A split of one file's diff, as a caller that already
 * split the patch passes, doesn't push out the last split of a whole patch.
 */
export function splitPatchByFile(patch: string): readonly PatchFile[] {
  if (lastSplit?.patch === patch) return lastSplit.files;
  const normalized = ensureGitHeaders(patch);
  const chunks = normalized.split(/\n(?=diff --git )/g).filter((c) => c.startsWith("diff --git "));
  const files = Object.freeze(chunks.map((text) => Object.freeze({ ...fileNames(text), text: text.endsWith("\n") ? text : text + "\n" })));
  if (files.length > 1 || !lastSplit || lastSplit.files.length <= 1) lastSplit = { patch, files };
  return files;
}

/**
 * What a file's diff does besides changing lines, for a file the guide left unplaced or a file with no hunks to show.
 * The no-diff line is pr-snapshot's NO_DIFF, spelled out: this module runs in the browser too, and that one doesn't.
 */
export function unplacedSummary(file: PatchFile | undefined): string {
  if (!file) return "Nothing to review in the diff.";
  const rows = patchRows(file.text);
  const header = (prefix: string) => rows.find((row) => row.kind === "header" && row.text.startsWith(prefix))?.text.slice(prefix.length).trim();
  const [oldMode, newMode] = [header("old mode "), header("new mode ")];
  const parts = [
    file.oldPath && `Renamed from \`${file.oldPath}\`.`,
    rows.some((row) => /^Binary files |^GIT binary patch/.test(row.text)) && "Binary file.",
    oldMode && newMode && (newMode === "100755" ? "Made executable." : oldMode === "100755" ? "No longer executable." : `Mode changed from ${oldMode} to ${newMode}.`),
    rows.some((row) => row.text.startsWith("GitHub didn't send this file's diff")) && "GitHub didn't send this file's diff; read it on GitHub.",
  ].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return header("new file mode") ? "New empty file." : header("deleted file mode") ? "Deleted empty file." : "No content changes.";
}

/**
 * A changed file's path as text for the agents shows it: quoted when it holds a control character or a Unicode line or
 * paragraph separator, as a PR names its files and a line break in one would start a line that reads as the plugin's
 * own. JSON leaves DEL, the C1 controls and the separators as they are, so the quotes escape them too.
 */
export const shownPath = (path: string) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)
  ? JSON.stringify(path).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
  : path;

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Git C-quotes names with `"`, `\`, control or (by default) non-ASCII characters, writing their bytes in octal. */
export function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  const bytes: number[] = [];
  for (let i = 1; i < name.length && name[i] !== '"'; i++) {
    if (name[i] !== "\\") {
      // By code point: half of a surrogate pair would encode as U+FFFD.
      const char = String.fromCodePoint(name.codePointAt(i)!);
      bytes.push(...new TextEncoder().encode(char));
      i += char.length - 1;
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

// A C-quoted name that runs to the end of the line, from where it's tried.
const QUOTED_TO_END = /"(?:[^"\\]|\\.)*"$/y;

/**
 * The names in `diff --git a/X b/Y`, quote-aware. Git quotes only the name that needs it, so the other, unquoted, may
 * hold spaces. Unquoted, X and Y may hold " b/", so an unrenamed file's halves must match.
 */
function headerNames(line: string): { a: string; b: string } | null {
  const rest = line.slice("diff --git ".length).replace(/\r$/, "");
  let quoted: [string, string] | null = null;
  const first = rest.match(/^("(?:[^"\\]|\\.)*") (.+)$/);
  if (first) quoted = [first[1], first[2]];
  // A quoted Y begins at a space and a quote; only one such place can quote the rest of the line.
  else for (let at = rest.indexOf(' "'); at >= 0 && !quoted; at = rest.indexOf(' "', at + 1)) {
    QUOTED_TO_END.lastIndex = at + 1;
    if (QUOTED_TO_END.test(rest)) quoted = [rest.slice(0, at), rest.slice(at + 1)];
  }
  if (quoted) {
    const [a, b] = [unquote(quoted[0]), unquote(quoted[1])];
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
  let renameFrom: string | undefined, renameTo: string | undefined, copyTo: string | undefined;
  let minus: string | null | undefined, plus: string | null | undefined;
  // Only the header: the hunks can be most of the text.
  const end = text.indexOf("\n@@");
  for (const { kind, text: line } of patchRows(end < 0 ? text : text.slice(0, end))) {
    if (kind === "hunk") break;
    if (line.startsWith("diff --git ")) header = headerNames(line);
    else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12).replace(/\r$/, ""));
    else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10).replace(/\r$/, ""));
    else if (line.startsWith("copy to ")) copyTo = unquote(line.slice(8).replace(/\r$/, ""));
    else if (line.startsWith("--- ")) minus = markerName(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) plus = markerName(line.slice(4), "b/");
  }
  // A pure copy has no ---/+++ lines; its copy to names it, as rename to names a pure rename.
  const path = plus ?? renameTo ?? copyTo ?? (plus === null ? minus : undefined) ?? header?.b ?? "";
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
