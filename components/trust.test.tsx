// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };
const outsider = { targetKey: "pr-42", kind: "pr", repo: "acme/web", number: 42, author: "mallory", authorAssociation: "FIRST_TIME_CONTRIBUTOR", createdAt: 1, title: "Parse rows", headSha: "sha1" };

function workspace(review: Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  return { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review, guide: review.status === "tracked" ? null : structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "pass", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getCheckFailures: () => ({ failures: [] }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  } as any };
}

test("the workspace says what didn't run on its own and why, and Run starts it", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const runSkipped = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace({ ...outsider, status: "ready", skippedRun: { run: "review", head: "sha1", at: 1 } }, { runSkipped }));
  const banner = await slot.findByRole("status", { name: "Not run automatically" });
  expect(banner.textContent).toContain("Not run automatically: @mallory isn’t a member of acme");
  fireEvent.click(slot.getByRole("button", { name: "Run review" }));
  await waitFor(() => expect(runSkipped).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  const { toast } = await import("sonner");
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Review started"));
  slot.lifecycle.unmount();
}, 15_000);

test("a run that can't start says why", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const runSkipped = vi.fn(() => ({ ok: false, error: "No coding agent is set up." }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace({ ...outsider, status: "ready", skippedRun: { run: "check", head: "sha1", at: 1 } }, { runSkipped }));
  fireEvent.click(await slot.findByRole("button", { name: "Run check" }));
  const { toast } = await import("sonner");
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No coding agent is set up."));
  expect(toast.success).not.toHaveBeenCalledWith("Check started");
  slot.lifecycle.unmount();
}, 15_000);

test("a check that didn't run offers Run check; nothing shows once everything ran or the review is archived", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace({ ...outsider, status: "ready", skippedRun: { run: "check", head: "sha1", at: 1 } }));
  await slot.findByRole("button", { name: "Run check" });
  slot.lifecycle.unmount();
  for (const review of [{ ...outsider, status: "ready" }, { ...outsider, status: "ready", archivedAt: 5, skippedRun: { run: "check", head: "sha1", at: 1 } }]) {
    slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace(review));
    await slot.findByText("Parses rows.");
    expect(slot.queryByRole("status", { name: "Not run automatically" })).toBeNull();
    slot.lifecycle.unmount();
  }
}, 15_000);

test("a guide update that didn't run offers Update guide, which is what it starts", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace({ ...outsider, status: "ready", skippedRun: { run: "guide", head: "sha2", at: 1 } }));
  const banner = await slot.findByRole("status", { name: "Not run automatically" });
  expect(within(banner).getByRole("button", { name: "Update guide" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a tracked PR whose guide didn't start on its own says why above Build the guide", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, workspace({ ...outsider, status: "tracked", skippedRun: { run: "guide", head: "sha1", at: 1 } }));
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(section.textContent).toContain("Not run automatically: @mallory isn’t a member of acme");
  expect(slot.getByRole("button", { name: "Build the guide" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a review list row says what didn't run on its own and why", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getGhAccounts: () => ({ active: "me", accounts: [] }),
    listReviews: () => ({ reviews: [{ ...outsider, status: "tracked", skippedRun: { run: "guide", head: "sha1", at: 1 } }, { ...outsider, targetKey: "pr-43", number: 43, title: "Trusted", status: "ready" }] }),
  } as any });
  await slot.findByText("Parse rows");
  expect(slot.getAllByText("Not run automatically: @mallory isn’t a member of acme")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("Settings choose whose PRs agents run on by themselves, and whether the review agent runs the repo's checks", async () => {
  await loadPluginApp(() => import("../app"));
  const { ReviewSettings } = await import("./ReviewSettings");
  const savePreferences = vi.fn(({ preferences }: any) => ({ preferences, revision: 1 }));
  const slot = renderSlot({ component: ReviewSettings }, {}, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    savePreferences,
  } as any });
  const members = await slot.findByRole("button", { name: "Members and collaborators" });
  expect(members.getAttribute("aria-pressed")).toBe("true");
  const checks = slot.getByRole("checkbox", { name: /Let the review agent run the repo’s tests and linters/ }) as HTMLInputElement;
  expect(checks.checked).toBe(false);
  expect(slot.getByText(/runs the PR’s code on the agent’s machine/i)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Anyone" }));
  fireEvent.click(checks);
  fireEvent.click(slot.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(savePreferences).toHaveBeenCalled());
  expect(savePreferences.mock.calls[0][0].preferences).toMatchObject({ unattendedAuthors: "anyone", runRepoChecks: true });
  slot.lifecycle.unmount();
});
