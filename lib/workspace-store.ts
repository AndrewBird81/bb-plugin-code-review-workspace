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

/** What a Guided Review subPath shows, as ReviewPanel routes it: the list, Review settings, or a review. */
export type PanelPage = { kind: "list" } | { kind: "settings"; returnTo: string } | { kind: "review"; targetKey: string };

export function panelPage(subPath: string): PanelPage {
  const [first = "", ...rest] = subPath.split("/");
  if (first === "settings") return { kind: "settings", returnTo: rest.join("/") };
  return first ? { kind: "review", targetKey: first } : { kind: "list" };
}
