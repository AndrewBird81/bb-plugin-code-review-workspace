// The open reviews' workspaces, by targetKey, for UI outside a workspace's React tree: BB renders the title bar's
// controls (navPanel headerContent) apart from the page, with only the subPath to say which review is open.
import { useSyncExternalStore } from "react";
import type { WorkspaceApi } from "./workspace-context";
import type { ReviewIdentity } from "./review-identity";

const workspaces = new Map<string, WorkspaceApi>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

/** Make `api` its review's workspace. The returned function withdraws it, unless a newer one for the review replaced it. */
export function publishWorkspace(api: WorkspaceApi): () => void {
  workspaces.set(api.targetKey, api);
  notify();
  return () => {
    if (workspaces.get(api.targetKey) !== api) return;
    workspaces.delete(api.targetKey);
    notify();
  };
}

/** The review's workspace, read once, as a command does: null while no page shows it with its guide loaded. */
export function workspaceFor(targetKey: string): WorkspaceApi | null {
  return workspaces.get(targetKey) ?? null;
}

/** Whether the review's page is a narrow pane beside BB's side panel (lib/workspace-layout.ts), read alone. */
export function useNarrowPane(targetKey: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (targetKey === null ? false : workspaces.get(targetKey)?.layout.narrowPane ?? false));
}

/** The review's workspace while one shows it with its guide loaded; null otherwise, so no other review's controls show. */
export function useWorkspaceFor(targetKey: string | null): WorkspaceApi | null {
  return useSyncExternalStore(subscribe, () => (targetKey === null ? null : workspaces.get(targetKey) ?? null));
}

// How many of BB's title bars show each review's controls. A host without headerContent mounts none, so the
// workspace shows them in its own band instead.
const titleBars = new Map<string, number>();

/** BB's title bar is there for the review's controls; the returned function says it went. */
export function mountTitleBar(targetKey: string): () => void {
  titleBars.set(targetKey, (titleBars.get(targetKey) ?? 0) + 1);
  notify();
  return () => {
    const left = (titleBars.get(targetKey) ?? 1) - 1;
    if (left > 0) titleBars.set(targetKey, left);
    else titleBars.delete(targetKey);
    notify();
  };
}

/** Whether a title bar of BB's is there for the review's controls. */
export function useTitleBarMounted(targetKey: string): boolean {
  return useSyncExternalStore(subscribe, () => titleBars.has(targetKey));
}

// How many of each review's comments need you, for the title bar's Comments badge; the comments list reports it.
const needsYou = new Map<string, number>();

export function setNeedsYou(targetKey: string, count: number) {
  if ((needsYou.get(targetKey) ?? 0) === count) return;
  if (count) needsYou.set(targetKey, count);
  else needsYou.delete(targetKey);
  notify();
}

export function useNeedsYou(targetKey: string | null): number {
  return useSyncExternalStore(subscribe, () => (targetKey === null ? 0 : needsYou.get(targetKey) ?? 0));
}

// The file each open review is on: moving from file to file draws again only what marks it, not the whole workspace.
const currentFiles = new Map<string, string>();

export function setCurrentFile(targetKey: string, file: string | undefined) {
  if (currentFiles.get(targetKey) === file) return;
  if (file === undefined) currentFiles.delete(targetKey);
  else currentFiles.set(targetKey, file);
  notify();
}

/** The file the review is on, read when it's needed rather than drawn. */
export function currentFileOf(targetKey: string): string | undefined {
  return currentFiles.get(targetKey);
}

export function useCurrentFile(targetKey: string): string | undefined {
  return useSyncExternalStore(subscribe, () => currentFiles.get(targetKey));
}

/** What BB's title bar and the window's title say of a review (lib/review-identity.ts). */
export type ReviewTitle = Pick<ReviewIdentity, "id" | "name" | "line">;

// Each open review's title, which BB asks for apart from the page: published by the review's page whatever it shows,
// its guide or not. Each page that shows the review publishes it, as two panes may, and the latest one still showing it
// is its title.
const titles = new Map<string, Array<{ title: ReviewTitle }>>();

/** Make `title` the review's while its page shows. The returned function withdraws it. */
export function publishReviewTitle(targetKey: string, title: ReviewTitle): () => void {
  const entry = { title };
  titles.set(targetKey, [...titles.get(targetKey) ?? [], entry]);
  notify();
  return () => {
    const left = (titles.get(targetKey) ?? []).filter((other) => other !== entry);
    if (left.length) titles.set(targetKey, left);
    else titles.delete(targetKey);
    notify();
  };
}

export function useReviewTitle(targetKey: string | null): ReviewTitle | null {
  return useSyncExternalStore(subscribe, () => (targetKey === null ? null : titles.get(targetKey)?.at(-1)?.title ?? null));
}

// How many of BB's title bars show each review's title (app.tsx), as a host with page titles does; the band then
// leaves the review's name to it.
const pageTitles = new Map<string, number>();

/** BB's title bar shows the review's title; the returned function says it stopped. */
export function showPageTitle(targetKey: string): () => void {
  pageTitles.set(targetKey, (pageTitles.get(targetKey) ?? 0) + 1);
  notify();
  return () => {
    const left = (pageTitles.get(targetKey) ?? 1) - 1;
    if (left > 0) pageTitles.set(targetKey, left);
    else pageTitles.delete(targetKey);
    notify();
  };
}

/** Whether a title bar of BB's shows the review's title. */
export function usePageTitleShown(targetKey: string): boolean {
  return useSyncExternalStore(subscribe, () => pageTitles.has(targetKey));
}

/** What a Code Review Workspace subPath shows, as ReviewPanel routes it: the list, Review settings, or a review. */
export type PanelPage = { kind: "list" } | { kind: "settings"; returnTo: string } | { kind: "review"; targetKey: string };

export function panelPage(subPath: string): PanelPage {
  const [first = "", ...rest] = subPath.split("/");
  if (first === "settings") return { kind: "settings", returnTo: rest.join("/") };
  return first ? { kind: "review", targetKey: first } : { kind: "list" };
}

// Whether each review's tabs in BB's side panel show: they report it (experimental_useTabVisible), so the title bar
// can say Ask agent is pressed while the Review agent tab shows.
const shownTabs = new Map<string, number>();

/** The review's `tab` shows in BB's side panel; the returned function says it stopped. */
export function showTab(targetKey: string, tab: string): () => void {
  const key = `${targetKey}\0${tab}`;
  shownTabs.set(key, (shownTabs.get(key) ?? 0) + 1);
  notify();
  return () => {
    const left = (shownTabs.get(key) ?? 1) - 1;
    if (left > 0) shownTabs.set(key, left);
    else shownTabs.delete(key);
    notify();
  };
}

export function useTabShown(targetKey: string | null, tab: string): boolean {
  return useSyncExternalStore(subscribe, () => targetKey !== null && shownTabs.has(`${targetKey}\0${tab}`));
}
