import { useCallback, useSyncExternalStore } from "react";
import type { Verdict } from "../src/draft";

/** What the open draft would submit, for the Submit review button and the phone dock's count. */
export interface DraftStatus { verdict: Verdict; comments: number }

const statuses = new Map<string, DraftStatus>();
const listeners = new Set<() => void>();

/** The draft reports itself; null when there's nothing to submit from it, such as a local or closed review. */
export function setDraftStatus(targetKey: string, status: DraftStatus | null) {
  const current = statuses.get(targetKey);
  if (status && current && status.verdict === current.verdict && status.comments === current.comments) return;
  if (!status && !current) return;
  if (status) statuses.set(targetKey, status);
  else statuses.delete(targetKey);
  for (const listener of listeners) listener();
}

export function useDraftStatus(targetKey: string): DraftStatus | null {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return useSyncExternalStore(subscribe, () => statuses.get(targetKey) ?? null);
}
