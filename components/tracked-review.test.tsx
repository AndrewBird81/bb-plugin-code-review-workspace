// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { snoozeLabel } from "../lib/turn";
import { findPicker } from "./provider-picker.test-support";

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

test("a renamed tracked review's bar says your name, and the PR's title shows above where it is", async () => {
  const slot = await reviewPage({ status: "tracked", name: "Row parsing", repo: "acme/web", number: 42 });
  expect(await slot.findByRole("heading", { level: 1, name: /Row parsing/ })).toBeTruthy();
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(within(section).getByText("PR title:").parentElement!.textContent).toBe("PR title: Parse rows");
  slot.lifecycle.unmount();
});

test("a tracked review says what reaches GitHub before you submit: a reply and a resolve", async () => {
  const slot = await reviewPage({ status: "tracked" });
  const section = await slot.findByRole("region", { name: "Tracked pull request" });
  expect(section.textContent).toContain("Nothing reaches GitHub until you submit, send a reply, or resolve a thread.");
  slot.lifecycle.unmount();
});

test("a tracked review's page bar goes back to All reviews and has the review's menu", async () => {
  const slot = await reviewPage({ status: "tracked", signals: { requestPending: true, requestedBy: "alice" } }, { startTrackedReview: () => ({ ok: true }) });
  const bar = within((await slot.findByRole("navigation", { name: "Breadcrumb" })).parentElement!);
  expect(bar.getByRole("heading", { level: 1, name: "pr-42 Parse rows" })).toBeTruthy();
  fireEvent.click(bar.getByRole("button", { name: "Review actions" }));
  const menu = within(await slot.findByRole("dialog"));
  // Pin once Settings say reviews show in BB's thread list.
  await waitFor(() => expect(menu.getAllByRole("button").map((button) => button.textContent).filter(Boolean)).toEqual(["Build the guide", "Snooze", "Pin", "Rename…", "Archive", "Open on GitHub", "Review settings…", "Delete…"]));
  fireEvent.click(menu.getByRole("button", { name: "Review settings…" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "review", options: { subPath: "settings/pr-42" } }]);
  fireEvent.click(bar.getByRole("button", { name: "All reviews" }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "review" });
  slot.lifecycle.unmount();
});

const machines = { machines: [{ hostId: "server", name: "Server", connected: true, server: true }, { hostId: "laptop", name: "Laptop", connected: true, server: false }] };

