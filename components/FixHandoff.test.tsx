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

async function renderTray(rpc: Record<string, unknown>, props: Record<string, unknown>, options: Record<string, unknown> = {}, drafted: readonly unknown[] = comments, body = "") {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const draft = { targetKey: "k", verdict: "COMMENT", body, comments: drafted };
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
  const send = region.getByRole("button", { name: "Send 2 comments to Retry uploads" });
  // A word space before the title, not the button's gap, which is twice as wide (72-hands-on #4, 95-recheck): the label
  // and title share a span without a gap, and the label's trailing space is drawn.
  const title = within(send).getByText("Retry uploads");
  const label = title.previousElementSibling!;
  expect(title.parentElement).not.toBe(send);
  expect(title.parentElement!.className).not.toMatch(/\bgap-/);
  expect([label.textContent, label.className]).toEqual(["Send 2 comments to ", expect.stringContaining("whitespace-pre")]);
  fireEvent.click(send);
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

test("with no comments, Send to thread offers to tell the thread you approve, once for the diff you reviewed", async () => {
  const getSourceThread = vi.fn(() => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } }));
  const sendApprovalToSourceThread = vi.fn(async () => ({ ok: true, delivery: "queued", title: "Retry uploads" }));
  const slot = await renderTray({ getSourceThread, sendApprovalToSourceThread }, local, {}, []);
  const region = within(await slot.findByRole("region", { name: "Send to thread" }));
  expect(region.getByText(/Tells it “Approved”, with your message and the summary if you add them, after what it’s doing\. Nothing goes to GitHub/)).toBeTruthy();
  expect(region.queryByRole("button", { name: "Fix in a new thread" })).toBeNull();
  fireEvent.click(region.getByRole("button", { name: "Send approval to Retry uploads" }));
  // It asks first, with nothing more to add than a message: the draft has no summary.
  const form = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(form.getByRole("textbox", { name: "Message (optional)" })).toBeTruthy();
  expect(form.queryByRole("checkbox")).toBeNull();
  expect(sendApprovalToSourceThread).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendApprovalToSourceThread).toHaveBeenCalledWith({ targetKey: "k" }));
  const status = await region.findByRole("status");
  expect(status.textContent).toBe("Queued in Retry uploads · Open");
  fireEvent.click(within(status).getByRole("button", { name: "Open" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder" });
  expect(region.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("an approval already sent for this diff isn't offered again, one for an older diff is, and a failed one says why", async () => {
  const getSourceThread = () => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } });
  const approved = (revision: string) => ({ ...local, review: { ...local.review, approvalSent: { at: 1, threadId: "coder", title: "Retry uploads", revision } } });
  const same = await renderTray({ getSourceThread }, approved("r1"), {}, []);
  const status = await within(await same.findByRole("region", { name: "Send to thread" })).findByRole("status");
  expect(status.textContent).toBe("Sent to Retry uploads · Open");
  expect(same.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  same.lifecycle.unmount();
  const sendApprovalToSourceThread = vi.fn(async () => { throw new Error("Couldn’t send to the thread: The machine is offline."); });
  const older = await renderTray({ getSourceThread, sendApprovalToSourceThread }, approved("r0"), {}, []);
  fireEvent.click(await older.findByRole("button", { name: "Send approval to Retry uploads" }));
  fireEvent.click(older.getByRole("button", { name: "Send" }));
  expect((await older.findByRole("alert")).textContent).toBe("Couldn’t send to the thread: The machine is offline.");
  older.lifecycle.unmount();
  // With comments, they go as before.
  const commented = await renderTray({ getSourceThread }, approved("r1"), {}, comments);
  expect(await commented.findByRole("button", { name: "Send 2 comments to Retry uploads" })).toBeTruthy();
  expect(commented.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  commented.lifecycle.unmount();
});

test("an approval can add your message and, when there is one, the summary, which isn't included until you check it", async () => {
  const getSourceThread = () => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } });
  const sendApprovalToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads" }));
  const slot = await renderTray({ getSourceThread, sendApprovalToSourceThread }, local, {}, [], "No blocking issues.");
  fireEvent.click(await slot.findByRole("button", { name: "Send approval to Retry uploads" }));
  const form = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(form.getByRole("checkbox", { name: "Include the summary" })).toHaveProperty("checked", false);
  // Cancel puts the button back, and opening it again starts afresh.
  fireEvent.change(form.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "Draft words" } });
  fireEvent.click(form.getByRole("button", { name: "Cancel" }));
  expect(slot.queryByRole("group", { name: "Approval to send" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Send approval to Retry uploads" }));
  const again = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(again.getByRole("textbox", { name: "Message (optional)" })).toHaveProperty("value", "");
  fireEvent.change(again.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "  Ship it.  " } });
  fireEvent.click(again.getByRole("checkbox", { name: "Include the summary" }));
  fireEvent.click(again.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendApprovalToSourceThread).toHaveBeenCalledWith({ targetKey: "k", message: "Ship it.", includeSummary: true }));
  expect((await within(slot.getByRole("region", { name: "Send to thread" })).findByRole("status")).textContent).toBe("Sent to Retry uploads · Open");
  expect(slot.queryByRole("group", { name: "Approval to send" })).toBeNull();
  slot.lifecycle.unmount();
});

test("sending comments to the source thread can add your message and the summary; Fix in a new thread can't", async () => {
  const getSourceThread = () => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open" } });
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads" }));
  const slot = await renderTray({ getSourceThread, sendToSourceThread }, local, {}, comments, "Mostly fine.");
  const region = within(await slot.findByRole("region", { name: "Send to thread" }));
  fireEvent.click(region.getByRole("button", { name: "Fix in a new thread" }));
  const fix = within(slot.getByRole("group", { name: "Comments to fix" }));
  expect(fix.queryByRole("textbox")).toBeNull();
  expect(fix.queryByRole("checkbox", { name: "Include the summary" })).toBeNull();
  fireEvent.click(fix.getByRole("button", { name: "Cancel" }));
  fireEvent.click(region.getByRole("button", { name: "Send 2 comments to Retry uploads" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  expect(picks.getByRole("checkbox", { name: "Include the summary" })).toHaveProperty("checked", false);
  fireEvent.change(picks.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "Do these first." } });
  fireEvent.click(picks.getByRole("checkbox", { name: "Include the summary" }));
  fireEvent.click(picks.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }, { file: "src/b.ts", line: 9, side: "LEFT" }], message: "Do these first.", includeSummary: true }));
  slot.lifecycle.unmount();
});

test("with no comments and no open source thread, there's nothing to send", async () => {
  const getSourceThread = vi.fn(() => ({ thread: { threadId: "coder", title: "Old work", state: "archived" } }));
  const archived = await renderTray({ getSourceThread }, local, {}, []);
  await waitFor(() => expect(getSourceThread).toHaveBeenCalled());
  expect(archived.queryByRole("region", { name: "Send to thread" })).toBeNull();
  expect(archived.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  archived.lifecycle.unmount();
});
