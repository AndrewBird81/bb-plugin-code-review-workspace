import type { CommentLocation } from "../src/draft";

/** The workspace's single-key shortcuts, as the help sheet lists them. */
export const SHORTCUTS = [
  { keys: ["j", "k"], label: "Next or previous file" },
  { keys: ["n", "p"], label: "Next or previous chapter" },
  { keys: ["v"], label: "Mark the file viewed, or not, and go to the next" },
  { keys: ["u"], label: "Next unviewed file, in any chapter" },
  { keys: ["]", "["], label: "Next or previous comment or discussion" },
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

/** Lines in the order the guide reads them: by chapter, by file within it, then by line. */
export function inDiffOrder(locations: CommentLocation[], files: string[]): CommentLocation[] {
  const order = new Map(files.map((file, index) => [file, index]));
  return locations
    .filter((at) => order.has(at.file))
    .sort((a, b) => order.get(a.file)! - order.get(b.file)! || a.line - b.line || a.side.localeCompare(b.side));
}
