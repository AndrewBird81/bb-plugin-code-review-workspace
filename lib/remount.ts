// BB remounts a plugin's page when its own layout switches, at a 768px window: as a 14 Pro Max turns, as the Duo
// unfolds. What a review's workspace has open, typed, shows and focuses is kept in this tab's sessionStorage as it
// changes, for a new workspace in its place to go on from: one that mounts while the old one is still there, or within
// FRESH_MS of its going. Later, a review opens as it always does.
import type { SelectedLineRange } from "@pierre/diffs";
import type { WorkspaceLayout } from "./workspace-layout";

/**
 * Where you are in the code: the line at its top, by its file and its index in pierre's diff (data-line-index), or the
 * box you're typing in (`focus`), which is what stays put in place; and how far under the code's top.
 */
export type LinePlace = { file: string; index: string; offset: number } | { focus: true; offset: number };

/**
 * What has the focus: Find in review's box, a comment box, or the side panel; with the caret, in a box; and, typing,
 * where (the layout's `typingIn`), which decides what a turn or fold hides rather than cover the box.
 */
export interface KeptFocus {
  in: "find" | "composer" | "panel";
  caret?: [number, number];
  typing?: "nav" | "panel" | "other";
}

export interface Kept {
  navOverlay: boolean;
  panelOverlay: boolean;
  find: string;
  place: LinePlace | null;
  focus: KeptFocus | null;
  lines: { file: string; range: SelectedLineRange } | null;
  /** The layout's last size and window, and the layout itself, for a phone's turn or fold to carry what's open. */
  layout: { width: number; height: number; window: { width: number; height: number }; shown: WorkspaceLayout };
}

/** `doc`: the page it was kept in (performance.timeOrigin): a reload starts afresh, and reopens nothing by itself. */
type Entry = Partial<Kept> & { live: number; gone?: number; doc?: number };

const KEY = "gr:remount";
const FRESH_MS = 2000;
/**
 * How long what's kept waits after the window resizes. BB swaps its layout a few frames after the window crosses 768:
 * until then the old workspace lays out in BB's old pane at the window's new size, where a side can dock that can't in
 * the new pane (the unfolded Duo held sideways, beside BB's thread list). The new workspace goes on from what was kept
 * before the turn instead, so the turn carries what's open as it does in place.
 */
const SETTLE_MS = 300;

let resizedAt = -Infinity;
window.addEventListener("resize", () => { resizedAt = Date.now(); });
/** Per review, what waits to be kept, until SETTLE_MS after the window last resized. */
const waiting = new Map<string, { patch: Partial<Kept>; timer: ReturnType<typeof setTimeout> }>();

function read(): Record<string, Entry> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, Entry>;
  } catch {
    return {};
  }
}

function update(key: string, change: (entry: Entry) => Entry) {
  const all = read();
  const was = JSON.stringify(all[key] ?? null);
  all[key] = change(all[key] ?? { live: 0 });
  if (JSON.stringify(all[key]) === was) return;
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: nothing is carried */ }
}

/** Keeps `patch` for the review `key`'s next workspace, should one take this one's place: once the window has settled. */
export function keep(key: string, patch: Partial<Kept>) {
  const was = waiting.get(key);
  const all = { ...was?.patch, ...patch };
  clearTimeout(was?.timer);
  waiting.delete(key);
  const wait = resizedAt + SETTLE_MS - Date.now();
  if (wait <= 0) return update(key, (entry) => ({ ...entry, ...all }));
  waiting.set(key, { patch: all, timer: setTimeout(() => keep(key, {}), wait) });
}

/** A workspace of the review `key` is there; the function it returns says it's gone, and drops what waits to be kept. */
export function present(key: string): () => void {
  const doc = performance.timeOrigin;
  update(key, (entry) => ({ ...entry, live: entry.doc === doc ? entry.live + 1 : 1, doc }));
  return () => {
    clearTimeout(waiting.get(key)?.timer);
    waiting.delete(key);
    update(key, (entry) => ({ ...entry, live: Math.max(0, entry.live - 1), gone: Date.now() }));
  };
}

/** What the workspace of the review `key` that this one takes the place of kept, if it does; else null. */
export function carried(key: string): Partial<Kept> | null {
  const entry = read()[key];
  if (!entry || entry.doc !== performance.timeOrigin || !(entry.live > 0 || (entry.gone !== undefined && Date.now() - entry.gone < FRESH_MS))) return null;
  const { live: _live, gone: _gone, doc: _doc, ...was } = entry;
  return was;
}
