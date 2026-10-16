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
  { group: "Panels", keys: ["Escape"], label: "Close what's over the code, leave full screen, or clear the lines selected" },
  { group: "View", keys: ["d"], label: "Since your review or All changes, on a re-review" },
  { group: "View", keys: ["i"], label: "Fold or unfold comments in code" },
  { group: "View", keys: ["F"], label: "Full screen on or off" },
  { group: "View", keys: ["?"], label: "Show these shortcuts" },
] as const;

/** The keys of a comment box, which the help sheet lists too: the box handles them itself, whatever the setting. */
export const COMMENT_BOX_KEYS = [
  { keys: ["⌘/Ctrl", "Enter"], label: "Save the comment" },
  { keys: ["Esc"], label: "Leave the box, keeping your text" },
] as const;

/** A control's tooltip, naming its key while single-key shortcuts are on. */
export const keyHint = (label: string, key: string, on: boolean) => on ? `${label} (${key})` : label;

/** How the help sheet writes the keys that aren't what they type. */
export const KEY_LABEL: Partial<Record<string, string>> = { V: "⇧V", F: "⇧F", Escape: "Esc" };

const KEYS = new Set<string>(SHORTCUTS.flatMap((shortcut) => shortcut.keys));
const TEXT_INPUT = "input" + ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].map((type) => `:not([type=${type}])`).join("");
/** The boxes you type in, which a phone's keyboard comes up for. */
export const TEXT_FIELD = `${TEXT_INPUT}, textarea, [role=textbox]`;

/** Keys that some layouts type with Alt (a Mac's Option) or AltGr, which a browser reports as Ctrl and Alt. */
const ALT_TYPED = new Set(["[", "]"]);
/** Keys that step on as you hold them; the rest act once. */
const REPEATING = new Set(["j", "k"]);

/**
 * The shortcut a key press asks for: none while typing, in a dialog other than an overlay side (`data-gr-side`), or with
 * Ctrl, Meta, or Alt held, but for a bracket typed with Alt or AltGr.
 */
export function shortcutKey(event: KeyboardEvent): string | null {
  if (event.metaKey || event.isComposing) return null;
  // With Caps Lock on, letters type upper case: only Shift makes v and f ⇧V and ⇧F.
  const key = /^[A-Z]$/.test(event.key) && !event.shiftKey ? event.key.toLowerCase() : event.key;
  if (!KEYS.has(key) || (event.repeat && !REPEATING.has(key))) return null;
  if (event.altKey ? !ALT_TYPED.has(key) : event.ctrlKey) return null;
  // The element typed in, even inside a shadow root. A checkbox or button keeps focus after a click, but takes no typing.
  const target = event.composedPath()[0];
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(`${TEXT_FIELD}, select, [role=dialog]:not([data-gr-side]), [role=alertdialog]`))) return null;
  return key;
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
