// @vitest-environment jsdom
// A client without BB's side panel hooks, as BB desktop apps from before 0.48.0: the review still loads, and its
// commands open the agent's and the main thread's chats as threads, in a split.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("@get-bb/plugin-sdk/app", async (original) => ({ ...await original<typeof import("@get-bb/plugin-sdk/app")>(), experimental_useAppPanel: undefined, experimental_useTabVisible: undefined }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Snoozes checks.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Snooze", overview: "Waits.", diffs: [{ file: "src/a.ts" }] }] };
const review = { targetKey: "br-1", kind: "ref", status: "ready", createdAt: 1, title: "Build snooze", gitRef: "feat/snooze", sourceThreadId: "coder", mainThread: { threadId: "coder", environmentId: null, origin: "adopted", since: 1 } };

async function renderReview(agentThread: string | null) {
  patchReviewState("br-1", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.navPanels[0]!;
  const options = { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "br-1", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: agentThread, legacy: [], defaults: null, machine: null }),
    getSourceThread: () => ({ thread: { threadId: "coder", title: "Build snooze", state: "open", machine: null } }),
    markSeen: () => ({ ok: true }),
  } as any };
  const bar = renderSlot({ component: registration.headerContent! }, { subPath: "br-1" }, options);
  const page = renderSlot(registration, { subPath: "br-1" }, options);
  await page.findByTestId("filediff");
  return { bar, page };
}

test("without BB's panel hooks, Ask agent opens the agent's chat, and Show beside review the main thread, each in a split", async () => {
  const { bar, page } = await renderReview("agent-1");
  fireEvent.click(await bar.findByRole("button", { name: "Ask agent" }));
  await waitFor(() => expect(page.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "agent-1", options: { split: true } }));
  fireEvent.click(bar.getByRole("button", { name: "Show main thread beside review" }));
  expect(page.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder", options: { split: true } });
  expect(toast.error).not.toHaveBeenCalled();
});

test("without BB's panel hooks and no agent chat yet, Ask agent says to update the BB app", async () => {
  const { bar, page } = await renderReview(null);
  fireEvent.click(await bar.findByRole("button", { name: "Ask agent" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Update the BB app to start a review agent chat here."));
  expect(page.inspection.navigateCalls).toEqual([]);
});
