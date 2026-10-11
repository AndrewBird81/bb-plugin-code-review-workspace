// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { commentsKey, SUMMARY_AT } from "../src/draft";
import type { DraftProviderProps } from "./DraftProvider";

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });

/** The draft's provider with its panel after what it wraps, as the workspace places them. */
async function draftTray() {
  const [{ DraftProvider }, { DraftPanel }] = await Promise.all([import("./DraftProvider"), import("./DraftPanel")]);
  return function DraftTray({ children, ...props }: DraftProviderProps) { return <DraftProvider {...props}>{children}<DraftPanel /></DraftProvider>; };
}

async function renderTray(targetKey: string, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  // "Show draft" stands in for the Feedback view's Use as draft, and the top bar's Submit review.
  const component = () => {
    const [showDraft, setShowDraft] = useState<{ at: number }>();
    return <><button onClick={() => setShowDraft({ at: Date.now() })}>Show draft</button><DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" showDraft={showDraft} {...props} /></>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  if (!props.review) await slot.findByText("Draft saved");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderTray>>;
// A suggested verdict's name says so after the verdict: "Approve, suggested by the agent".
const verdict = (slot: Slot, name: string) => within(slot.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: new RegExp(`^${name}`) });
const pressed = (slot: Slot, name: string) => verdict(slot, name).getAttribute("aria-pressed");
const summary = (slot: Slot) => within(slot.getByRole("region", { name: "Review summary" }));
const draftOf = (over: Record<string, unknown> = {}): Record<string, any> => ({ targetKey: "k", verdict: "COMMENT", body: "", comments: [] as any[], ...over });
const comment = { file: "src/a.ts", line: 2, side: "RIGHT", body: "Stale after a write?" };

test("the draft's verdict and summary reload when they change elsewhere", async () => {
  let draft = draftOf();
  const slot = await renderTray("sum", { getDraft: () => ({ draft }) });
  draft = { ...draft, verdict: "REQUEST_CHANGES", body: "Two asks remain.", bodyAuthor: "agent" };
  await slot.emitRealtime("draft:sum", {});
  await summary(slot).findByText("Two asks remain.");
  expect(summary(slot).getByText("Added by agent")).toBeTruthy();
  expect(pressed(slot, "Request changes")).toBe("true");
  slot.lifecycle.unmount();
});

test("editing the agent's summary saves it as yours", async () => {
  let draft = draftOf({ body: "Agent words", bodyAuthor: "agent" });
  const saveSummary = vi.fn(({ body }: any) => { draft = draftOf({ body }); return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("edit", { getDraft: () => ({ draft }), saveSummary });
  fireEvent.click(summary(slot).getByRole("button", { name: "Edit review summary" }));
  const box = summary(slot).getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Agent words");
  fireEvent.change(box, { target: { value: "My words" } });
  fireEvent.click(summary(slot).getByRole("button", { name: "Save summary" }));
  await waitFor(() => expect(saveSummary).toHaveBeenCalledWith({ targetKey: "edit", body: "My words", revision: "r1" }));
  await summary(slot).findByText("My words");
  expect(summary(slot).queryByText("Added by agent")).toBeNull();
  expect(summary(slot).queryByRole("textbox")).toBeNull();
  slot.lifecycle.unmount();
});

test("Remove clears the summary", async () => {
  let draft = draftOf({ body: "Old words" });
  const saveSummary = vi.fn(({ body }: any) => { draft = draftOf({ body }); return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("remove", { getDraft: () => ({ draft }), saveSummary });
  fireEvent.click(summary(slot).getByRole("button", { name: "Remove review summary" }));
  await waitFor(() => expect(saveSummary).toHaveBeenCalledWith({ targetKey: "remove", body: "", revision: "r1" }));
  await summary(slot).findByRole("button", { name: "Write summary" });
  slot.lifecycle.unmount();
});

test("picking a verdict saves only the verdict, and the agent's suggestion is marked", async () => {
  let draft = draftOf({ body: "Needs a test.", bodyAuthor: "agent", suggestedVerdict: "REQUEST_CHANGES" });
  const setVerdict = vi.fn(({ verdict }: any) => { draft = { ...draft, verdict, verdictChosen: true }; return { draft }; });
  const slot = await renderTray("verdict", { getDraft: () => ({ draft }), setVerdict });
  expect(slot.getByText("Agent suggests Request changes")).toBeTruthy();
  fireEvent.click(verdict(slot, "Approve"));
  expect(pressed(slot, "Approve")).toBe("true");
  await waitFor(() => expect(setVerdict).toHaveBeenCalledWith({ targetKey: "verdict", verdict: "APPROVE", revision: "r1" }));
  // A summary the agent wrote for another verdict says so.
  draft = { ...draft, written: { verdict: "REQUEST_CHANGES", comments: commentsKey([]) } };
  await slot.emitRealtime("draft:verdict", {});
  await slot.findByText("Written for Request changes; you chose Approve.");
  fireEvent.click(verdict(slot, "Request changes"));
  await waitFor(() => expect(slot.queryByText(/Written for/)).toBeNull());
  expect(slot.queryByText("Agent suggests Request changes")).toBeNull();
  slot.lifecycle.unmount();
});

test("Ask agent on the summary talks in its discussion, and Undo puts the agent's change back", async () => {
  let draft = draftOf({ body: "Long summary.", bodyAuthor: "agent" });
  const discussion = (extra: Record<string, unknown> = {}) => ({ ...SUMMARY_AT, waiting: false, entries: [
    { author: "reviewer", kind: "message", body: "Shorter, please.", createdAt: 1 },
    { author: "agent", kind: "edited", body: "Short.", createdAt: 2 },
    { author: "agent", kind: "message", body: "Cut it down.", createdAt: 3 },
  ], ...extra });
  const askAgent = vi.fn(() => { draft = { ...draft, body: "Short." }; return { draft, stale: [], discussions: [discussion({ undoable: true })] }; });
  const undoAgentChange = vi.fn(() => {
    draft = { ...draft, body: "Long summary." };
    const restored = discussion();
    restored.entries.push({ author: "reviewer", kind: "restored", body: "", createdAt: 4 });
    return { draft, stale: [], discussions: [restored] };
  });
  const slot = await renderTray("ask", { getDraft: () => ({ draft }), askAgent, undoAgentChange });
  fireEvent.click(summary(slot).getByRole("button", { name: "Ask agent about the review summary" }));
  fireEvent.change(summary(slot).getByRole("textbox", { name: "Message to agent" }), { target: { value: "Shorter, please." } });
  fireEvent.click(summary(slot).getByRole("button", { name: "Send to agent" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "ask", file: "", line: 0, side: "RIGHT", body: "Shorter, please." }));
  await summary(slot).findByText("Agent edited the summary.");
  expect(summary(slot).getByText("Short.")).toBeTruthy();
  fireEvent.click(summary(slot).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(undoAgentChange).toHaveBeenCalledWith({ targetKey: "ask", file: "", line: 0, side: "RIGHT" }));
  await summary(slot).findByText("You undid that change.");
  expect(summary(slot).getByText("Long summary.")).toBeTruthy();
  expect(summary(slot).queryByRole("button", { name: "Undo" })).toBeNull();
  slot.lifecycle.unmount();
});

test("an agent's summary written before your comments changed offers to update it", async () => {
  const draft = draftOf({ body: "One issue.", bodyAuthor: "agent", written: { verdict: null, comments: commentsKey([]) }, comments: [comment] });
  const askAgent = vi.fn(() => ({ draft, stale: [], discussions: [{ ...SUMMARY_AT, waiting: true, entries: [{ author: "reviewer", kind: "message", body: "x", createdAt: 1 }] }] }));
  const slot = await renderTray("outdated", { getDraft: () => ({ draft }), askAgent });
  expect(summary(slot).getByText("Your comments changed since the agent wrote this.")).toBeTruthy();
  fireEvent.click(summary(slot).getByRole("button", { name: "Update" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "outdated", ...SUMMARY_AT, body: "My comments changed since you wrote this summary. Update it to match them." }));
  // While the agent works on it, the hint steps aside.
  await summary(slot).findByText("Waiting for agent…");
  expect(summary(slot).queryByText("Your comments changed since the agent wrote this.")).toBeNull();
  slot.lifecycle.unmount();
});

test("without a summary, you write it or ask the agent to, and Request changes waits for one", async () => {
  const draft = draftOf();
  const askAgent = vi.fn(() => ({ draft, stale: [], discussions: [] }));
  const setVerdict = vi.fn(({ verdict }: any) => ({ draft: { ...draft, verdict, verdictChosen: true } }));
  const slot = await renderTray("empty", { getDraft: () => ({ draft }), askAgent, setVerdict });
  fireEvent.click(summary(slot).getByRole("button", { name: "Ask agent to write it" }));
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith({ targetKey: "empty", ...SUMMARY_AT, body: "Write the review summary." }));
  fireEvent.click(verdict(slot, "Request changes"));
  await slot.findByText("Requesting changes needs a summary: say what has to change.");
  expect(slot.getByRole("button", { name: "Submit to GitHub" }).hasAttribute("disabled")).toBe(true);
  slot.lifecycle.unmount();
});

test("showDraft opens Draft review at the summary", async () => {
  const draft = draftOf({ verdict: "APPROVE", body: "Looks good now." });
  localStorage.setItem("gr:panelstate", JSON.stringify({ perReview: { show: { activeTool: "notes", toolsOpen: false } } }));
  const slot = await renderTray("show", { getDraft: () => ({ draft }) });
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  expect(draftTool.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: "Show draft" }));
  await waitFor(() => expect(draftTool.getAttribute("aria-pressed")).toBe("true"));
  expect(summary(slot).getByText("Looks good now.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("region", { name: "Review summary" })));
  slot.lifecycle.unmount();
});

test("a submitted review's receipt names its verdict", async () => {
  const draft = draftOf();
  const slot = await renderTray("done", { getDraft: () => ({ draft }) }, { review: { targetKey: "done", submittedVerdict: "REQUEST_CHANGES", submittedHeadSha: "a", headSha: "b" } });
  const receipt = await slot.findByRole("region", { name: "Submitted review" });
  expect(within(receipt).getByText("Changes requested")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a line comment after the summary's box starts on a real line", async () => {
  const draft = draftOf({ body: "Words." });
  const slot = await renderTray("after", { getDraft: () => ({ draft }) });
  fireEvent.click(summary(slot).getByRole("button", { name: "Edit review summary" }));
  fireEvent.click(summary(slot).getByRole("button", { name: "Cancel" }));
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  expect((slot.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement).value).toBe("src/a.ts");
  expect((slot.getByRole("spinbutton", { name: "Comment line" }) as HTMLInputElement).value).toBe("1");
  // With the summary's box open but empty, Add comment opens the panel's box instead.
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  fireEvent.click(summary(slot).getByRole("button", { name: "Edit review summary" }));
  fireEvent.change(summary(slot).getByRole("textbox", { name: "Review summary" }), { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  expect(slot.getByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  expect(summary(slot).queryByRole("textbox")).toBeNull();
  slot.lifecycle.unmount();
});

test("a line comment's box never turns into the summary's, even with its location cleared", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const slot = renderSlot({ component: () => <DraftTray targetKey="clear" activeChapterId="c1" activeFiles={[]} reviewRevision="r1" /> }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getDraft: () => ({ draft: draftOf() }) } as any });
  await slot.findByText("Draft saved");
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "A line comment" } });
  fireEvent.change(slot.getByRole("spinbutton", { name: "Comment line" }), { target: { value: "" } });
  expect((slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("A line comment");
  expect(summary(slot).queryByRole("textbox")).toBeNull();
  expect(slot.queryByRole("button", { name: "Save summary" })).toBeNull();
  slot.lifecycle.unmount();
});

test("agreeing a suggestion replaces your summary closes its box; just opening the draft keeps it", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  let draft = draftOf({ body: "Mine." });
  const component = () => {
    const [showDraft, setShowDraft] = useState<{ at: number; replaced?: boolean }>();
    return <>
      <button onClick={() => setShowDraft({ at: Date.now() })}>Open draft</button>
      <button onClick={() => { draft = draftOf({ body: "The assistant's.", bodyAuthor: "agent" }); setShowDraft({ at: Date.now(), replaced: true }); }}>Replace summary</button>
      <DraftTray targetKey="replace" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" showDraft={showDraft} />
    </>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft }) } as any });
  await slot.findByText("Draft saved");
  fireEvent.click(summary(slot).getByRole("button", { name: "Edit review summary" }));
  fireEvent.change(summary(slot).getByRole("textbox", { name: "Review summary" }), { target: { value: "Mine, unsaved." } });
  fireEvent.click(slot.getByRole("button", { name: "Open draft" }));
  expect((summary(slot).getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("Mine, unsaved.");
  fireEvent.click(slot.getByRole("button", { name: "Replace summary" }));
  await summary(slot).findByText("The assistant's.");
  expect(summary(slot).queryByRole("textbox")).toBeNull();
  slot.lifecycle.unmount();
});

test("while the agent works on the summary, Edit waits; a change under an open edit is flagged; Undo waits for the box", async () => {
  let draft = draftOf({ body: "Agent's first.", bodyAuthor: "agent" });
  let discussions: any[] = [{ ...SUMMARY_AT, waiting: true, undoable: true, entries: [
    { author: "reviewer", kind: "message", body: "Shorter?", createdAt: 1 }, { author: "agent", kind: "edited", body: "Agent's first.", createdAt: 2 },
  ] }];
  const slot = await renderTray("waiting", { getDraft: () => ({ draft, stale: [], discussions }) });
  expect(summary(slot).getByRole("button", { name: "Edit review summary" }).hasAttribute("disabled")).toBe(true);
  expect(summary(slot).getByRole("button", { name: "Remove review summary" }).hasAttribute("disabled")).toBe(true);
  discussions = [{ ...discussions[0], waiting: false }];
  await slot.emitRealtime("draft:waiting", {});
  await waitFor(() => expect(summary(slot).getByRole("button", { name: "Edit review summary" }).hasAttribute("disabled")).toBe(false));
  expect(summary(slot).getByRole("button", { name: "Undo" })).toBeTruthy();
  fireEvent.click(summary(slot).getByRole("button", { name: "Edit review summary" }));
  expect(summary(slot).queryByRole("button", { name: "Undo" })).toBeNull();
  draft = { ...draft, body: "Agent's second." };
  await slot.emitRealtime("draft:waiting", {});
  await summary(slot).findByText("The summary changed while you were editing. Saving replaces it.");
  slot.lifecycle.unmount();
});

test("a verdict you just picked holds through a refresh that started before it", async () => {
  let held: ((value: unknown) => void) | null = null;
  let hold = false;
  const getDraft = vi.fn(() => hold ? new Promise((resolve) => { held = resolve; }) : { draft: draftOf() });
  let saved: ((value: unknown) => void) | null = null;
  const setVerdict = vi.fn(() => new Promise((resolve) => { saved = resolve; }));
  const slot = await renderTray("hold", { getDraft, setVerdict });
  // A refresh is reading the draft when you pick a verdict; it comes back with the old one before the verdict is saved.
  hold = true;
  await slot.emitRealtime("draft:hold", {});
  await waitFor(() => expect(held).toBeTypeOf("function"));
  fireEvent.click(verdict(slot, "Approve"));
  held!({ draft: draftOf() });
  await waitFor(() => expect(setVerdict).toHaveBeenCalledWith({ targetKey: "hold", verdict: "APPROVE", revision: "r1" }));
  expect(pressed(slot, "Approve")).toBe("true");
  saved!({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pressed(slot, "Approve")).toBe("true");
  slot.lifecycle.unmount();
});

test("the agent's suggestion is in the verdict's name for screen readers", async () => {
  const slot = await renderTray("named", { getDraft: () => ({ draft: draftOf({ suggestedVerdict: "REQUEST_CHANGES" }) }) });
  expect(within(slot.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: "Request changes, suggested by the agent" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("summary text kept from before this update waits for the box, then opens in it", async () => {
  sessionStorage.setItem("guided-review:draft-recovery:kept", JSON.stringify({
    composer: { file: "src/a.ts", line: "1", side: "RIGHT", body: "An unfinished comment" },
    summary: { verdict: "COMMENT", body: "An unsaved summary", revision: "r1" },
  }));
  const slot = await renderTray("kept", { getDraft: () => ({ draft: draftOf() }) });
  expect((slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("An unfinished comment");
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect((summary(slot).getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("An unsaved summary");
  expect(JSON.parse(sessionStorage.getItem("guided-review:draft-recovery:kept")!)).toEqual({ composer: expect.objectContaining({ body: "An unsaved summary", summary: true }) });
  slot.lifecycle.unmount();
});
