// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { snoozeLabel } from "../lib/turn";

afterEach(() => { cleanup(); });

/** A review's page before its guide shows: tracked, building, or failed. */
async function reviewPage(review: Record<string, unknown>, rpc: Record<string, (input: any) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", createdAt: 1, title: "Parse rows", url: "https://github.com/acme/web/pull/42", ...review }, guide: null, patch: "", revision: "r1" }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    ...rpc,
  } as any });
  return slot;
}

test("a snoozed tracked review says when it wakes, as the list does", async () => {
  const until = Date.now() + 3 * 86_400_000;
  const slot = await reviewPage({ status: "tracked", snoozedUntil: until, turn: { group: "waiting", reason: "snoozed", label: "Snoozed" } });
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(section.textContent).toContain(snoozeLabel(until));
  slot.lifecycle.unmount();
});

test("a tracked review says its size once, beside where it is and who wrote it", async () => {
  const slot = await reviewPage({ status: "tracked", repo: "acme/web", number: 42, author: "alice", prSize: { additions: 120, deletions: 30, files: 8 },
    signals: { requestPending: true, requestedBy: "alice" } });
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(within(section).getAllByText(/\+120 −30 · 8 files/)).toHaveLength(1);
  expect(within(section).getByText("Requested by @alice")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a tracked review's page bar goes back to All reviews and has the review's menu", async () => {
  const slot = await reviewPage({ status: "tracked", signals: { requestPending: true, requestedBy: "alice" } }, { startTrackedReview: () => ({ ok: true }) });
  const bar = within((await slot.findByRole("navigation", { name: "Breadcrumb" })).parentElement!);
  expect(bar.getByRole("heading", { level: 1 }).textContent).toBe("Parse rows");
  fireEvent.click(bar.getByRole("button", { name: "Review actions" }));
  const menu = within(await slot.findByRole("dialog"));
  // Pin once Settings say reviews show in BB's thread list.
  await waitFor(() => expect(menu.getAllByRole("button").map((button) => button.textContent).filter(Boolean)).toEqual(["Build the guide", "Snooze", "Pin", "Archive", "Open on GitHub", "Review settings…", "Delete…"]));
  fireEvent.click(menu.getByRole("button", { name: "Review settings…" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "settings/pr-42" } }]);
  fireEvent.click(bar.getByRole("button", { name: "All reviews" }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "review" });
  slot.lifecycle.unmount();
});

test("while its guide is built, a review shows its title, its menu, and the agent at work", async () => {
  const slot = await reviewPage({ status: "generating" });
  const building = await slot.findByRole("status", { name: "Building the guide" });
  expect(building.textContent).toContain("You can leave: All reviews shows when it’s ready.");
  expect(within(building).getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42");
  expect(slot.getByRole("heading", { level: 1 }).textContent).toBe("Parse rows");
  fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  // A guide being built can't be deleted.
  expect((await slot.findByRole("button", { name: "Delete…" })).hasAttribute("disabled")).toBe(true);
  slot.lifecycle.unmount();
});

test("a guide that failed says so, with Try again, its menu, and the PR on GitHub", async () => {
  const rereview = vi.fn(() => ({ ok: true }));
  const slot = await reviewPage({ status: "error" }, { rereview });
  const failed = await slot.findByRole("alert");
  expect(within(failed).getByRole("heading", { name: "Couldn’t build the guide" })).toBeTruthy();
  expect(within(failed).getByRole("link", { name: "Open on GitHub" })).toBeTruthy();
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect(slot.getByRole("button", { name: "Review actions" })).toBeTruthy();
  slot.lifecycle.unmount();
});
