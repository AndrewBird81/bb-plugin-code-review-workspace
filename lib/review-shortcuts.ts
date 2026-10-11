import type { CommentLocation } from "../src/draft";
import { chapterAt } from "../src/hunks";

/** The workspace's single-key shortcuts, as the help sheet lists them, by what they're for. */
export const SHORTCUTS = [
  { group: "Move", keys: ["j", "k"], label: "Next or previous file" },
  { group: "Move", keys: ["n", "p"], label: "Next or previous chapter" },
  { group: "Move", keys: ["u"], label: "Next unviewed file, in any chapter" },
  { group: "Move", keys: ["]", "["], label: "Next or previous comment or discussion" },
  { group: "Move", keys: ["/"], label: "Find in review" },
  { group: "Move", keys: ["f"], label: "All files, with the cursor in their filter" },
  { group: "Mark", keys: ["v"], label: "Mark the file viewed, or not, and go to the next" },
  { group: "Mark", keys: ["V"], label: "Mark the chapter viewed" },
  { group: "Panels", keys: ["t"], label: "Show or hide the chapters" },
  { group: "Panels", keys: ["c"], label: "Show or hide Comments" },
  { group: "Panels", keys: ["a"], label: "Ask agent" },
  { group: "Panels", keys: ["s"], label: "Finish review" },
  { group: "Panels", keys: ["Escape"], label: "Close what's over the code, or leave full screen" },
  { group: "View", keys: ["i"], label: "Fold or unfold comments in code" },
  { group: "View", keys: ["F"], label: "Full screen on or off" },
  { group: "View", keys: ["?"], label: "Show these shortcuts" },
] as const;

/** How the help sheet writes the keys that aren't what they type. */
export const KEY_LABEL: Partial<Record<string, string>> = { V: "⇧V", F: "⇧F", Escape: "Esc" };

const KEYS = new Set<string>(SHORTCUTS.flatMap((shortcut) => shortcut.keys));
const TEXT_INPUT = "input" + ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].map((type) => `:not([type=${type}])`).join("");
/** The boxes you type in, which a phone's keyboard comes up for. */
export const TEXT_FIELD = `${TEXT_INPUT}, textarea, [role=textbox]`;

/** The shortcut a key press asks for: none while typing, or with Ctrl, Meta, or Alt held. */
export function shortcutKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !KEYS.has(event.key)) return null;
  // The element typed in, even inside a shadow root. A checkbox or button keeps focus after a click, but takes no typing.
  const target = event.composedPath()[0];
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(`${TEXT_FIELD}, select, [role=dialog], [role=alertdialog]`))) return null;
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
