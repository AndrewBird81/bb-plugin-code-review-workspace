// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { patchReviewState } from "../lib/panel-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); restores.splice(0).forEach((restore) => restore()); Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null }); });
HTMLElement.prototype.scrollIntoView = () => {};
test("an open verdict menu is inside the fullscreen element", async () => {
  const workspace = document.createElement("div");
  document.body.appendChild(workspace);
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: workspace });
  render(<Select open value="COMMENT"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="COMMENT">Comment</SelectItem><SelectItem value="APPROVE">Approve</SelectItem></SelectContent></Select>, { container: workspace });
  const menu = await screen.findByRole("listbox");
  expect(workspace.contains(menu)).toBe(true);
  workspace.remove();
});

/** A browser that can make an element full screen. */
function fakeFullscreen() {
  let element: Element | null = null;
  const change = (next: Element | null) => { element = next; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: () => change(null) });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value(this: HTMLElement) { return change(this); } });
  restores.push(() => {
    for (const key of ["fullscreenEnabled", "exitFullscreen"]) delete (document as unknown as Record<string, unknown>)[key];
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });
}

test("in full screen, the compare select's menu and Diff options open inside the workspace, which is all that shows", async () => {
  fakeFullscreen();
  patchReviewState("pr-42", { activeId: "c1" });
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, guide: { title: "Guide", intent: "Parses.", unplacedFiles: [], sections: [{ id: "c1", title: "Parsing", overview: "Reads.", diffs: [{ file: "src/a.ts" }] }] }, patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getPrCommits: () => ({ commits: [] }),
    getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(patch.replace("+aa", "+a0"), patch) }),
  } as any });
  await slot.findByTestId("filediff");
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  const root = document.fullscreenElement!;
  expect(root).toBeTruthy();
  fireEvent.click(await slot.findByRole("button", { name: "Show changes: Since your review" }));
  expect(root.contains(await slot.findByRole("menu", { name: "Show changes" }))).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // The focus goes back to the select a moment after its menu closes.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  fireEvent.click(slot.getByRole("button", { name: "Diff options" }));
  expect(root.contains(await slot.findByRole("switch", { name: "Wrap long lines" }))).toBe(true);
  // Over the page, BB's toaster is under it: the workspace shows the toasts itself, Undo and all.
  const { toast } = await import("sonner");
  act(() => { toast.success("Marked 1 file viewed", { action: { label: "Undo", onClick: () => {} } }); });
  await waitFor(() => expect(root.contains(screen.getByText("Marked 1 file viewed"))).toBe(true));
  expect(within(root as HTMLElement).getByRole("button", { name: "Undo" })).toBeTruthy();
  slot.lifecycle.unmount();
});
