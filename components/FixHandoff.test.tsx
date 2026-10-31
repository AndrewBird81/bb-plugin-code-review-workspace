// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";
import { defaultPreferences } from "../src/preferences";

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

async function renderTray(rpc: Record<string, unknown>, props: Record<string, unknown>, options: Record<string, unknown> = {}, drafted: readonly unknown[] = comments, body = "", knobs?: Partial<typeof defaultPreferences.knobs>) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { SettingsContext } = await import("../lib/settings");
  const draft = { targetKey: "k", verdict: "COMMENT", body, comments: drafted };
  const Tray = () => <DraftTray targetKey="k" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  // Settings as loaded, `knobs` changed.
  const preferences = { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, ...knobs } };
  const component = knobs ? () => <SettingsContext.Provider value={{ preferences, settled: Promise.resolve(preferences), fallback: preferences }}><Tray /></SettingsContext.Provider> : Tray;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [], discussions: [] }), setVerdict: () => ({ draft }), ...rpc } as any, ...options });
  await slot.findByText("Draft saved");
  return slot;
}

test("on your own PR, Fix in a new thread starts a thread with the comments you keep and links to it, leaving the draft", async () => {
  const startFixThread = vi.fn(async () => ({ ok: true, threadId: "t9", title: "Fix review comments: #12 Retry" }));
  const slot = await renderTray({ startFixThread }, { ownPr: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to fix" }));
  expect(picks.getByRole("checkbox", { name: /src\/a\.ts:2/ })).toHaveProperty("checked", true);
  fireEvent.click(picks.getByRole("checkbox", { name: /src\/b\.ts:9/ }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(startFixThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }));
  const started = await within(slot.getByRole("region", { name: "Fix in a new thread" })).findByRole("status");
  expect(started.textContent).toBe("Started a thread: Fix review comments: #12 Retry ↗");
  fireEvent.click(within(started).getByRole("button", { name: "Fix review comments: #12 Retry" }));
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

test("someone else's PR with no main thread doesn't offer it, and with no comments chosen it can't start", async () => {
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
const open = (over: Record<string, unknown> = {}) => () => ({ thread: { threadId: "coder", title: "Retry uploads", state: "open", machine: "MaxBook", ...over } });

test("a main thread with no title BB's list or the review knows is called Main thread", async () => {
  const slot = await renderTray({ getSourceThread: open({ title: null }) }, local);
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  expect(region.getByRole("button", { name: "Change main thread" }).closest("p")!.textContent).toBe("Main thread · MaxBook · Change main thread");
  slot.lifecycle.unmount();
});

test("a review with a main thread leads with Send N to it, by its title and machine, and a Send that queues says the thread is busy", async () => {
  const getSourceThread = vi.fn(open());
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "queued", title: "Retry uploads", threadId: "coder", sendN: 3 }));
  const panel = { view: null, open: vi.fn(), toggle: vi.fn(), close: vi.fn() };
  const slot = await renderTray({ getSourceThread, sendToSourceThread }, { ...local, workspace: { panel } });
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  expect(getSourceThread).toHaveBeenCalledWith({ targetKey: "k" });
  expect(region.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  const send = region.getByRole("button", { name: "Send 2 to main thread" });
  // Which thread that is, and where, under it: the review and its main thread can share a name; Change main thread opens its tab.
  expect(within(send.parentElement!.nextElementSibling as HTMLElement).getByText("Retry uploads").closest("p")!.textContent).toBe("Retry uploads · MaxBook · Change main thread");
  fireEvent.click(region.getByRole("button", { name: "Change main thread" }));
  expect(panel.open).toHaveBeenCalledWith("main");
  fireEvent.click(send);
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  fireEvent.click(picks.getByRole("checkbox", { name: /src\/b\.ts:9/ }));
  // An idle thread takes it now, and nothing in a local review is a draft to keep.
  expect(region.getByText(/^Sends them to/).textContent).toBe("Sends them to Retry uploads, each with an id it reports on. It won’t push until you say. Nothing goes to GitHub.");
  fireEvent.click(region.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }] }));
  const status = await region.findByRole("status");
  expect(status.textContent).toBe("Queued for Retry uploads: it’s busy, and gets 1 comment when its turn ends. · Watch · Main thread ↗");
  fireEvent.click(within(status).getByRole("button", { name: "Main thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder" });
  // Watch shows it beside the review instead, in BB's Main thread tab.
  panel.open.mockClear();
  fireEvent.click(within(status).getByRole("button", { name: "Watch" }));
  expect(panel.open.mock.calls).toEqual([["main"]]);
  slot.lifecycle.unmount();
});

test("a comment you reopened goes with the next Send, with its id; one you resolved or dismissed doesn't", async () => {
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder", sendN: 2 }));
  const drafted = [{ ...comments[0], id: "c3", state: "open", sendN: 1 }, { ...comments[1], id: "c4", state: "resolved", sendN: 1 }];
  const slot = await renderTray({ getSourceThread: open(), sendToSourceThread }, local, {}, drafted);
  fireEvent.click(await slot.findByRole("button", { name: "Send 1 to main thread" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Comments to send" })).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith(expect.objectContaining({ comments: [{ file: comments[0]!.file, line: comments[0]!.line, side: comments[0]!.side }] })));
  slot.lifecycle.unmount();
});

test("Send counts only the comments not sent yet, and Let it push when done is the review's, saved as you change it", async () => {
  const setLetPush = vi.fn(async () => ({ ok: true }));
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder", sendN: 1 }));
  const drafted = [comments[0], { ...comments[1], id: "c4", state: "sent", sendN: 1 }];
  const slot = await renderTray({ getSourceThread: open(), setLetPush, sendToSourceThread }, local, {}, drafted);
  fireEvent.click(await slot.findByRole("button", { name: "Send 1 to main thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  expect(picks.getAllByRole("checkbox", { name: /src\// })).toHaveLength(1);
  const push = picks.getByRole("checkbox", { name: "Let it push when done" });
  expect(push).toHaveProperty("checked", false);
  fireEvent.click(push);
  await waitFor(() => expect(setLetPush).toHaveBeenCalledWith({ targetKey: "k", letPush: true }));
  expect(picks.getByText(/It may push when it’s done\./)).toBeTruthy();
  fireEvent.click(picks.getByRole("button", { name: "Send" }));
  expect((await within(slot.getByRole("region", { name: "Send to the main thread" })).findByRole("status")).textContent).toBe("Sent 1 comment to Retry uploads. · Watch · Main thread ↗");
  slot.lifecycle.unmount();
});

test("Fix in a new thread that left out a comment not on GitHub yet says how to send it", async () => {
  const startFixThread = vi.fn(async () => ({ ok: true, threadId: "t9", title: "Fixes for web#12", keptLocal: 1 }));
  const slot = await renderTray({ startFixThread }, { ownPr: true });
  fireEvent.click(slot.getByRole("button", { name: "Fix in a new thread" }));
  fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
  expect((await within(slot.getByRole("region", { name: "Fix in a new thread" })).findByRole("status")).textContent)
    .toBe("Started a thread: Fixes for web#12 ↗. 1 isn’t on GitHub yet: change Main thread to a thread in its folder to send it.");
  slot.lifecycle.unmount();
  // With Send comments to the main thread off, there's no Change main thread: it says to turn it on.
  for (const [keptLocal, note] of [[1, "1 isn’t on GitHub yet. It stays in the draft: turn on Send comments to the main thread in Settings to send it to a thread in its folder."], [2, "2 aren’t on GitHub yet. They stay in the draft: turn on Send comments to the main thread in Settings to send them to a thread in their folder."]] as const) {
    const starting = vi.fn(async () => ({ ok: true, threadId: "t9", title: "Fixes for web#12", keptLocal }));
    const sendOff = await renderTray({ startFixThread: starting }, { ownPr: true }, {}, comments, "", { sendToThread: false });
    fireEvent.click(sendOff.getByRole("button", { name: "Fix in a new thread" }));
    fireEvent.click(sendOff.getByRole("button", { name: "Start thread" }));
    expect((await within(sendOff.getByRole("region", { name: "Fix in a new thread" })).findByRole("status")).textContent).toBe(`Started a thread: Fixes for web#12 ↗. ${note}`);
    sendOff.lifecycle.unmount();
    cleanup();
  }
});

test("a fixer's Send that left out a comment not on GitHub yet counts what went and says where that one goes", async () => {
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Fixes for web#12", threadId: "fixer", sendN: 1, keptLocal: 1 }));
  const slot = await renderTray({ getSourceThread: open({ title: "Fixes for web#12" }), sendToSourceThread }, local);
  fireEvent.click(await slot.findByRole("button", { name: "Send 2 to main thread" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Comments to send" })).getByRole("button", { name: "Send" }));
  expect((await within(slot.getByRole("region", { name: "Send to the main thread" })).findByRole("status")).textContent)
    .toBe("Sent 1 comment to Fixes for web#12. 1 isn’t on GitHub yet: change Main thread to a thread in its folder to send it. · Watch · Main thread ↗");
  slot.lifecycle.unmount();
});

test("a Send that warns says why and what it offers, and the choice sends it: anyway, unarchived, or to a fresh thread", async () => {
  const sendToSourceThread = vi.fn()
    .mockResolvedValueOnce({ ok: false, warning: "Retry uploads is archived. Unarchive it and send, or start a fresh thread in ~/src/api.", offers: ["unarchive", "fresh"], freshWhere: "in ~/src/api" })
    .mockResolvedValueOnce({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder", sendN: 1 });
  const slot = await renderTray({ getSourceThread: open({ state: "archived" }), sendToSourceThread }, local);
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  // Archived, it's still where Send goes, after your choice.
  expect(region.getByText(/, archived: Send offers to unarchive it or start a fresh thread\./)).toBeTruthy();
  fireEvent.click(region.getByRole("button", { name: "Send 2 to main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Send" }));
  const warning = await region.findByRole("alert");
  expect(warning.textContent).toContain("Retry uploads is archived. Unarchive it and send, or start a fresh thread in ~/src/api.");
  expect(within(warning).getByRole("button", { name: "Start a fresh thread" })).toBeTruthy();
  // Its choices are the only way on, and the form says where they send.
  expect(region.queryByRole("button", { name: "Send" })).toBeNull();
  expect(region.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  expect(region.getByText(/^Sends them to/).textContent).toBe("Sends them to Retry uploads once it’s unarchived, or to a fresh thread in ~/src/api, each with an id it reports on. It won’t push until you say. Nothing goes to GitHub.");
  fireEvent.click(within(warning).getByRole("button", { name: "Unarchive and send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenLastCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }, { file: "src/b.ts", line: 9, side: "LEFT" }], force: true, thread: "unarchive" }));
  expect((await region.findByRole("status")).textContent).toBe("Sent 2 comments to Retry uploads. · Watch · Main thread ↗");
  expect(region.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("a deleted main thread's warning says the comments go to a fresh thread, where it starts", async () => {
  const sendToSourceThread = vi.fn(async () => ({ ok: false, warning: "The main thread was deleted. Send starts a fresh thread in ~/src/docs.", offers: ["fresh"], freshWhere: "in ~/src/docs" }));
  const slot = await renderTray({ getSourceThread: () => ({ thread: { threadId: "coder", title: null, state: "gone" } }), sendToSourceThread }, local);
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Send 2 to main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Send" }));
  await region.findByRole("alert");
  expect(region.getByText(/^Sends them to/).textContent).toBe("Sends them to a fresh thread it starts in ~/src/docs, each with an id it reports on. It won’t push until you say. Nothing goes to GitHub.");
  expect(region.getAllByRole("button").map((button) => button.textContent)).toEqual(["Start a fresh thread", "Cancel"]);
  slot.lifecycle.unmount();
});

test("the picker shows each comment's first line as its card reads, and says a busy thread gets them after its turn", async () => {
  const drafted = [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "**Should fix:** `Date.now()` here is untestable." }];
  const slot = await renderTray({ getSourceThread: open() }, local, { sidebarThreads: { threads: [{ id: "coder", displayTitle: "Retry uploads", status: "active" }] } }, drafted);
  fireEvent.click(await slot.findByRole("button", { name: "Send 1 to main thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  const line = picks.getByRole("checkbox", { name: /src\/a\.ts:2/ }).nextElementSibling!.lastElementChild!;
  expect(line.textContent).toBe("Should fix: Date.now() here is untestable.");
  expect(line.querySelector("code")?.textContent).toBe("Date.now()");
  expect(picks.getByText(/^Sends them to/).textContent).toContain("Sends them to Retry uploads after its current turn, each with an id");
  slot.lifecycle.unmount();
});

test("on someone else's PR, Let it push when done pushes back once before it's on, and your draft for GitHub stays", async () => {
  const setLetPush = vi.fn(async () => ({ ok: true }));
  const teammate = { review: { targetKey: "k", kind: "pr", author: "alice", sourceThreadId: "coder" }, workspace: { mainThread: { threadId: "coder", title: "Retry uploads", machine: null } } };
  const slot = await renderTray({ getSourceThread: open(), setLetPush }, teammate);
  fireEvent.click(await slot.findByRole("button", { name: "Send 2 to main thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  expect(picks.getByText(/^Sends them to/).textContent).toContain("Nothing goes to GitHub, and your draft stays as it is.");
  fireEvent.click(picks.getByRole("checkbox", { name: "Let it push when done" }));
  const ask = picks.getByRole("alert");
  expect(ask.textContent).toContain("This is @alice’s PR: a push changes their branch.");
  expect(setLetPush).not.toHaveBeenCalled();
  expect(picks.getByRole("checkbox", { name: "Let it push when done" })).toHaveProperty("checked", false);
  fireEvent.click(within(ask).getByRole("button", { name: "Keep it off" }));
  expect(picks.queryByRole("alert")).toBeNull();
  fireEvent.click(picks.getByRole("checkbox", { name: "Let it push when done" }));
  fireEvent.click(within(picks.getByRole("alert")).getByRole("button", { name: "Let it push" }));
  await waitFor(() => expect(setLetPush).toHaveBeenCalledWith({ targetKey: "k", letPush: true }));
  expect(picks.getByRole("checkbox", { name: "Let it push when done" })).toHaveProperty("checked", true);
  slot.lifecycle.unmount();
});

test("on someone else's PR with a main thread, Send and Fix in a new thread warn first, and go anyway when you say", async () => {
  const warning = { ok: false, warning: "This is @alice’s PR, not yours. Your review on GitHub stays as it is.", offers: ["anyway"] };
  const sendToSourceThread = vi.fn().mockResolvedValueOnce(warning).mockResolvedValueOnce({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder" });
  const startFixThread = vi.fn().mockResolvedValueOnce({ ...warning, warning: `${warning.warning} Start a thread to fix it anyway?` });
  const teammate = { review: { targetKey: "k", kind: "pr", author: "alice", sourceThreadId: "coder" }, workspace: { mainThread: { threadId: "coder", title: "Retry uploads", machine: null } } };
  const slot = await renderTray({ getSourceThread: open(), sendToSourceThread, startFixThread }, teammate);
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Send 2 to main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Send" }));
  fireEvent.click(within(await region.findByRole("alert")).getByRole("button", { name: "Send anyway" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenLastCalledWith(expect.objectContaining({ force: true })));
  await region.findByRole("status");
  fireEvent.click(region.getByRole("button", { name: "Fix in a new thread" }));
  fireEvent.click(region.getByRole("button", { name: "Start thread" }));
  const alert = await region.findByRole("alert");
  expect(alert.textContent).toContain("Start a thread to fix it anyway?");
  expect(within(alert).getByRole("button", { name: "Start anyway" })).toBeTruthy();
  fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));
  expect(region.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("a main thread that was deleted still takes a Send, which starts a fresh thread, and a review no thread started never asks", async () => {
  const gone = await renderTray({ getSourceThread: () => ({ thread: { threadId: "coder", title: null, state: "gone" } }) }, local);
  await gone.findByText(/The main thread was deleted: Send starts a fresh thread\./);
  expect(gone.getByRole("button", { name: "Send 2 to main thread" })).toBeTruthy();
  gone.lifecycle.unmount();
  const getSourceThread = vi.fn();
  const none = await renderTray({ getSourceThread }, { isLocal: true });
  expect(none.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  expect(getSourceThread).not.toHaveBeenCalled();
  none.lifecycle.unmount();
});

test("with no comments to send, Send offers to tell the main thread you approve, once for the diff you reviewed", async () => {
  const getSourceThread = vi.fn(open());
  const sendApprovalToSourceThread = vi.fn(async () => ({ ok: true, delivery: "queued", title: "Retry uploads", threadId: "coder" }));
  const slot = await renderTray({ getSourceThread, sendApprovalToSourceThread }, local, {}, []);
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  expect(region.getByText(/^Tells it “Approved”/).textContent).toBe("Tells it “Approved”, with your message and the summary if you add them. Nothing goes to GitHub.");
  expect(region.queryByRole("button", { name: "Fix in a new thread" })).toBeNull();
  fireEvent.click(region.getByRole("button", { name: "Send approval to main thread" }));
  // It asks first, with nothing more to add than a message: the draft has no summary.
  const form = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(form.getByRole("textbox", { name: "Message (optional)" })).toBeTruthy();
  expect(form.queryByRole("checkbox")).toBeNull();
  expect(sendApprovalToSourceThread).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendApprovalToSourceThread).toHaveBeenCalledWith({ targetKey: "k", revision: "r1" }));
  const status = await region.findByRole("status");
  expect(status.textContent).toBe("Queued for Retry uploads: it’s busy, and gets your approval when its turn ends. · Watch · Main thread ↗");
  fireEvent.click(within(status).getByRole("button", { name: "Main thread" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder" });
  expect(region.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("an approval already sent for this diff isn't offered again, one for an older diff is, and a failed one says why", async () => {
  const approved = (revision: string) => ({ ...local, review: { ...local.review, approvalSent: { at: 1, threadId: "coder", title: "Retry uploads", revision } } });
  const same = await renderTray({ getSourceThread: open() }, approved("r1"), {}, []);
  const status = await within(await same.findByRole("region", { name: "Send to the main thread" })).findByRole("status");
  expect(status.textContent).toBe("Sent your approval to Retry uploads. · Watch · Main thread ↗");
  expect(same.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  same.lifecycle.unmount();
  const sendApprovalToSourceThread = vi.fn(async () => { throw new Error("Couldn’t send to the thread: The machine is offline."); });
  const older = await renderTray({ getSourceThread: open(), sendApprovalToSourceThread }, approved("r0"), {}, []);
  fireEvent.click(await older.findByRole("button", { name: "Send approval to main thread" }));
  fireEvent.click(older.getByRole("button", { name: "Send" }));
  expect((await older.findByRole("alert")).textContent).toBe("Couldn’t send to the thread: The machine is offline.");
  older.lifecycle.unmount();
  // With comments to send, they go as before.
  const commented = await renderTray({ getSourceThread: open() }, approved("r1"), {}, comments);
  expect(await commented.findByRole("button", { name: "Send 2 to main thread" })).toBeTruthy();
  expect(commented.queryByRole("button", { name: /^Send approval/ })).toBeNull();
  commented.lifecycle.unmount();
});

test("an approval can add your message and, when there is one, the summary, which isn't included until you check it", async () => {
  const sendApprovalToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder" }));
  const slot = await renderTray({ getSourceThread: open(), sendApprovalToSourceThread }, local, {}, [], "No blocking issues.");
  fireEvent.click(await slot.findByRole("button", { name: "Send approval to main thread" }));
  const form = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(form.getByRole("checkbox", { name: "Include the summary" })).toHaveProperty("checked", false);
  // Cancel puts the button back, and opening it again starts afresh.
  fireEvent.change(form.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "Draft words" } });
  fireEvent.click(form.getByRole("button", { name: "Cancel" }));
  expect(slot.queryByRole("group", { name: "Approval to send" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Send approval to main thread" }));
  const again = within(slot.getByRole("group", { name: "Approval to send" }));
  expect(again.getByRole("textbox", { name: "Message (optional)" })).toHaveProperty("value", "");
  fireEvent.change(again.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "  Ship it.  " } });
  fireEvent.click(again.getByRole("checkbox", { name: "Include the summary" }));
  fireEvent.click(again.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendApprovalToSourceThread).toHaveBeenCalledWith({ targetKey: "k", revision: "r1", message: "Ship it.", includeSummary: true }));
  expect((await within(slot.getByRole("region", { name: "Send to the main thread" })).findByRole("status")).textContent).toBe("Sent your approval to Retry uploads. · Watch · Main thread ↗");
  expect(slot.queryByRole("group", { name: "Approval to send" })).toBeNull();
  slot.lifecycle.unmount();
});

test("sending comments to the main thread can add your message and the summary; Fix in a new thread can't", async () => {
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "sent", title: "Retry uploads", threadId: "coder" }));
  const slot = await renderTray({ getSourceThread: open(), sendToSourceThread }, local, {}, comments, "Mostly fine.");
  const region = within(await slot.findByRole("region", { name: "Send to the main thread" }));
  fireEvent.click(region.getByRole("button", { name: "Fix in a new thread" }));
  const fix = within(slot.getByRole("group", { name: "Comments to fix" }));
  expect(fix.queryByRole("textbox")).toBeNull();
  expect(fix.queryByRole("checkbox", { name: "Include the summary" })).toBeNull();
  fireEvent.click(fix.getByRole("button", { name: "Cancel" }));
  fireEvent.click(region.getByRole("button", { name: "Send 2 to main thread" }));
  const picks = within(slot.getByRole("group", { name: "Comments to send" }));
  expect(picks.getByRole("checkbox", { name: "Include the summary" })).toHaveProperty("checked", false);
  fireEvent.change(picks.getByRole("textbox", { name: "Message (optional)" }), { target: { value: "Do these first." } });
  fireEvent.click(picks.getByRole("checkbox", { name: "Include the summary" }));
  fireEvent.click(picks.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith({ targetKey: "k", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT" }, { file: "src/b.ts", line: 9, side: "LEFT" }], message: "Do these first.", includeSummary: true }));
  slot.lifecycle.unmount();
});
