// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import type { ReviewItem } from "../lib/review-state";
import type { Turn } from "../lib/turn";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const DAY = 86_400_000;
const turn = (group: Turn["group"], reason: Turn["reason"], label = "", extra: Partial<Turn> = {}): Turn =>
  ({ group, reason, label, action: "", signal: null, at: null, notify: false, blocking: false, updated: false, eventAt: null, failed: false, ...extra });
const given = { targetKey: "given", kind: "pr", title: "Change Given", status: "ready", url: "https://github.com/acme/web/pull/7", submittedVerdict: "REQUEST_CHANGES", submittedAt: Date.now() - DAY, turn: turn("needs", "question", "Question for you") } as const;
const fresh = { targetKey: "fresh", kind: "pr", title: "Change Fresh", status: "tracked", turn: turn("needs", "requested", "Review requested") } as const;

/** Review actions for one review, over RPCs that record what they're asked. */
async function menu(review: ReviewItem, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { ReviewActions } = await import("./ReviewActions");
  const slot = renderSlot({ component: ReviewActions }, { review, ...props }, { rpc: {
    snoozeReview: () => ({ ok: true }), archiveReview: () => ({ ok: true }), pinReview: () => ({ ok: true }), startTrackedReview: () => ({ ok: true }),
  } as any });
  fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  return { slot, calls };
}

test("Review actions has the order of the design: guide, Snooze, Pin, Archive, then GitHub and the page's own, then Delete", async () => {
  const rebuild = vi.fn(), shortcuts = vi.fn();
  const { slot } = await menu(given, {
    pinnable: true,
    items: [{ label: "Rebuild guide", icon: "ArrowReloadHorizontal", onSelect: rebuild }],
    trailing: [{ label: "Keyboard shortcuts", icon: "CircleQuestion", keys: "?", onSelect: shortcuts }, { label: "Review settings…", icon: "Settings", onSelect: () => {} }],
  });
  await slot.findByRole("button", { name: "Snooze" });
  // The menu's, after its trigger, which shows only ⋯.
  const buttons = slot.getAllByRole("button").map((button) => button.textContent).filter((text) => text);
  expect(buttons).toEqual(["Rebuild guide", "Snooze", "Pin", "Archive", "Open on GitHub", "Keyboard shortcuts?", "Review settings…", "Delete…"]);
  expect(slot.queryByRole("button", { name: "Not yet" })).toBeNull();
  expect(slot.getByRole("button", { name: "Keyboard shortcuts" }).getAttribute("aria-keyshortcuts")).toBe("?");
  fireEvent.click(slot.getByRole("button", { name: "Keyboard shortcuts" }));
  expect(shortcuts).toHaveBeenCalledTimes(1);
  // Picking closes the menu.
  await waitFor(() => expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull());
});

test("a review you gave can wait until the author responds, which Undo takes back", async () => {
  const { slot, calls } = await menu(given);
  fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
  const choices = within(await slot.findByRole("group", { name: "Snooze" }));
  // The focus goes to the first choice.
  await waitFor(() => expect(document.activeElement).toBe(choices.getByRole("button", { name: "Until the author responds" })));
  fireEvent.click(choices.getByRole("button", { name: "Until the author responds" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }]));
  expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Snoozed until the author responds", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
  (vi.mocked(toast.success).mock.calls[0][1] as any).action.onClick();
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: true }, { targetKey: "given", snoozed: false }]));
});

test("a new request snoozes until a time, not until its author responds; Back returns to the menu", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  // A Wednesday morning.
  vi.setSystemTime(new Date(2026, 9, 14, 10, 0));
  const { snoozeTimes } = await import("../lib/turn");
  const { slot, calls } = await menu(fresh);
  fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
  const choices = within(await slot.findByRole("group", { name: "Snooze" }));
  expect(choices.getAllByRole("button").map((button) => button.textContent)).toEqual(["Later today1:00 PM", "Tomorrow9:00 AM", "Monday9:00 AM", "Pick a date…"]);
  fireEvent.click(slot.getByRole("button", { name: "Back to review actions" }));
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Snooze" })));
  fireEvent.click(slot.getByRole("button", { name: "Snooze" }));
  fireEvent.click(await slot.findByRole("button", { name: /^Tomorrow/ }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "fresh", snoozed: true, until: snoozeTimes().tomorrow }]));
});

test("Pick a date… snoozes until 9 AM on the day picked", async () => {
  const { slot, calls } = await menu(fresh);
  fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
  fireEvent.click(await slot.findByRole("button", { name: "Pick a date…" }));
  const box = await slot.findByLabelText("Snooze until a date");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(slot.getByRole("button", { name: "Snooze" }).hasAttribute("disabled")).toBe(true);
  // 44px targets on touch, an iPad's included.
  for (const control of [box, slot.getByRole("button", { name: "Snooze" })]) expect(control.className).toContain("pointer-coarse:h-11");
  fireEvent.change(box, { target: { value: "2099-03-02" } });
  fireEvent.click(slot.getByRole("button", { name: "Snooze" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "fresh", snoozed: true, until: new Date(2099, 2, 2, 9).getTime() }]));
});

test("a snoozed review goes back to Needs review instead; a failed, archived or local one offers no Snooze", async () => {
  let { slot, calls } = await menu({ ...given, turn: turn("waiting", "snoozed", "Not yet") });
  expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull();
  fireEvent.click(await slot.findByRole("button", { name: "Back to Needs review" }));
  await waitFor(() => expect(calls("snoozeReview")).toEqual([{ targetKey: "given", snoozed: false }]));
  slot.lifecycle.unmount();
  for (const review of [
    { ...given, status: "error", turn: turn("needs", "question", "Failed", { failed: true }) },
    { ...given, turn: turn("archive", "archived", "Archived"), userArchivedAt: 1 },
    { targetKey: "local", kind: "ref", gitRef: "main...x", status: "ready", turn: turn("needs", "new", "Ready") },
  ] as ReviewItem[]) {
    ({ slot } = await menu(review));
    await slot.findByRole("button", { name: "Delete…" });
    expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull();
    slot.lifecycle.unmount();
  }
});

test("Archive and Pin from the menu can be undone from their toast", async () => {
  const { slot, calls } = await menu(given, { pinnable: true });
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  await waitFor(() => expect(calls("archiveReview")).toEqual([{ targetKey: "given", archived: true }]));
  (vi.mocked(toast.success).mock.calls[0][1] as any).action.onClick();
  await waitFor(() => expect(calls("archiveReview")).toEqual([{ targetKey: "given", archived: true }, { targetKey: "given", archived: false }]));
  // Undoing isn't undone again.
  await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenLastCalledWith("Review unarchived", undefined));
  fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  fireEvent.click(await slot.findByRole("button", { name: "Pin" }));
  await waitFor(() => expect(calls("pinReview")).toEqual([{ targetKey: "given", pinned: true }]));
  expect(vi.mocked(toast.success)).toHaveBeenLastCalledWith("Pinned with your pinned threads", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
});

test("a tracked review builds its guide from the menu", async () => {
  const { slot, calls } = await menu(fresh);
  fireEvent.click(await slot.findByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(calls("startTrackedReview")).toEqual([{ targetKey: "fresh" }]));
});
