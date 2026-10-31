import { useCallback, useSyncExternalStore } from "react";
import type { Verdict } from "../src/draft";

/**
 * What the open draft would submit, for the Submit review button, and with its comments not on GitHub yet, which go
 * with Send (`local`), the phone dock's count.
 */
export interface DraftStatus { verdict: Verdict; comments: number; local: number }

const statuses = new Map<string, DraftStatus>();
/** A local review's open comments, which Finish review's Send would send: it submits nothing, so has no DraftStatus. */
const localToSend = new Map<string, number>();
const listeners = new Set<() => void>();

/** The draft reports itself; null when there's nothing to submit from it, such as a local or closed review. */
export function setDraftStatus(targetKey: string, status: DraftStatus | null) {
  const current = statuses.get(targetKey);
  if (status && current && status.verdict === current.verdict && status.comments === current.comments && status.local === current.local) return;
  if (!status && !current) return;
  if (status) statuses.set(targetKey, status);
  else statuses.delete(targetKey);
  for (const listener of listeners) listener();
}

export function useDraftStatus(targetKey: string): DraftStatus | null {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return useSyncExternalStore(subscribe, () => statuses.get(targetKey) ?? null);
}

/** A local review's draft reports its open comments, for Finish review in the title bar; null on any other review. */
export function setLocalToSend(targetKey: string, open: number | null) {
  if ((localToSend.get(targetKey) ?? null) === open) return;
  if (open === null) localToSend.delete(targetKey);
  else localToSend.set(targetKey, open);
  for (const listener of listeners) listener();
}

export function useLocalToSend(targetKey: string): number | null {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return useSyncExternalStore(subscribe, () => localToSend.get(targetKey) ?? null);
}
