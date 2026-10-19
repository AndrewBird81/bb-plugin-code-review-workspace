// The open reviews' workspaces, by targetKey, for UI outside a workspace's React tree: BB renders the title bar's
// controls (navPanel headerContent) apart from the page, with only the subPath to say which review is open.
import { useSyncExternalStore } from "react";
import type { WorkspaceApi } from "./workspace-context";

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

/** What a Code Review Workspace subPath shows, as ReviewPanel routes it: the list, Review settings, or a review. */
export type PanelPage = { kind: "list" } | { kind: "settings"; returnTo: string } | { kind: "review"; targetKey: string };

export function panelPage(subPath: string): PanelPage {
  const [first = "", ...rest] = subPath.split("/");
  if (first === "settings") return { kind: "settings", returnTo: rest.join("/") };
  return first ? { kind: "review", targetKey: first } : { kind: "list" };
}
