import type { CommentLocation, Severity } from "./draft";

export interface FocusThread {
  threadId: string; targetKey: string; runId: string; focusId: string; label: string; createdAt: number;
}
export interface FocusFinding extends CommentLocation {
  targetKey: string; runId: string; id: string; focusId: string; label: string;
  startLine?: number; startSide?: "LEFT" | "RIGHT"; severity: Severity; body: string; evidence: string; introduced?: boolean;
  status: "found" | "kept" | "folded" | "dropped" | "not-checked";
  reason?: string; note?: string; draftFile?: string; draftLine?: number; draftSide?: CommentLocation["side"]; decidedAt?: number;
}
export interface FocusTokens { input: number; output: number }
export interface FocusRun {
  id: string; head: string; startedAt: number; endedAt?: number;
  state: "finding" | "merging" | "done" | "stopped";
  mergeMessageId?: string; mergeDispatchedAt?: number; mergeCancelledAt?: number; nudged?: true; mergeAwaitingTools?: true;
  focuses: { focusId: string; label: string; state: "queued" | "running" | "done" | "failed" | "stopped";
    queuedAt: number; spawnedAt?: number; activeAt?: number; findings?: number; error?: string; unchecked?: string[]; tokens?: FocusTokens }[];
  mergeTokens?: FocusTokens;
}
