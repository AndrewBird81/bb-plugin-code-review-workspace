import { expect, test } from "vitest";
import { agentStatus, reviewIndicator, type ThreadRow } from "./review-indicator";

const idle: ThreadRow = {
  parentThreadId: null, status: "idle", runtime: { displayStatus: "idle" }, lastReadAt: 2, latestAttentionAt: 1, hasPendingInteraction: false, queuedWork: "none",
  activity: { activeWorkflowCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeGoalCount: 0 },
};
const row = (extra: Partial<ThreadRow>, activity: Partial<ThreadRow["activity"]> = {}): ThreadRow => ({ ...idle, ...extra, activity: { ...idle.activity, ...activity } });
const unread = { lastReadAt: 1, latestAttentionAt: 2 };

test("an agent's status is BB's for its thread: working, done and unread, failed and unread, or asking you", () => {
  expect(agentStatus(idle)).toBeNull();
  expect(agentStatus(row({ status: "active", runtime: { displayStatus: "active" } }))).toEqual({ indicator: "runtime", unread: false });
  for (const displayStatus of ["provisioning", "starting", "stopping"]) expect(agentStatus(row({ runtime: { displayStatus } }))?.indicator).toBe("runtime");
  expect(agentStatus(row(unread))).toEqual({ indicator: "unread-success", unread: true });
  // Never read: BB counts it from 0.
  expect(agentStatus(row({ lastReadAt: null, latestAttentionAt: 5 }))?.indicator).toBe("unread-success");
  expect(agentStatus(row({ ...unread, status: "error" }))).toEqual({ indicator: "unread-error", unread: true });
  expect(agentStatus(row({ status: "error" }))).toBeNull();
  expect(agentStatus(row({ hasPendingInteraction: true }))?.indicator).toBe("waiting-for-input");
});

test("BB's order picks one: a failure, then a question, then work, then the unread dot, then a waiting message", () => {
  expect(agentStatus(row({ ...unread, status: "error", hasPendingInteraction: true }))?.indicator).toBe("unread-error");
  expect(agentStatus(row({ hasPendingInteraction: true, runtime: { displayStatus: "active" } }))?.indicator).toBe("waiting-for-input");
  expect(agentStatus(row({ runtime: { displayStatus: "active" } }, { activePlanModeCount: 1 }))?.indicator).toBe("plan-mode");
  expect(agentStatus(row({ runtime: { displayStatus: "active" } }, { activeGoalCount: 1 }))?.indicator).toBe("goal");
  expect(agentStatus(row({ runtime: { displayStatus: "active" } }, { activeWorkflowCount: 1 }))?.indicator).toBe("runtime");
  expect(agentStatus(row({}, { activeWorkflowCount: 1 }))?.indicator).toBe("workflow");
  expect(agentStatus(row({ ...unread, queuedWork: "failed" }))?.indicator).toBe("queued-failed");
  expect(agentStatus(row({ ...unread }, { activeBackgroundAgentCount: 1 }))?.indicator).toBe("unread-success");
  expect(agentStatus(row({}, { activeBackgroundAgentCount: 1 }))?.indicator).toBe("background-agent");
  expect(agentStatus(row({}, { activeBackgroundCommandCount: 1 }))?.indicator).toBe("background-command");
  expect(agentStatus(row({ queuedWork: "waiting" }))?.indicator).toBe("queued-waiting");
  // A busy thread isn't unread yet, and a child's unread never shows, as in BB.
  expect(agentStatus(row({ ...unread, status: "active" }))).toBeNull();
  expect(agentStatus(row({ ...unread, parentThreadId: "thr-parent" }))).toBeNull();
});

test("a review's row shows its agent's status in its own words, or a spinner while its guide is built unless the agent's is more pressing", () => {
  expect(reviewIndicator({ status: "ready", agentStatus: null })).toBeNull();
  expect(reviewIndicator({ status: "ready", agentStatus: { indicator: "unread-success", unread: true } })).toEqual({ indicator: "unread-success", label: "Review agent finished" });
  expect(reviewIndicator({ status: "ready", agentStatus: { indicator: "runtime", unread: false } })).toEqual({ indicator: "runtime", label: "Review agent working" });
  expect(reviewIndicator({ status: "generating" })).toEqual({ indicator: "runtime", label: null });
  expect(reviewIndicator({ status: "generating", agentStatus: { indicator: "unread-success", unread: true } })).toEqual({ indicator: "runtime", label: null });
  expect(reviewIndicator({ status: "generating", agentStatus: { indicator: "waiting-for-input", unread: false } })).toEqual({ indicator: "waiting-for-input", label: "Review agent needs your input" });
  expect(reviewIndicator({ status: "generating", agentStatus: { indicator: "unread-error", unread: true } })).toEqual({ indicator: "unread-error", label: "Review agent failed" });
});

test("active focuses keep the review glyph working after the general review ends", () => {
  const focusRun = { state: "finding" as const };
  expect(reviewIndicator({ status: "ready", focusRun })).toEqual({ indicator: "runtime", label: "Review agent working" });
  expect(reviewIndicator({ status: "ready", focusRun: { state: "merging" } })).toEqual({ indicator: "runtime", label: "Review agent working" });
  expect(reviewIndicator({ status: "ready", focusRun: { state: "done" } })).toBeNull();
  expect(reviewIndicator({ status: "ready", focusRun, agentStatus: { indicator: "unread-success", unread: true } })?.indicator).toBe("runtime");
  expect(reviewIndicator({ status: "ready", focusRun, agentStatus: { indicator: "waiting-for-input", unread: false } })?.indicator).toBe("waiting-for-input");
});
