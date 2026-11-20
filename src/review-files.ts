// What the agents read of a review's diff: a list of its files, and pages of it.
import { patchRows, shownPath, splitPatchByFile, unquote, type PatchFile } from "./patch";
import { classifyFile, isChosenPath } from "./classify";
import { FILES_CAPPED_NOTE } from "./pr-snapshot";
import { testWeakening, weakeningMark } from "../lib/test-weakening";
import { digestText, lockfileDigest } from "../lib/lockfile-digest";

/** Settings' marks on a file: a test the diff weakens (Flag weakened tests), and a lockfile's digest (Summarize lockfile changes). */
export interface FileMarks { testWeakening?: boolean; lockfileDigest?: boolean }

/**
 * The most UTF-8 bytes of diff one read_review_patch call returns. Claude Code saves an MCP tool's result to a file, for
 * the agent to read back with its own tools, once it counts more than 25,000 tokens (MAX_MCP_OUTPUT_TOKENS), and it
 * counts none at 50,000 characters or fewer. A diff runs about 2.7 characters a token, so 40 KB is some 15,000 tokens:
 * under that limit with room for the page's note, for any provider.
 */
export const PATCH_PAGE_BYTES = 40_000;

/** The most of list_review_files one call returns, cut at a row: within read_review_patch's pages. */
export const FILES_PAGE_CHARS = 40_000;

/**
 * list_review_files: one line per changed file, so an agent can plan what to read, in pages of rows from file `offset`
 * up to FILES_PAGE_CHARS, or `limit` files. `generated`: the files the repo's .gitattributes marks generated; `marks`:
 * what Settings adds.
 */
export function describeReviewFiles(patch: string, generated: string[] = [], marks: FileMarks = {}, page: { offset?: number; limit?: number } = {}): string {
  const files = splitPatchByFile(patch);
  const row = (file: PatchFile) => {
    const { path, oldPath, text } = file;
    const chosen = isChosenPath(file);
    // Read from the header only: a changed line can't fake it.
    const hunks = text.search(/^@@ /m);
    const copied = (hunks < 0 ? text : text.slice(0, hunks)).match(/^copy from (.+?)\r?$/m);
    const status = oldPath ? `renamed from ${shownPath(oldPath)}` : copied ? `copied from ${shownPath(unquote(copied[1]))}`
      : /^new file mode /m.test(text) ? "added" : /^deleted file mode /m.test(text) ? "deleted" : "modified";
    const lines = patchRows(text);
    const added = lines.filter((row) => row.kind === "+").length;
    const removed = lines.filter((row) => row.kind === "-").length;
    // readFilesPatch's note, outside the hunks, where a changed line can't fake it.
    const unsent = lines.some((row) => row.kind !== "+" && row.kind !== "-" && row.kind !== " " && row.text.startsWith("GitHub didn't send this file's diff"));
    const weakened = marks.testWeakening ? testWeakening(path, text, generated.includes(path), chosen) : null;
    const digest = marks.lockfileDigest ? lockfileDigest(path, text) : null;
    return `${shownPath(path)} · ${status} · +${added} −${removed} · ${text.length} chars · ${classifyFile(path, generated.includes(path), chosen).category}${unsent ? " · diff unavailable: read it on GitHub" : ""}${weakened ? ` · ${weakeningMark(weakened)}` : ""}${digest ? ` · ${digestText(digest)}` : ""}`;
  };
  const offset = page.offset ?? 0;
  const rows: string[] = [];
  let size = 0;
  for (let i = offset; i < files.length && rows.length < (page.limit ?? Infinity); i++) {
    const text = row(files[i]);
    // A page holds at least one row, however long.
    if (rows.length && size + text.length + 1 > FILES_PAGE_CHARS) break;
    rows.push(text);
    size += text.length + 1;
  }
  const end = offset + rows.length;
  const more = end < files.length ? [`[Files ${offset + 1}–${end} of ${files.length} — call again with offset=${end}]`] : [];
  const capped = patch.startsWith(FILES_CAPPED_NOTE) ? [FILES_CAPPED_NOTE] : [];
  return [...capped, `${files.length} file${files.length === 1 ? "" : "s"} (path · status · lines added and removed · diff size · kind):`, ...rows, ...more].join("\n");
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

/** Why a read of `what` from `offset` returns nothing; null when it returns something, or `what` is empty. */
export function offsetPastEnd(what: string, offset: number, length: number): string | null {
  return offset > 0 && offset >= length ? `offset ${offset} is past the end of ${what} (${length} bytes).` : null;
}

/**
 * A page of the diff from offset, up to `limit` UTF-8 bytes, cut back to the last file boundary that fits, so no file is
 * split across pages unless it alone is longer than a page; then to the last line that fits, so no line is.
 */
export function patchPage(patch: string, offset: number, limit: number): { text: string; end: number } {
  let end = fitBytes(patch, offset, limit);
  if (end < patch.length) {
    const boundary = patch.lastIndexOf("\ndiff --git ", end - 1);
    const line = patch.lastIndexOf("\n", end - 1);
    if (boundary > offset) end = boundary + 1;
    else if (line >= offset) end = line + 1;
  }
  return { text: patch.slice(offset, end), end };
}

/** The end of the longest run of `text` from `offset` that is at most `limit` UTF-8 bytes, without splitting a character. */
export function fitBytes(text: string, offset: number, limit: number): number {
  let bytes = 0;
  let end = offset;
  while (end < text.length) {
    const code = text.codePointAt(end)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > limit) break;
    bytes += size;
    end += code < 0x10000 ? 1 : 2;
  }
  return end;
}

/**
 * The file a page from `offset` starts inside, when it doesn't start at the file's own header: a page that goes on with a
 * long file's diff names it, since its header is on an earlier page.
 */
export function continuedFile(patch: string, offset: number): string | null {
  if (patch.startsWith("diff --git ", offset)) return null;
  const header = patch.lastIndexOf("\ndiff --git ", offset - 1);
  // Before the first file, as in readFilesPatch's note, is no file's.
  const start = header >= 0 ? header + 1 : patch.startsWith("diff --git ") ? 0 : -1;
  if (start < 0) return null;
  const next = patch.indexOf("\ndiff --git ", start);
  return splitPatchByFile(patch.slice(start, next < 0 ? patch.length : next + 1))[0]?.path ?? null;
}
