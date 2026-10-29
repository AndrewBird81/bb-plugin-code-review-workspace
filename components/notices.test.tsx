// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { TOUCH_CONTROL } from "./touch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }] }] };

async function renderWorkspace(rpc: Record<string, unknown> = {}, bundle: () => Record<string, unknown> = () => ({})) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1", ...bundle() })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: vi.fn(() => ({ hasNewCommits: false })),
    rereview: vi.fn(() => ({ ok: true })),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }] }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}
const notice = (slot: Awaited<ReturnType<typeof renderWorkspace>>["slot"], text: string) => slot.getByText(text).closest<HTMLElement>("[role]")!;

test("new commits show a notice with Update guide, which rebuilds it; once the guide catches up, the notice goes", async () => {
  const checkForUpdates = vi.fn().mockReturnValueOnce({ hasNewCommits: true }).mockReturnValue({ hasNewCommits: false });
  const { slot, rpc } = await renderWorkspace({ checkForUpdates });
  await slot.findByText("New commits since this guide was written.");
  fireEvent.click(within(notice(slot, "New commits since this guide was written.")).getByRole("button", { name: "Update guide" }));
  await waitFor(() => expect(rpc.rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  // The rebuilt guide publishes the review's update, which checks again.
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(slot.queryByText("New commits since this guide was written.")).toBeNull());
  slot.lifecycle.unmount();
});

test("a PR retargeted to a new base says so in the Update guide notice, with or without new commits", async () => {
  const baseChanged = { from: "parent", to: "main" };
  const checkForUpdates = vi.fn().mockReturnValueOnce({ hasNewCommits: true, current: "new", stored: "new", baseChanged })
    .mockReturnValue({ hasNewCommits: true, current: "newer", stored: "new", baseChanged });
  const { slot } = await renderWorkspace({ checkForUpdates });
  const text = "The PR’s base changed from parent to main since this guide was written.";
  await slot.findByText(text);
  expect(within(notice(slot, text)).getByRole("button", { name: "Update guide" })).toBeTruthy();
  await slot.emitRealtime("review:pr-42", {});
  await slot.findByText("New commits, and the PR’s base changed from parent to main, since this guide was written.");
  slot.lifecycle.unmount();
});

test("one notice shows, the most pressing first, and +N shows the rest under it", async () => {
  const { slot } = await renderWorkspace({
    checkForUpdates: () => ({ hasNewCommits: true }),
    checkRepoAccess: () => ({ accessible: false, repo: "acme/web", account: "me" }),
  });
  await slot.findByText("@me can’t access acme/web. Switch account:");
  expect(slot.queryByText("New commits since this guide was written.")).toBeNull();
  const more = await slot.findByRole("button", { name: "1 more notice" });
  // A 44px target on a coarse pointer.
  expect(more.className.split(" ")).toEqual(expect.arrayContaining(TOUCH_CONTROL.split(" ")));
  fireEvent.click(more);
  expect(slot.getByText("New commits since this guide was written.")).toBeTruthy();
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("button", { name: "GitHub account: @me" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Show fewer notices" }));
  expect(slot.queryByText("New commits since this guide was written.")).toBeNull();
  slot.lifecycle.unmount();
});

test("while the guide is updated, the notice says the view and unsaved edits stay; a failed update offers Try again", async () => {
  let generating = false;
  const { slot, rpc } = await renderWorkspace({}, () => generating ? { guide: null, review: { targetKey: "pr-42", kind: "pr", status: "generating", createdAt: 1, title: "Parse rows", headSha: "new" } } : {});
  generating = true;
  await slot.emitRealtime("review:pr-42", {});
  const updating = await slot.findByText("Updating the guide for the new commits. Your current view and unsaved edits stay here.");
  expect(updating.closest("[role]")!.getAttribute("role")).toBe("status");
  expect(slot.getByTestId("filediff")).toBeTruthy();
  // The new guide arrives.
  generating = false;
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(slot.queryByText(/Updating the guide/)).toBeNull());
  slot.lifecycle.unmount();
  let retried = false;
  const broken = await renderWorkspace({ rereview: vi.fn(() => { retried = true; return { ok: true }; }) }, () => retried
    ? { guide: null, review: { targetKey: "pr-42", kind: "pr", status: "generating", createdAt: 1, title: "Parse rows", headSha: "new" } }
    : { review: { targetKey: "pr-42", kind: "pr", status: "error", createdAt: 1, title: "Parse rows", headSha: "new" } });
  const alert = notice(broken.slot, "Couldn’t update the guide. Showing the previous one.");
  expect(alert.getAttribute("role")).toBe("alert");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(broken.rpc.rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect(rpc.rereview).not.toHaveBeenCalled();
  // The update starts over, so its notice replaces the failed one, which stayed beside it (72-hands-on, 95-recheck).
  await broken.slot.findByText("Updating the guide for the new commits. Your current view and unsaved edits stay here.");
  expect(broken.slot.queryByText("Couldn’t update the guide. Showing the previous one.")).toBeNull();
  broken.slot.lifecycle.unmount();
});

test("a failed update says why under its text, as plain text cut to a few lines, when it's known", async () => {
  const text = "Its last guide wasn't accepted:\nmissing: src/a.ts is in the diff but not in the guide <b>";
  const { slot } = await renderWorkspace({}, () => ({ review: { targetKey: "pr-42", kind: "pr", status: "error", createdAt: 1, title: "Parse rows", headSha: "new", guideError: { at: 1, text } } }));
  const alert = notice(slot, "Couldn’t update the guide. Showing the previous one.");
  expect(alert.getAttribute("role")).toBe("alert");
  const reason = within(alert).getByText(/^Its last guide wasn't accepted:/);
  expect(reason.textContent).toBe(text);
  expect(reason.className).toContain("line-clamp-3");
  // .block comes after .line-clamp-3 in the built CSS and undoes its display, so the reason showed whole (72-hands-on #1).
  expect(reason.className.split(" ")).not.toContain("block");
  expect(reason.className).toContain("whitespace-pre-line");
  expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  slot.lifecycle.unmount();
  // Unknown, the notice is its text alone.
  const unknown = await renderWorkspace({}, () => ({ review: { targetKey: "pr-42", kind: "pr", status: "error", createdAt: 1, title: "Parse rows", headSha: "new" } }));
  const plain = notice(unknown.slot, "Couldn’t update the guide. Showing the previous one.");
  expect(plain.textContent).toBe("Couldn’t update the guide. Showing the previous one.Try again");
  unknown.slot.lifecycle.unmount();
});

test("an update waiting for its writer's machine says it restarts on its own once that reconnects, with Try again, until the wait ends", async () => {
  let pending: { since: number } | null = { since: 1 };
  const { slot, rpc } = await renderWorkspace({}, () => ({ review: { targetKey: "pr-42", kind: "pr", status: "error", createdAt: 1, title: "Parse rows", headSha: "new", restartPending: pending } }));
  const text = "The guide writer’s machine is offline. The update restarts on its own when it reconnects. Showing the previous guide.";
  const waiting = notice(slot, text);
  expect(waiting.getAttribute("role")).toBe("status");
  expect(slot.queryByText("Couldn’t update the guide. Showing the previous one.")).toBeNull();
  fireEvent.click(within(waiting).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rpc.rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  // The wait ends without a restart: it failed after all.
  pending = null;
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(notice(slot, "Couldn’t update the guide. Showing the previous one.").getAttribute("role")).toBe("alert"));
  expect(slot.queryByText(text)).toBeNull();
  slot.lifecycle.unmount();
});

test("while the connection is down the review says it's reconnecting, and once back it reads the review, views, draft and threads again", async () => {
  const counted = { getFileViews: 0, getDraft: 0, getReviewThreads: 0 };
  const count = <T,>(name: keyof typeof counted, answer: T) => vi.fn(() => { counted[name]++; return answer; });
  const { slot, rpc } = await renderWorkspace({
    getFileViews: count("getFileViews", { views: [] }),
    getDraft: count("getDraft", { draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewThreads: count("getReviewThreads", { threads: [] }),
    getFeedback: () => ({ feedback: null }),
    getReplyDrafts: () => ({ drafts: [] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = { ...counted, bundle: rpc.getReviewBundle.mock.calls.length };
  expect(slot.queryByText(/^Reconnecting…/)).toBeNull();
  await slot.setRealtimeConnectionState("reconnecting");
  expect(await slot.findByText(/^Reconnecting…/)).toBeTruthy();
  await slot.setRealtimeConnectionState("connected");
  await waitFor(() => expect(slot.queryByText(/^Reconnecting…/)).toBeNull());
  await waitFor(() => {
    expect(rpc.getReviewBundle.mock.calls.length).toBeGreaterThan(before.bundle);
    expect(counted.getFileViews).toBeGreaterThan(before.getFileViews);
    expect(counted.getDraft).toBeGreaterThan(before.getDraft);
    expect(counted.getReviewThreads).toBeGreaterThan(before.getReviewThreads);
  });
  slot.lifecycle.unmount();
});

test("notices go into a polite live region that's there before them, so a new one is announced", async () => {
  const checkForUpdates = vi.fn(() => ({ hasNewCommits: false }));
  const { slot } = await renderWorkspace({ checkForUpdates });
  await waitFor(() => expect(checkForUpdates).toHaveBeenCalled());
  expect(slot.queryByText("New commits since this guide was written.")).toBeNull();
  const regions = Array.from(slot.getByRole("main", { name: /^Review\b/ }).querySelectorAll('[aria-live="polite"]'));
  checkForUpdates.mockReturnValue({ hasNewCommits: true });
  await slot.emitRealtime("review:pr-42", {});
  const text = await slot.findByText("New commits since this guide was written.");
  expect(regions.some((region) => region.contains(text))).toBe(true);
  slot.lifecycle.unmount();
});

test("the opening review's placeholder says in words what it shows in shapes", async () => {
  const { ReviewSkeleton } = await import("./ReviewSkeleton");
  const slot = renderSlot({ component: () => <ReviewSkeleton /> }, {}, {});
  expect(slot.getByRole("status", { name: "Opening the review" }).textContent).toBe("Opening the review…");
  slot.lifecycle.unmount();
});

test("a local review whose code changed since its guide says so, with Update guide; with its switch off it never asks", async () => {
  const local = () => ({ review: { targetKey: "pr-42", kind: "ref", gitRef: "HEAD", cwd: "/repo", status: "ready", createdAt: 1, title: "HEAD" } });
  const checkForUpdates = vi.fn(() => ({ hasNewCommits: false, localChanged: true }));
  const { slot, rpc } = await renderWorkspace({ checkForUpdates }, local);
  const text = "The code changed since this guide.";
  await slot.findByText(text);
  fireEvent.click(within(notice(slot, text)).getByRole("button", { name: "Update guide" }));
  await waitFor(() => expect(rpc.rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
  cleanup();

  const off = vi.fn(() => ({ hasNewCommits: false, localChanged: true }));
  const quiet = await renderWorkspace({ checkForUpdates: off, getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, localDiffChanges: false } }, revision: 0 }) }, local);
  expect(off).not.toHaveBeenCalled();
  expect(quiet.slot.queryByText(text)).toBeNull();
  quiet.slot.lifecycle.unmount();
});
