// What BB's title bar shows of the inbox, apart from the page: whether GitHub is being read and how it went, and whether
// the page has room for its find box. The page publishes it, and the title bar's ⌕ and ⟳ call back into the page.
import { useSyncExternalStore } from "react";
import type { SyncHealth } from "../../src/review-lifecycle";

export interface InboxBar {
  refreshing: boolean;
  health: SyncHealth | undefined;
  /** The page shows its find box; where it doesn't, the title bar's ⌕ opens it. */
  searchInline: boolean;
  /** The find box is open where it isn't shown otherwise. */
  searchOpen: boolean;
  /** Read all of GitHub again. */
  refresh(): void;
  /** Show the find box, with the focus in it. */
  openSearch(): void;
}

let bar: InboxBar | null = null;
let titleBars = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

/** Make `next` the inbox the title bar shows. The returned function withdraws it, unless a newer one replaced it. */
export function publishInboxBar(next: InboxBar): () => void {
  bar = next;
  notify();
  return () => {
    if (bar !== next) return;
    bar = null;
    notify();
  };
}

/** The inbox showing, while it does. */
export function useInboxBar(): InboxBar | null {
  return useSyncExternalStore(subscribe, () => bar);
}

/** BB's title bar is there for the list's controls; the returned function says it went. */
export function mountListTitleBar(): () => void {
  titleBars++;
  notify();
  return () => {
    titleBars--;
    notify();
  };
}

/** Whether a title bar of BB's shows the list's controls; a host without headerContent has none. */
export function useListTitleBarMounted(): boolean {
  return useSyncExternalStore(subscribe, () => titleBars > 0);
}
