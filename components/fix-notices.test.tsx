// @vitest-environment jsdom
// The notice for the comments sent to the main thread (components/shell/FixNotices.tsx), naming it "The main thread":
// "1 of 6 reported" with Check now once it stops, never before; archived or deleted, Send the rest to a fresh thread
// too; while the review agent checks, only that; then Ready to re-review, with what the check found.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { TOUCH_CONTROL } from "./touch";
import { CHECK_FIXES } from "./shell/FixNotices";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const KEY = "br-1";
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Snooze flaky checks", intent: "Snoozes checks.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Snooze", overview: "", diffs: [{ file: "src/a.ts" }] }] };
const feature = { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/snooze", baseRef: "main", repo: "acme/api" };
const send = { n: 1, at: 1, threadId: "main", ids: ["c1", "c2", "c3", "c4", "c5", "c6"] };
const tally = (over: Record<string, number> = {}) => ({ sent: 6, reported: 1, inferred: 0, checked: 0, fixed: 0, ...over });
const sent = (over: Record<string, unknown> = {}, fixes = tally()) => ({
  targetKey: KEY, kind: "ref", gitRef: feature.branch, status: "ready", createdAt: 1, title: "Snooze flaky checks", feature,
  mainThread: { threadId: "main", environmentId: "env1", origin: "adopted", since: 1 }, sends: [{ ...send, ...over }], fixes,
});
const idle = { stopped: { at: 2, why: "idle" } };
// The draft: c1 reported, c2 and c3 still out.
const comments = [
  { file: "src/a.ts", line: 1, side: "RIGHT", body: "One.", id: "c1", state: "sent", sendN: 1, claim: { outcome: "done", threadId: "main", at: 2 } },
  { file: "src/a.ts", line: 1, side: "LEFT", body: "Two.", id: "c2", state: "sent", sendN: 1 },
  { file: "src/a.ts", line: 2, side: "RIGHT", body: "Three.", id: "c3", state: "sent", sendN: 1, claim: { outcome: "done", threadId: "agent", at: 3, inferred: true } },
];

async function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, unknown> = {}, knobs: Record<string, boolean> = {}) {
  patchReviewState(KEY, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review, guide: structuredClone(guide), patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, ...knobs } }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/api", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    checkFeature: () => ({ state: "current", alsoActive: [], hidden: [], flagged: [] }),
    getDraft: vi.fn(() => ({ draft: { targetKey: KEY, verdict: "COMMENT", body: "", comments }, stale: [] })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }] }),
    getSourceThread: () => ({ thread: { threadId: "main", title: "Snooze flaky checks", state: "open", machine: "MaxBook" } }),
    markSeen: () => ({ ok: true }),
    checkFixes: vi.fn(() => ({ ok: true })),
    sendToSourceThread: vi.fn(() => ({ ok: true, delivery: "sent", title: "Fixes for api:feat-snooze", threadId: "fresh", sendN: 2 })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: KEY }, { rpc: handlers as any });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}

