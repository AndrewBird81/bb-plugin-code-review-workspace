// What the agents read of a review's diff: a list of its files, and pages of it.
import { patchRows, splitPatchByFile, type PatchFile } from "./patch";
import { classifyFile, isChosenPath } from "./classify";
import { FILES_CAPPED_NOTE } from "./pr-snapshot";
import { testWeakening, weakeningMark } from "../lib/test-weakening";
import { digestText, lockfileDigest } from "../lib/lockfile-digest";

/** Settings' marks on a file: a test the diff weakens (Flag weakened tests), and a lockfile's digest (Summarize lockfile changes). */
export interface FileMarks { testWeakening?: boolean; lockfileDigest?: boolean }

/**
 * list_review_files: one line per changed file, so an agent can plan what to read. `generated`: the files the repo's
 * .gitattributes marks generated; `marks`: what Settings adds.
 */
export function describeReviewFiles(patch: string, generated: string[] = [], marks: FileMarks = {}): string {
  const files = splitPatchByFile(patch);
  const rows = files.map((file) => {
    const { path, oldPath, text } = file;
    const chosen = isChosenPath(file);
    const status = oldPath ? `renamed from ${oldPath}`
      : /^new file mode /m.test(text) ? "added" : /^deleted file mode /m.test(text) ? "deleted" : "modified";
    const lines = patchRows(text);
    const added = lines.filter((row) => row.kind === "+").length;
    const removed = lines.filter((row) => row.kind === "-").length;
    // readFilesPatch's note, outside the hunks, where a changed line can't fake it.
    const unsent = lines.some((row) => row.kind !== "+" && row.kind !== "-" && row.kind !== " " && row.text.startsWith("GitHub didn't send this file's diff"));
    const weakened = marks.testWeakening ? testWeakening(path, text, generated.includes(path), chosen) : null;
    const digest = marks.lockfileDigest ? lockfileDigest(path, text) : null;
    return `${path} · ${status} · +${added} −${removed} · ${text.length} chars · ${classifyFile(path, generated.includes(path), chosen).category}${unsent ? " · diff unavailable: read it on GitHub" : ""}${weakened ? ` · ${weakeningMark(weakened)}` : ""}${digest ? ` · ${digestText(digest)}` : ""}`;
  });
  const capped = patch.startsWith(FILES_CAPPED_NOTE) ? [FILES_CAPPED_NOTE] : [];
  return [...capped, `${files.length} file${files.length === 1 ? "" : "s"} (path · status · lines added and removed · diff size · kind):`, ...rows].join("\n");
}

/**
 * The diff as read_review_patch pages it: each lockfile's and generated or vendored file's hunks as one line, since they
 * rarely need reading and can fill pages. A file at a path the change chose is paged in full, whatever its path.
 * `generated`: the files the repo's .gitattributes marks generated. A lockfile's stub names the hosts its added lines
 * download from that aren't a known registry, whatever Settings says; with `marks.lockfileDigest`, also the packages
 * it adds and removes.
 */
export function stubSkippedFiles(patch: string, generated: string[] = [], marks: FileMarks = {}): string {
  const files = splitPatchByFile(patch);
  const skipped = (file: PatchFile) => { const kind = classifyFile(file.path, generated.includes(file.path), isChosenPath(file)).category; return kind === "lockfile" || kind === "generated" ? kind : null; };
  if (!files.some(skipped)) return patch;
  // What comes before the first file, such as readFilesPatch's note, stays.
  const first = patch.startsWith("diff --git ") ? 0 : patch.indexOf("\ndiff --git ") + 1;
  return patch.slice(0, first) + files.map((file) => {
    const { path, text } = file;
    const kind = skipped(file);
    const hunks = text.search(/^@@ /m);
    if (!kind || hunks < 0) return text;
    const rows = patchRows(text);
    const count = (sign: "+" | "-") => rows.filter((row) => row.kind === sign).length;
    const digest = kind === "lockfile" ? lockfileDigest(path, text) : null;
    // A host swap hides in a lockfile's stub, so its hosts are named even with the digest off.
    const said = digest && digestText(marks.lockfileDigest ? digest : { added: 0, removed: 0, hosts: digest.hosts });
    return `${text.slice(0, hunks)}[${kind}: +${count("+")} −${count("-")} lines${said ? `; ${said}` : ""}; pass file to read it]\n`;
  }).join("");
}

/** A page of the diff from offset, cut back to the last file boundary that fits, so no file is split across pages unless it alone is longer than a page. */
export function patchPage(patch: string, offset: number, limit: number): { text: string; end: number } {
  let end = Math.min(patch.length, offset + limit);
  if (end < patch.length) {
    const boundary = patch.lastIndexOf("\ndiff --git ", end - 1);
    if (boundary > offset) end = boundary + 1;
  }
  return { text: patch.slice(offset, end), end };
}
