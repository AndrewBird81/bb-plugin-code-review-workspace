import { patchRows, splitPatchByFile } from "../src/patch";

interface Section { id: string; title: string; overview: string; diffs: { file: string; summary?: string }[] }

/**
 * The text in lower case without accents, for matching: one character for each of the text's, so a
 * match's place in it is its place in the text.
 */
export function fold(text: string): string {
  return text.replace(/[\u0080-\uffff]/g, (ch) => {
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    return base.length === 1 ? base : ch;
  }).toLowerCase();
}

/** A line of the diff, on the side it reads on: deleted lines on the old side, the rest on the new. */
interface IndexedLine { file: string; line: number; side: "LEFT" | "RIGHT"; text: string; lower: string }
interface IndexedGuide { kind: "chapter" | "summary"; chapterId: string; file?: string; text: string; lower: string }
export interface SearchIndex { lines: IndexedLine[]; guide: IndexedGuide[] }

export type SearchHit =
  | { kind: "line"; file: string; line: number; side: "LEFT" | "RIGHT"; text: string; at: number }
  | { kind: "chapter" | "summary"; chapterId: string; file?: string; text: string; at: number };

/** The whole change, ready to search: every line of the patch, in the guide's file order, and the guide's chapters and file summaries. */
export function searchIndex(patch: string, sections: readonly Section[]): SearchIndex {
  const order = new Map(sections.flatMap((section) => section.diffs.map((diff) => diff.file)).map((file, index) => [file, index]));
  const files = splitPatchByFile(patch).sort((a, b) => (order.get(a.path) ?? order.size) - (order.get(b.path) ?? order.size));
  const lines: IndexedLine[] = [];
  for (const file of files) {
    for (const row of patchRows(file.text)) {
      if (row.kind !== "+" && row.kind !== "-" && row.kind !== " ") continue;
      const text = row.text.slice(1);
      if (!text.trim()) continue;
      lines.push({ file: file.path, line: row.kind === "-" ? row.oldLine : row.newLine, side: row.kind === "-" ? "LEFT" : "RIGHT", text, lower: fold(text) });
    }
  }
  const guide: IndexedGuide[] = sections.flatMap((section) => [
    ...[section.title, section.overview].filter(Boolean).map((text) => ({ kind: "chapter" as const, chapterId: section.id, text, lower: fold(text) })),
    ...section.diffs.flatMap((diff) => diff.summary ? [{ kind: "summary" as const, chapterId: section.id, file: diff.file, text: diff.summary, lower: fold(diff.summary) }] : []),
  ]);
  return { lines, guide };
}

/** What the query finds, in any case and with or without accents: the guide's text first, then the diff's lines; at most `limit` hits, and how many there are. */
export function searchReview(index: SearchIndex, query: string, limit = 100): { hits: SearchHit[]; total: number } {
  const needle = fold(query.trim());
  if (!needle) return { hits: [], total: 0 };
  const hits: SearchHit[] = [];
  let total = 0;
  for (const { lower, ...entry } of index.guide) {
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    total++;
    if (hits.length < limit) hits.push({ ...entry, at });
  }
  for (const { lower, file, line, side, text } of index.lines) {
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    total++;
    if (hits.length < limit) hits.push({ kind: "line", file, line, side, text, at });
  }
  return { hits, total };
}