test("while the main thread works on them, there's no notice: only the review's status says how many are reported", async () => {
  const { slot } = await renderWorkspace(sent());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(slot.queryByRole("status", { name: "Comments sent" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Check now" })).toBeNull();
  slot.lifecycle.unmount();
});

test("idle with 1 of 6 reported, it says so, naming the main thread, never by its title; Check now asks the review agent", async () => {
  const { slot, rpc } = await renderWorkspace(sent(idle, tally({ inferred: 1 })));
  const shown = await slot.findByRole("status", { name: "Comments sent" });
  expect(shown.textContent).toBe("1 of 6 reported, 1 looks done. The main thread is idle but may still be waiting on subagents.Check now");
  expect(shown.textContent).not.toContain("Snooze flaky checks");
  const check = within(shown).getByRole("button", { name: "Check now" });
  expect(check.getAttribute("aria-description")).toBe(CHECK_FIXES);
  expect(check.className.split(" ")).toEqual(expect.arrayContaining(TOUCH_CONTROL.split(" ")));
  expect(within(shown).queryByRole("button", { name: /fresh thread/ })).toBeNull();
  const loads = rpc.getReviewBundle.mock.calls.length;
  fireEvent.click(check);
  await waitFor(() => expect(rpc.checkFixes).toHaveBeenCalledWith({ targetKey: KEY }));
  await waitFor(() => expect(rpc.getReviewBundle.mock.calls.length).toBeGreaterThan(loads));
  slot.lifecycle.unmount();
});

test("archived or deleted, it says so, with Check now and Send the rest to a fresh thread, which sends what wasn't reported", async () => {
  const archived = await renderWorkspace(sent({ stopped: { at: 2, why: "archived" } }, tally({ sent: 3 })));
  const shown = await archived.slot.findByRole("status", { name: "Comments sent" });
  expect(shown.textContent).toContain("1 of 3 reported. The main thread is archived.");
  expect(within(shown).getByRole("button", { name: "Check now" })).toBeTruthy();
  fireEvent.click(within(shown).getByRole("button", { name: "Send the rest to a fresh thread" }));
  // c2, not reported, and c3, which only looks done; never c1, which the thread reported.
  await waitFor(() => expect(archived.rpc.sendToSourceThread).toHaveBeenCalledWith({ targetKey: KEY, comments: [{ file: "src/a.ts", line: 1, side: "LEFT" }, { file: "src/a.ts", line: 2, side: "RIGHT" }], thread: "fresh", force: true }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent 2 comments to Fixes for api:feat-snooze."));
  archived.slot.lifecycle.unmount();
  cleanup();
  const gone = await renderWorkspace(sent({ stopped: { at: 2, why: "deleted" } }, tally({ sent: 3 })), {}, { sendToThread: false });
  const deleted = await gone.slot.findByRole("status", { name: "Comments sent" });
  expect(deleted.textContent).toContain("The main thread was deleted.");
  // With Send to thread off, there's no Send.
  expect(within(deleted).queryByRole("button", { name: /fresh thread/ })).toBeNull();
  gone.slot.lifecycle.unmount();
});

test("while the review agent checks the fixes, it says only that, never Ready yet; its end, as feedback, reads the review again", async () => {
  const checking = await renderWorkspace({ ...sent({ readyAt: 3, checkedAt: 3 }, tally({ sent: 3, reported: 3 })), verifyingSince: 4, verifyingFixes: true });
  const busy = await checking.slot.findByRole("status", { name: "Checking the fixes" });
  expect(busy.textContent).toBe("All 3 reported. Checking the fixes…");
  expect(within(busy).queryByRole("button")).toBeNull();
  expect(busy.querySelector("svg")?.getAttribute("data-icon")).toBe("Loading");
  const loads = checking.rpc.getReviewBundle.mock.calls.length;
  await checking.slot.emitRealtime(`feedback:${KEY}`, {});
  await waitFor(() => expect(checking.rpc.getReviewBundle.mock.calls.length).toBeGreaterThan(loads));
  checking.slot.lifecycle.unmount();
  cleanup();
  // A check of your feedback alone, as after a guide's rebuild, isn't checking them: Ready stands, with its button.
  const feedback = await renderWorkspace({ ...sent({ readyAt: 3, checkedAt: 3 }, tally({ sent: 3, reported: 3 })), verifyingSince: 4 });
  const ready = await feedback.slot.findByRole("status", { name: "Ready to re-review" });
  expect(ready.textContent).toBe("Ready to re-review. The main thread reported all 3.Check again");
  expect(feedback.slot.queryByRole("status", { name: "Checking the fixes" })).toBeNull();
  feedback.slot.lifecycle.unmount();
});

test("Ready to re-review says what came back and what the check found, with Check fixes, or Check again once checked", async () => {
  const ready = await renderWorkspace(sent({ readyAt: 3 }, tally({ reported: 6 })));
  const shown = await ready.slot.findByRole("status", { name: "Ready to re-review" });
  expect(shown.textContent).toBe("Ready to re-review. The main thread reported all 6.Check fixes");
  ready.slot.lifecycle.unmount();
  cleanup();
  const checked = await renderWorkspace(sent({ readyAt: 3, checkedAt: 3 }, tally({ reported: 6, checked: 6, fixed: 5 })));
  const back = await checked.slot.findByRole("status", { name: "Ready to re-review" });
  expect(back.textContent).toBe("Ready to re-review. The main thread reported all 6. Checked: 5 look fixed, 1 doesn't.Check again");
  checked.slot.lifecycle.unmount();
  cleanup();
  const finished = await renderWorkspace(sent({ readyAt: 3, checkedAt: 3 }, tally({ reported: 4, inferred: 1 })));
  expect((await finished.slot.findByRole("status", { name: "Ready to re-review" })).textContent).toContain("Ready to re-review. The main thread says it’s finished: 4 of 6 reported, 1 looks done.");
  finished.slot.lifecycle.unmount();
  cleanup();
  // Finished from another thread, by its title, or from a shell.
  const other = await renderWorkspace(sent({ readyAt: 3, readyBy: { from: "thread", title: "Release checklist" } }, tally({ reported: 4 })));
  expect((await other.slot.findByRole("status", { name: "Ready to re-review" })).textContent).toContain("Ready to re-review. Release checklist says it’s finished: 4 of 6 reported.");
  other.slot.lifecycle.unmount();
  cleanup();
  const shell = await renderWorkspace(sent({ readyAt: 3, readyBy: { from: "shell" } }, tally({ reported: 4 })));
  expect((await shell.slot.findByRole("status", { name: "Ready to re-review" })).textContent).toContain("Ready to re-review. Marked finished from the command line: 4 of 6 reported.");
  shell.slot.lifecycle.unmount();
});

test("a check that can't start says why; with the re-review check off there's no button; an archived review says nothing", async () => {
  const refused = await renderWorkspace(sent(idle), { checkFixes: () => ({ ok: false, error: "The review agent couldn't start. Open Ask agent to choose its agent." }) });
  fireEvent.click(within(await refused.slot.findByRole("status", { name: "Comments sent" })).getByRole("button", { name: "Check now" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The review agent couldn't start. Open Ask agent to choose its agent."));
  refused.slot.lifecycle.unmount();
  cleanup();
  const off = await renderWorkspace(sent(idle), {}, { runReReviewCheck: false });
  expect(within(await off.slot.findByRole("status", { name: "Comments sent" })).queryByRole("button")).toBeNull();
  off.slot.lifecycle.unmount();
  cleanup();
  const archived = await renderWorkspace({ ...sent(idle), userArchivedAt: 5 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(archived.slot.queryByRole("status", { name: "Comments sent" })).toBeNull();
  archived.slot.lifecycle.unmount();
});
