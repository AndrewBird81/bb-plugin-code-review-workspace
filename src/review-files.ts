// What the agents read of a review's diff: a list of its files, and pages of it.
import { splitPatchByFile } from "./patch";
import { classifyFile } from "./classify";

/** list_review_files: one line per changed file, so an agent can plan what to read. */
export function describeReviewFiles(patch: string): string {
  const files = splitPatchByFile(patch);
  const rows = files.map(({ path, text }) => {
    const from = text.match(/^rename from (.+)$/m)?.[1];
    const to = text.match(/^rename to (.+)$/m)?.[1];
    const status = from && to ? (path === from ? `renamed to ${to}` : `renamed from ${from}`)
      : /^new file mode /m.test(text) ? "added" : /^deleted file mode /m.test(text) ? "deleted" : "modified";
    const hunks = text.slice(Math.max(0, text.indexOf("\n@@")));
    const added = hunks.match(/^\+(?!\+\+ )/gm)?.length ?? 0;
    const removed = hunks.match(/^-(?!-- )/gm)?.length ?? 0;
    return `${path} · ${status} · +${added} −${removed} · ${text.length} chars · ${classifyFile(path).category}`;
  });
  return [`${files.length} file${files.length === 1 ? "" : "s"} (path · status · lines added and removed · diff size · kind):`, ...rows].join("\n");
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
