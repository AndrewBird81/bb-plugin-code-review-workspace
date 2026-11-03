// @vitest-environment jsdom
// Opening a review reads what its agent did, as opening a thread does in BB, so the review's rows lose their dot.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useAgentRead } from "../lib/use-agent-read";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => { cleanup(); delete (document as any).visibilityState; localStorage.clear(); sessionStorage.clear(); });

function Probe({ unread }: { unread: boolean }) {
  useAgentRead("pr-42", unread);
  return null;
}

async function probe(unread: boolean) {
  await loadPluginApp(() => import("../app"));
  const readAgent = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: Probe } as any, { unread }, { rpc: { readAgent } as any });
  return { slot, readAgent };
}

test("an unread agent is read as its review opens, and again each time it finishes while the review shows; a read one is left alone", async () => {
  const { slot, readAgent } = await probe(true);
  await waitFor(() => expect(readAgent).toHaveBeenCalledTimes(1));
  expect(readAgent).toHaveBeenCalledWith({ targetKey: "pr-42" });
  // Read, then the agent finishes again.
  slot.rerender(<Probe unread={false} />);
  slot.rerender(<Probe unread />);
  await waitFor(() => expect(readAgent).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
  cleanup();
  const read = await probe(false);
  await new Promise((done) => setTimeout(done, 20));
  expect(read.readAgent).not.toHaveBeenCalled();
  read.slot.lifecycle.unmount();
});

test("in a window out of view the agent stays unread until the window comes into view", async () => {
  let state: DocumentVisibilityState = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  const { slot, readAgent } = await probe(true);
  await new Promise((done) => setTimeout(done, 20));
  expect(readAgent).not.toHaveBeenCalled();
  state = "visible";
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(readAgent).toHaveBeenCalledTimes(1));
  slot.lifecycle.unmount();
});

test("a review's page reads its unread agent", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const readAgent = vi.fn(() => ({ ok: true }));
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({
      review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", repo: "acme/web", number: 42, agentStatus: { indicator: "unread-success", unread: true } },
      guide: { title: "Guide", intent: "x", unplacedFiles: [], sections: [{ id: "c1", title: "Parsing", overview: "o", diffs: [{ file: "src/a.ts", summary: "s" }] }] },
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n", revision: "r1",
    }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    readAgent,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByText("aa");
  await waitFor(() => expect(readAgent).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
});
