import type { CommentLocation } from "../src/draft";
import { chapterAt } from "../src/hunks";

/** The workspace's single-key shortcuts, as the help sheet lists them. */
export const SHORTCUTS = [
  { keys: ["j", "k"], label: "Next or previous file" },
  { keys: ["n", "p"], label: "Next or previous chapter" },
  { keys: ["v"], label: "Mark the file viewed, or not, and go to the next" },
  { keys: ["u"], label: "Next unviewed file, in any chapter" },
  { keys: ["]", "["], label: "Next or previous comment or discussion" },
  { keys: ["/"], label: "Find in review" },
  { keys: ["f"], label: "All files, with the cursor in their filter" },
  { keys: ["a"], label: "Ask agent" },
  { keys: ["s"], label: "Submit review" },
  { keys: ["?"], label: "Show these shortcuts" },
] as const;

const KEYS = new Set<string>(SHORTCUTS.flatMap((shortcut) => shortcut.keys));
const TEXT_INPUT = "input" + ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].map((type) => `:not([type=${type}])`).join("");

/** The shortcut a key press asks for: none while typing, or with Ctrl, Meta, or Alt held. */
export function shortcutKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !KEYS.has(event.key)) return null;
  // The element typed in, even inside a shadow root. A checkbox or button keeps focus after a click, but takes no typing.
  const target = event.composedPath()[0];
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(`${TEXT_INPUT}, textarea, select, [role=textbox], [role=dialog], [role=alertdialog]`))) return null;
  return event.key;
}

type Chapter = { id: string; diffs: Array<{ file: string; hunks?: number[] }> };

/** Each chapter's files in the order the guide reads them; a file split across chapters is in each. */
export function readingOrder(sections: Chapter[]): Array<{ chapter: string; file: string }> {
  return sections.flatMap((section) => section.diffs.map((diff) => ({ chapter: section.id, file: diff.file })));
}

/** Lines in the order the guide reads them, each with its place in readingOrder: by the chapter showing it, by file within it, then by line. */
export function inDiffOrder(locations: CommentLocation[], sections: Chapter[], patch: string): Array<{ at: CommentLocation; place: number }> {
  const order = readingOrder(sections);
  return locations
    .map((at) => {
      const chapter = chapterAt(sections, patch, at)?.id;
      return { at, place: order.findIndex((entry) => entry.chapter === chapter && entry.file === at.file) };
    })
    .filter((line) => line.place >= 0)
    .sort((a, b) => a.place - b.place || a.at.line - b.at.line || a.at.side.localeCompare(b.at.side));
}
