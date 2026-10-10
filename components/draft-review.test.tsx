// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

async function renderTray(targetKey: string, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
  const component = () => <DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderTray>>;
const draftOf = (over: Record<string, unknown> = {}): Record<string, any> => ({ targetKey: "k", verdict: "COMMENT", body: "", comments: [] as any[], ...over });
const status = (slot: Slot) => within(slot.getByRole("region", { name: "Review draft" })).getAllByRole("status")[0];

/** Write a comment in the panel's Add comment form. */
function writeComment(slot: Slot, text: string) {
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: text } });
}

test("the status line follows saves: a failed submit's error clears when a later save works, and a failed save says so", async () => {
  let draft = draftOf({ body: "Summary." });
  let fail = false;
  const saveDraftComment = vi.fn(async ({ comment }: any) => {
    if (fail) throw new Error("Couldn’t reach the server.");
    draft = { ...draft, comments: [comment] };
    return { draft, stale: [], discussions: [] };
  });
  const submitReview = vi.fn(async () => ({ ok: false, error: "GitHub said no." }));
  const slot = await renderTray("status", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment, submitReview });
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  await waitFor(() => expect(status(slot).textContent).toBe("GitHub said no."));
  writeComment(slot, "One.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Draft saved"));
  fail = true;
  writeComment(slot, "Two.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Couldn’t reach the server."));
  slot.lifecycle.unmount();
});

test("Edit puts the cursor at the end of the comment, and of the summary", async () => {
  const draft = draftOf({ body: "The summary.", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "The comment." }] });
  const slot = await renderTray("cursor", { getDraft: () => ({ draft, stale: [], discussions: [] }) });
  fireEvent.click(slot.getByRole("button", { name: "Edit comment on src/a.ts:2" }));
  const box = slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect([box.selectionStart, box.selectionEnd]).toEqual([12, 12]);
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  fireEvent.click(slot.getByRole("button", { name: "Edit review summary" }));
  const summaryBox = slot.getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(summaryBox));
  expect([summaryBox.selectionStart, summaryBox.selectionEnd]).toEqual([12, 12]);
  slot.lifecycle.unmount();
});

test("Cmd/Ctrl+Enter runs a box's primary action when it has text, and Esc cancels without reaching the page", async () => {
  let draft = draftOf({ body: "Old summary." });
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const saveSummary = vi.fn(async ({ body }: any) => { draft = { ...draft, body }; return { draft, stale: [], discussions: [] }; });
  const askAgent = vi.fn(async () => ({ draft, stale: [], discussions: [] }));
  const slot = await renderTray("keys", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment, saveSummary, askAgent });
  const pageEscape = vi.fn();
  document.addEventListener("keydown", pageEscape);
  // The panel's Add comment form: empty, Ctrl+Enter does nothing; with text, it saves.
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Enter", ctrlKey: true });
  expect(saveDraftComment).not.toHaveBeenCalled();
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Saved by keyboard." } });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ body: "Saved by keyboard." }) })));
  await waitFor(() => expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull());
  // Esc cancels the form.
  writeComment(slot, "Never mind.");
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Escape" });
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  // The summary's editor.
  fireEvent.click(slot.getByRole("button", { name: "Edit review summary" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Review summary" }), { target: { value: "New summary." } });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Review summary" }), { key: "Enter", metaKey: true });
  await waitFor(() => expect(saveSummary).toHaveBeenCalledWith(expect.objectContaining({ body: "New summary." })));
  // An ask box sends to the agent, and Esc closes it.
  await waitFor(() => expect(slot.getByRole("button", { name: "Ask agent about the review summary" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Ask agent about the review summary" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Shorter?" } });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Message to agent" }), { key: "Enter", metaKey: true });
  await waitFor(() => expect(askAgent).toHaveBeenCalledWith(expect.objectContaining({ body: "Shorter?" })));
  await waitFor(() => expect(slot.getByRole("button", { name: "Ask agent about the review summary" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Ask agent about the review summary" }));
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Message to agent" }), { key: "Escape" });
  expect(slot.queryByRole("textbox", { name: "Message to agent" })).toBeNull();
  expect(pageEscape.mock.calls.some(([event]) => event.key === "Escape")).toBe(false);
  document.removeEventListener("keydown", pageEscape);
  slot.lifecycle.unmount();
});