test("a tracked review's guide writer starts at Settings', and a pick, with its machine, goes to that build alone", async () => {
  const guideAgent = { providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" } as const;
  const startTrackedReview = vi.fn((_input: unknown) => ({ ok: false, error: "Not now." }));
  const savePreferences = vi.fn();
  const slot = await reviewPage({ status: "tracked" }, {
    getPreferences: () => ({ preferences: { ...defaultPreferences, guideAgent }, revision: 3 }),
    listMachines: () => machines, startTrackedReview, savePreferences,
  });
  const section = within(await slot.findByRole("region", { name: "Tracked pull request" }));
  const group = await section.findByRole("group", { name: "Guide writer" });
  const picker = await findPicker(within(group));
  expect((within(picker).getByRole("textbox", { name: "Provider ID" }) as HTMLInputElement).value).toBe("claude-code");
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("opus");
  expect(picker.dataset.routingKind).toBe("primary");
  // Left as it is, the guide is built on Settings' writer as before: no pick is sent.
  fireEvent.click(section.getByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(startTrackedReview).toHaveBeenCalledTimes(1));
  expect(startTrackedReview.mock.calls[0]![0]).toEqual({ targetKey: "pr-42" });
  // Another model, on the laptop: the picker lists the laptop's providers, and the guide is built there.
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "sonnet" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(within(group).getByRole("combobox", { name: "Machine" }), { target: { value: "laptop" } });
  await waitFor(() => expect(section.getByTestId("bb-provider-model-picker").dataset.routingId).toBe("laptop"));
  await waitFor(() => expect(section.getByRole("button", { name: "Build the guide" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(section.getByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(startTrackedReview).toHaveBeenCalledTimes(2));
  expect(startTrackedReview.mock.calls[1]![0]).toEqual({ targetKey: "pr-42", agent: { hostId: "laptop", providerId: "claude-code", model: "sonnet", reasoningLevel: "high" } });
  // Settings stay as they are.
  expect(savePreferences).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("with no guide writer in Settings, a tracked review's picker starts at its project's defaults, and one machine shows no machine choice", async () => {
  const defaults = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", permissionMode: "auto", serviceTier: "default" };
  const getAgentDefaults = vi.fn((_input: unknown) => ({ defaults }));
  const startTrackedReview = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = await reviewPage({ status: "tracked" }, {
    getAgentDefaults, startTrackedReview,
    listMachines: () => ({ machines: [{ hostId: "server", name: "Server", connected: true, server: true }] }),
  });
  const section = within(await slot.findByRole("region", { name: "Tracked pull request" }));
  const group = await section.findByRole("group", { name: "Guide writer" });
  const picker = await findPicker(within(group));
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  // The defaults of the project this review's agents run in.
  expect(getAgentDefaults).toHaveBeenCalledWith({ targetKey: "pr-42" });
  expect(within(group).queryByRole("combobox", { name: "Machine" })).toBeNull();
  fireEvent.change(within(picker).getByRole("textbox", { name: "Reasoning level" }), { target: { value: "high" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.click(section.getByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(startTrackedReview).toHaveBeenCalledWith({ targetKey: "pr-42", agent: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high", serviceTier: "default" } }));
  slot.lifecycle.unmount();
});

test("a guide that failed tries again on the guide writer picked there, for that build alone", async () => {
  const guideAgent = { providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "accept-edits" } as const;
  const rereview = vi.fn((_input: unknown) => ({ ok: false, error: "Not now." }));
  const slot = await reviewPage({ status: "error", guideError: { at: 1, text: "The guide writer failed." } }, {
    getPreferences: () => ({ preferences: { ...defaultPreferences, guideAgent }, revision: 3 }),
    listMachines: () => machines, rereview,
  });
  const failed = within(await slot.findByRole("alert"));
  const group = await failed.findByRole("group", { name: "Guide writer" });
  const picker = await findPicker(within(group));
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("opus");
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "sonnet" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(within(group).getByRole("combobox", { name: "Machine" }), { target: { value: "laptop" } });
  await waitFor(() => expect(failed.getByTestId("bb-provider-model-picker").dataset.routingId).toBe("laptop"));
  fireEvent.click(failed.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42", agent: { hostId: "laptop", providerId: "claude-code", model: "sonnet", reasoningLevel: "high" } }));
  slot.lifecycle.unmount();
});

test("while its guide is built, a review shows its title, its menu, and the agent at work", async () => {
  const slot = await reviewPage({ status: "generating" });
  const building = await slot.findByRole("status", { name: "Building the guide" });
  expect(building.textContent).toContain("You can leave: All reviews shows when it’s ready.");
  expect(within(building).getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42");
  expect(slot.getByRole("heading", { level: 1, name: "pr-42 Parse rows" })).toBeTruthy();
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

test("a guide that failed says what went wrong, in plain text, when it's known", async () => {
  const text = "Its last guide wasn't accepted:\nCoverage errors:\nmissing: src/a.ts is in the diff but not in the guide";
  const slot = await reviewPage({ status: "error", guideError: { at: 1, text } });
  const failed = await slot.findByRole("alert");
  const reason = within(failed).getByRole("region", { name: "What went wrong" });
  expect(reason.querySelector("p")?.textContent).toBe(text);
  expect(reason.querySelector("p")?.className).toContain("line-clamp-6");
  slot.lifecycle.unmount();
  // Unknown, it says nothing more.
  const unknown = await reviewPage({ status: "error" });
  expect(within(await unknown.findByRole("alert")).queryByRole("region", { name: "What went wrong" })).toBeNull();
  unknown.lifecycle.unmount();
});

test("a guide waiting for its writer's machine says it restarts on its own once that reconnects, with Try again, until the wait ends", async () => {
  const rereview = vi.fn(() => ({ ok: true }));
  let review: Record<string, unknown> = { status: "error", restartPending: { since: 1 } };
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", createdAt: 1, title: "Parse rows", ...review }, guide: null, patch: "", revision: "r1" }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    rereview,
  } as any });
  const waiting = (await slot.findByRole("heading", { name: "Waiting for the guide writer’s machine" })).closest<HTMLElement>("[role]")!;
  expect(waiting.getAttribute("role")).toBe("status");
  expect(waiting.textContent).toContain("The guide writer’s machine is offline. The guide restarts on its own when it reconnects.");
  expect(slot.queryByRole("alert")).toBeNull();
  fireEvent.click(within(waiting).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  // The wait ends without a restart: it failed after all.
  review = { status: "error", restartPending: null };
  await slot.emitRealtime("review:pr-42", {});
  const failed = await slot.findByRole("alert");
  expect(within(failed).getByRole("heading", { name: "Couldn’t build the guide" })).toBeTruthy();
  expect(slot.queryByText(/Waiting for the guide writer/)).toBeNull();
  slot.lifecycle.unmount();
});

test("Review not found leads with Back to your reviews, and Try again comes second", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: null, guide: null, patch: null, revision: "r0" }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
  } as any });
  const missing = await slot.findByRole("alert");
  expect(within(missing).getByRole("heading", { name: "Review not found" })).toBeTruthy();
  const [back, retry] = within(missing).getAllByRole("button");
  expect([back.textContent, retry.textContent]).toEqual(["Back to your reviews", "Try again"]);
  expect(retry.className).not.toBe(back.className);
  fireEvent.click(back);
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review" }));
  slot.lifecycle.unmount();
});
