// A review's work as BB draws a thread's on its rows, with BB's own glyph in BB's thread list and All reviews: its review
// agent's status, derived from its hidden thread as BB derives a thread's (the server reads it, src/agent-status.ts, as
// BB's live thread list in the browser leaves hidden threads out), or a spinner while its guide is built.
import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";

/** The statuses a review shows, in BB's order, most pressing first, as BB's list picks one for a row. */
const PRECEDENCE = ["unread-error", "waiting-for-input", "plan-mode", "goal", "runtime", "workflow", "queued-failed", "unread-success", "background-agent", "background-command", "queued-waiting"] as const satisfies readonly PluginSidebarThreadIndicator[];
export type ReviewIndicatorKind = typeof PRECEDENCE[number];

/** The review agent's status in BB, and whether BB counts its thread unread. */
export interface AgentStatus {
  indicator: ReviewIndicatorKind;
  unread: boolean;
}

/** What BB's thread list reads of a thread, as BB's API lists it. */
export interface ThreadRow {
  parentThreadId: string | null;
  status: string;
  runtime: { displayStatus: string };
  lastReadAt: number | null;
  latestAttentionAt: number;
  hasPendingInteraction: boolean;
  queuedWork: string;
  activity: { activeWorkflowCount: number; activeBackgroundAgentCount: number; activeBackgroundCommandCount: number; activePlanModeCount: number; activeGoalCount: number };
}

/** The status BB's thread list derives from a thread's row (BB 0.48), but a draft, which only a browser knows; null for none. */
export function agentStatus(row: ThreadRow): AgentStatus | null {
  const unread = (row.lastReadAt ?? 0) < row.latestAttentionAt;
  // A turn that ended since you last looked; a child thread's never shows.
  const finished = unread && row.parentThreadId === null && (row.status === "idle" || row.status === "error");
  const working = ["active", "provisioning", "starting", "stopping"].includes(row.runtime.displayStatus);
  const { activity } = row;
  const indicator: ReviewIndicatorKind | null = finished && row.status === "error" ? "unread-error"
    : row.hasPendingInteraction ? "waiting-for-input"
    : activity.activePlanModeCount > 0 ? "plan-mode"
    : activity.activeGoalCount > 0 ? "goal"
    : working ? "runtime"
    : activity.activeWorkflowCount > 0 ? "workflow"
    : row.queuedWork === "failed" ? "queued-failed"
    : finished ? "unread-success"
    : activity.activeBackgroundAgentCount > 0 ? "background-agent"
    : activity.activeBackgroundCommandCount > 0 ? "background-command"
    : row.queuedWork === "waiting" ? "queued-waiting"
    : null;
  return indicator && { indicator, unread };
}

/** Screen readers' words for the agent's status on a review's row, where BB's say "thread". */
const WORDS: Record<ReviewIndicatorKind, string> = {
  "unread-error": "Review agent failed",
  "waiting-for-input": "Review agent needs your input",
  "plan-mode": "Review agent working",
  goal: "Review agent working",
  runtime: "Review agent working",
  workflow: "Review agent working",
  "queued-failed": "A message to the review agent failed to send",
  "unread-success": "Review agent finished",
  "background-agent": "Review agent working",
  "background-command": "Review agent working",
  "queued-waiting": "A message waits for the review agent",
};

/**
 * What a review's row draws for its work, and its words, or null for nothing: its agent's status, or while its guide is
 * built, a spinner, unless the agent's status is more pressing. The guide's spinner has no words: the row says Building guide.
 */
export function reviewIndicator(review: { status?: string; agentStatus?: AgentStatus | null }): { indicator: ReviewIndicatorKind; label: string | null } | null {
  const agent = review.agentStatus ? { indicator: review.agentStatus.indicator, label: WORDS[review.agentStatus.indicator] } : null;
  if (review.status !== "generating") return agent;
  return agent && PRECEDENCE.indexOf(agent.indicator) < PRECEDENCE.indexOf("runtime") ? agent : { indicator: "runtime", label: null };
}
