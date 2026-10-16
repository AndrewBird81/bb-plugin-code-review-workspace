// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", body: "Rename this." },
  { file: "src/b.ts", line: 9, side: "LEFT", body: "Keep the check." },
];

async function renderTray(rpc: Record<string, unknown>, props: Record<string, unknown>, options: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const draft = { targetKey: "k", verdict: "COMMENT", body: "", comments };
  const component = () => <DraftTray targetKey="k" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [], discussions: [] }), setVerdict: () => ({ draft }), ...rpc } as any, ...options });
  await slot.findByText("Draft saved");
  return slot;
}

test("on your own PR, Fix in a new thread starts a thread with the comments you keep and links to it, leaving the draft", async () => {
  const startFixThread = vi.fn(async () => ({ threadId: "t9", title: "Fix review comments: #12 Retry" }));
  const slot = await renderTray({ startFixThread }, { ownPr: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to fix" }));
  expect(picks.getByRole("checkbox", { name: /src\/a\.ts:2/ })).toHaveProperty("checked", true);
  fireEvent.click(picks.getByRole("checkbox", { name: /src\/b\.ts:9/ }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(startFixThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }));
  const started = await within(slot.getByRole("region", { name: "Fix in a new thread" })).findByRole("status");
  expect(started.textContent).toBe("Started a thread: Fix review comments: #12 Retry · Open");
  fireEvent.click(within(started).getByRole("button", { name: "Open" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "t9" });
  // The draft is as it was.
  expect(slot.getAllByRole("button", { name: /^Draft · not submitted/ })).toHaveLength(2);
  // Opening it again starts from every comment, not the ones left out last time.
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  expect(within(slot.getByRole("group", { name: "Comments to fix" })).getByRole("checkbox", { name: /src\/b\.ts:9/ })).toHaveProperty("checked", true);
  slot.lifecycle.unmount();
});

test("a local review offers it too, and a failed start says why in the panel", async () => {
  const startFixThread = vi.fn(async () => { throw new Error("Couldn’t start the thread: The machine is offline."); });
  const slot = await renderTray({ startFixThread }, { isLocal: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Couldn’t start the thread: The machine is offline.");
  slot.lifecycle.unmount();
});

test("someone else's PR doesn't offer it, and with no comments chosen it can't start", async () => {
  const other = await renderTray({}, {});
  expect(other.queryByRole("button", { name: "Fix in a new thread" })).toBeNull();
  other.lifecycle.unmount();
  const own = await renderTray({}, { ownPr: true });
  fireEvent.click(own.getByRole("button", { name: "Fix in a new thread" }));
  for (const box of own.getAllByRole("checkbox")) fireEvent.click(box);
  expect(own.getByRole("button", { name: "Start thread" })).toHaveProperty("disabled", true);
  own.lifecycle.unmount();
});

const local = { review: { targetKey: "k", kind: "ref", gitRef: "HEAD", sourceThreadId: "coder" }, isLocal: true };

test("a review started with bb review in a thread leads with Send to that thread, by its title, with the same picker", async () => {
  const getSourceThread = vi.fn(() => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } }));
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "queued", title: "Retry uploads" }));
  const slot = await renderTray({ getSourceThread, sendToSourceThread }, local);
  const region = within(await slot.findByRole("region", { name: "Send to thread" }));
  expect(getSourceThread).toHaveBeenCalledWith({ targetKey: "k" });
  expect(region.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  fireEvent.click(region.getByRole("button", { name: "Send 2 comments to Retry uploads" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  fireEvent.click(picks.getByRole("checkbox", { name: /src\/b\.ts:9/ }));
  expect(region.getByText(/asks it to reply with what it changed\. Nothing goes to GitHub/)).toBeTruthy();
  fireEvent.click(region.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }));
  const status = await region.findByRole("status");
  expect(status.textContent).toBe("Queued in Retry uploads · Open");
  fireEvent.click(within(status).getByRole("button", { name: "Open" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder" });
  slot.lifecycle.unmount();
});

test("Send to thread names the thread as BB's thread list does, and Fix in a new thread beside it still starts one", async () => {
  const startFixThread = vi.fn(async () => ({ threadId: "t9", title: "Fix review comments: HEAD" }));
  const slot = await renderTray({ startFixThread, getSourceThread: () => ({ thread: { threadId: "coder", title: "Old title", state: "open" } }) }, local,
    { sidebarThreads: { threads: [{ id: "coder", displayTitle: "Retry uploads, renamed" }] } });
  const region = within(await slot.findByRole("region", { name: "Send to thread" }));
  expect(region.getByRole("button", { name: "Send 2 comments to Retry uploads, renamed" })).toBeTruthy();
  fireEvent.click(region.getByRole("button", { name: "Fix in a new thread" }));
  expect(slot.getByRole("group", { name: "Comments to fix" })).toBeTruthy();
  fireEvent.click(region.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(startFixThread).toHaveBeenCalled());
  slot.lifecycle.unmount();
});

test("a source thread that's archived or gone leaves Fix in a new thread, and says so", async () => {
  const archived = await renderTray({ getSourceThread: () => ({ thread: { threadId: "coder", title: "Old work", state: "archived" } }) }, local);
  await archived.findByText("Old work is archived.");
  expect(archived.queryByRole("button", { name: /^Send/ })).toBeNull();
  expect(archived.getByRole("region", { name: "Fix in a new thread" })).toBeTruthy();
  archived.lifecycle.unmount();
  const gone = await renderTray({ getSourceThread: () => ({ thread: { threadId: "coder", title: null, state: "gone" } }) }, local);
  await gone.findByText("The thread that made the change was deleted.");
  expect(gone.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  gone.lifecycle.unmount();
  // A review no thread started never asks.
  const getSourceThread = vi.fn();
  const none = await renderTray({ getSourceThread }, { isLocal: true });
  expect(none.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  expect(getSourceThread).not.toHaveBeenCalled();
  none.lifecycle.unmount();
});
