// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

async function renderTray(targetKey: string, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const component = () => <DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" {...props} />;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderTray>>;
const draftOf = (over: Record<string, unknown> = {}): Record<string, any> => ({ targetKey: "k", verdict: "COMMENT", body: "", comments: [] as any[], ...over });
const status = (slot: Slot) => within(slot.getByRole("region", { name: "Review draft" })).getAllByRole("status")[0];

/** Comments' ⋯ Add comment by line…: the form to write a comment at a file and line. */
async function addComment(slot: Slot) {
  fireEvent.click(slot.getByRole("button", { name: "Comment options" }));
  fireEvent.click(await slot.findByRole("button", { name: "Add comment by line…" }));
}
/** Write a comment in Comments' Add comment by line form. */
async function writeComment(slot: Slot, text: string) {
  await addComment(slot);
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: text } });
}
/**
 * Saving a comment focuses its row a frame later. Wait for it before opening ⋯ again: focus leaving the open menu closes
 * it, and Add comment by line… is then clicked gone.
 */
const savedFocus = (at: string) => waitFor(() => expect(document.activeElement?.getAttribute("data-comment-at")).toBe(at));
/** A comment's row in Comments, which opens as its card to edit or remove it. */
const row = (where: string) => `Draft · not submitted · ${where}`;
const expand = (slot: Slot, where: string) => fireEvent.click(slot.getByRole("button", { name: `Expand Draft comment on ${where}` }));
const submit = (slot: Slot) => slot.getByRole("button", { name: /^Submit to GitHub/ });

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
  fireEvent.click(submit(slot));
  await waitFor(() => expect(status(slot).textContent).toBe("GitHub said no."));
  await writeComment(slot, "One.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Draft saved"));
  await savedFocus("src/a.ts:1:RIGHT");
  fail = true;
  await writeComment(slot, "Two.");
  fireEvent.click(slot.getByRole("button", { name: "Replace comment" }));
  await waitFor(() => expect(status(slot).textContent).toBe("Couldn’t reach the server."));
  slot.lifecycle.unmount();
});

test("Edit puts the cursor at the end of the comment, and of the summary", async () => {
  const draft = draftOf({ body: "The summary.", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "The comment." }] });
  const slot = await renderTray("cursor", { getDraft: () => ({ draft, stale: [], discussions: [] }) });
  expand(slot, "src/a.ts:2");
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

test("Cmd/Ctrl+Enter runs a box's primary action when it has text; Esc keeps text you wrote, closes a box with none, and doesn't reach the page", async () => {
  let draft = draftOf({ body: "Old summary." });
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const saveSummary = vi.fn(async ({ body }: any) => { draft = { ...draft, body }; return { draft, stale: [], discussions: [] }; });
  const askAgent = vi.fn(async () => ({ draft, stale: [], discussions: [] }));
  const slot = await renderTray("keys", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment, saveSummary, askAgent });
  const pageEscape = vi.fn();
  document.addEventListener("keydown", pageEscape);
  // The panel's Add comment form: empty, Ctrl+Enter does nothing; with text, it saves.
  await addComment(slot);
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Enter", ctrlKey: true });
  expect(saveDraftComment).not.toHaveBeenCalled();
  fireEvent.change(slot.getByRole("textbox", { name: "Draft comment" }), { target: { value: "Saved by keyboard." } });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ body: "Saved by keyboard." }) })));
  await waitFor(() => expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull());
  await savedFocus("src/a.ts:1:RIGHT");
  // Esc leaves the box, keeping what you wrote; Cancel discards it.
  await writeComment(slot, "Never mind.");
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Draft comment" }), { key: "Escape" });
  expect((slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Never mind.");
  expect(document.activeElement).not.toBe(slot.getByRole("textbox", { name: "Draft comment" }));
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  // The summary's editor: holding only the summary it edits, it closes on Esc.
  fireEvent.click(slot.getByRole("button", { name: "Edit review summary" }));
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Review summary" }), { key: "Escape" });
  expect(slot.queryByRole("textbox", { name: "Review summary" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Edit review summary" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Review summary" }), { target: { value: "New summary." } });
  fireEvent.keyDown(slot.getByRole("textbox", { name: "Review summary" }), { key: "Escape" });
  expect((slot.getByRole("textbox", { name: "Review summary" }) as HTMLTextAreaElement).value).toBe("New summary.");
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

test("only old-side comments carry a side badge, and the form's sides are New and Old", async () => {
  const draft = draftOf({ comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "New side." }, { file: "src/a.ts", line: 1, side: "LEFT", body: "Old side." }] });
  const slot = await renderTray("side", { getDraft: () => ({ draft, stale: [], discussions: [] }) });
  expect(slot.getByRole("button", { name: row("src/a.ts:2") })).toBeTruthy();
  expect(slot.getByRole("button", { name: row("src/a.ts:1 (old line)") })).toBeTruthy();
  expect(slot.queryByText("Changed")).toBeNull();
  expect(slot.getAllByText("Old line")).toHaveLength(1);
  await addComment(slot);
  const side = slot.getByRole("combobox", { name: "Comment side" });
  expect(within(side).getAllByRole("option").map((option) => option.textContent)).toEqual(["New line", "Old line"]);
  slot.lifecycle.unmount();
});

test("line comments list in the review's order: chapter by chapter, then file, line, and side", async () => {
  const at = (file: string, line: number, side = "RIGHT") => ({ file, line, side, body: `${file}:${line}:${side}` });
  const draft = draftOf({ comments: [at("src/z.ts", 1), at("src/a.ts", 3), at("src/b.ts", 5), at("src/a.ts", 1), at("src/b.ts", 2), at("src/a.ts", 1, "LEFT")] });
  // src/b.ts is in the first chapter, src/a.ts in the second; src/z.ts in none.
  const slot = await renderTray("order", { getDraft: () => ({ draft, stale: [], discussions: [] }) }, { files: ["src/b.ts", "src/a.ts"] });
  const list = slot.getAllByRole("button", { name: /^Draft · not submitted · src\// }).map((button) => button.getAttribute("aria-label"));
  expect(list).toEqual(["src/b.ts:2", "src/b.ts:5", "src/a.ts:1 (old line)", "src/a.ts:1", "src/a.ts:3", "src/z.ts:1"].map(row));
  slot.lifecycle.unmount();
});

test("the Add comment form picks from the review's files, and says why the server refused a line", async () => {
  const saveDraftComment = vi.fn(async () => { throw new Error("src/b.ts:99 isn’t in the current diff. Choose a line the diff shows."); });
  const slot = await renderTray("outside", { getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment }, { files: ["src/a.ts", "src/b.ts"] });
  await writeComment(slot, "Out of range.");
  const file = slot.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement;
  expect(within(file).getAllByRole("option").map((option) => option.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(file.value).toBe("src/a.ts");
  fireEvent.change(file, { target: { value: "src/b.ts" } });
  fireEvent.change(slot.getByRole("spinbutton", { name: "Comment line" }), { target: { value: "99" } });
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  const form = within(slot.getByRole("textbox", { name: "Draft comment" }).parentElement!);
  expect((await form.findByRole("alert")).textContent).toBe("src/b.ts:99 isn’t in the current diff. Choose a line the diff shows.");
  expect((slot.getByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement).value).toBe("Out of range.");
  // Changing the line clears it.
  fireEvent.change(slot.getByRole("spinbutton", { name: "Comment line" }), { target: { value: "2" } });
  expect(form.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("a refused save keeps focus in the box, with the reason and its buttons in view", async () => {
  const saveDraftComment = vi.fn(async () => { throw new Error("src/a.ts:99 isn’t in the current diff. Choose a line the diff shows."); });
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const slot = await renderTray("refused-focus", { getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment });
  await writeComment(slot, "Out of range.");
  fireEvent.change(slot.getByRole("spinbutton", { name: "Comment line" }), { target: { value: "99" } });
  const box = slot.getByRole("textbox", { name: "Draft comment" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  // Clicking the button focuses it, and saving disables it.
  const add = slot.getByRole("button", { name: "Add to draft" });
  add.focus();
  fireEvent.click(add);
  await within(box.parentElement!).findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(scrollIntoView.mock.contexts).toContain(box.parentElement);
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  slot.lifecycle.unmount();
});

test("comments on an older diff don't hold Submit: it names them, and Submit warns before moving them into the summary", async () => {
  const draft = draftOf({ body: "Summary.", comments: [{ file: "src/a.ts", line: 9, side: "RIGHT", body: "Old." }, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Current." }] });
  const slot = await renderTray("stale", { getDraft: () => ({ draft, stale: [{ file: "src/a.ts", line: 9, side: "RIGHT" }], discussions: [] }) });
  expect(submit(slot).hasAttribute("disabled")).toBe(false);
  expect(slot.getByText("The diff changed after these comments were drafted: src/a.ts:9. Edit or remove it, or submit anyway to move it into the summary.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("while the guide rebuilds, comment saves and Submit wait; a comment from before offers to keep it on the new diff", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { useState } = await import("react");
  let draft = draftOf({ body: "Summary." });
  const saveDraftComment = vi.fn(async ({ revision, comment }: any) => {
    if (revision !== "r2") throw new Error("This review changed in another window. Open the latest diff before saving or submitting feedback. Your text is still here.");
    draft = { ...draft, comments: [comment] };
    return { draft, stale: [], discussions: [] };
  });
  const component = () => {
    const [rebuilt, setRebuilt] = useState(false);
    return <><button onClick={() => setRebuilt(true)}>Rebuilt</button><DraftTray targetKey="rebuild" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision={rebuilt ? "r2" : "r1"} rebuilding={!rebuilt} account="reviewer" /></>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment } as any });
  await slot.findByText("Draft saved");
  expect(submit(slot).hasAttribute("disabled")).toBe(true);
  await writeComment(slot, "Written during the rebuild.");
  expect(slot.getByRole("button", { name: "Add to draft" }).hasAttribute("disabled")).toBe(true);
  expect(slot.getByText("The guide is rebuilding for new commits; your text is kept. Save when it’s ready.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Rebuilt" }));
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledTimes(1));
  fireEvent.click(await slot.findByRole("button", { name: "Keep on current diff" }));
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ revision: "r2" })));
  await waitFor(() => expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull());
  slot.lifecycle.unmount();
});

test("removing a comment offers Undo, which puts it back", async () => {
  const mine = { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c2", body: "Keep me." };
  let draft = draftOf({ comments: [mine] });
  const removeDraftComment = vi.fn(async () => { draft = { ...draft, comments: [] }; return { draft, stale: [], discussions: [] }; });
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("undo", { getDraft: () => ({ draft, stale: [], discussions: [] }), removeDraftComment, saveDraftComment });
  expand(slot, "src/a.ts:2");
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:2" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
  await waitFor(() => expect(slot.queryByRole("button", { name: row("src/a.ts:2") })).toBeNull());
  const [, { action }] = vi.mocked(toast.info).mock.calls[0] as any;
  action.onClick();
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "undo", revision: "r1", replaces: null, comment: mine }));
  await slot.findByRole("button", { name: row("src/a.ts:2") });
  slot.lifecycle.unmount();
});

test("Undo after removing an agent's comment puts back how it checked it too", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c2", author: "agent", body: "Is this tested?", evidence: "No test calls it." };
  let draft = draftOf({ comments: [agents] });
  const removeDraftComment = vi.fn(async () => { draft = { ...draft, comments: [] }; return { draft, stale: [], discussions: [] }; });
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("undo-agent", { getDraft: () => ({ draft, stale: [], discussions: [] }), removeDraftComment, saveDraftComment });
  expand(slot, "src/a.ts:2");
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:2" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
  const [, { action }] = vi.mocked(toast.info).mock.calls[0] as any;
  action.onClick();
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "undo-agent", revision: "r1", replaces: null, comment: agents }));
  slot.lifecycle.unmount();
});

test("the receipt after submitting links to the review on GitHub", async () => {
  let draft = draftOf({ body: "Looks good." });
  const submitReview = vi.fn(async () => { draft = draftOf(); return { ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-12" }; });
  const slot = await renderTray("receipt", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(submit(slot));
  const receipt = await slot.findByRole("region", { name: "Submitted review" });
  expect(within(receipt).getByRole("link", { name: "View on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/7#pullrequestreview-12");
  slot.lifecycle.unmount();
});

test("after saving, focus goes to the saved comment; after cancelling, back to where the box was opened", async () => {
  let draft = draftOf();
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("focus", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment });
  const options = slot.getByRole("button", { name: "Comment options" });
  await writeComment(slot, "Never mind.");
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(options));
  await writeComment(slot, "Saved.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await savedFocus("src/a.ts:1:RIGHT");
  slot.lifecycle.unmount();
});

test("Submit asks once more when the verdict isn't the agent's suggestion or the summary is out of date", async () => {
  const comments = [1, 2, 3].map((line) => ({ file: "src/a.ts", line, side: "RIGHT", body: `Note ${line}` }));
  let draft = draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "REQUEST_CHANGES", body: "One blocker.", comments });
  const submitReview = vi.fn(async () => ({ ok: true }));
  const slot = await renderTray("confirm", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(submit(slot));
  const ask = await slot.findByRole("alert");
  expect(ask.textContent).toContain("Submit Approve with 3 comments? The agent suggested Request changes.");
  expect(submitReview).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" })));
  fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(slot.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(submit(slot)));
  fireEvent.click(submit(slot));
  fireEvent.click(within(await slot.findByRole("alert")).getByRole("button", { name: "Submit anyway" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  slot.lifecycle.unmount();
});

test("an out-of-date summary asks once more; a verdict matching the suggestion and a current summary submit in one click", async () => {
  const comments = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Nit" }];
  let draft = draftOf({ suggestedVerdict: "COMMENT", body: "All fine.", bodyAuthor: "agent", written: { verdict: null, comments: "0:0" }, comments });
  const submitReview = vi.fn(async () => ({ ok: false, error: "Not now." }));
  const slot = await renderTray("outdated", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(submit(slot));
  expect((await slot.findByRole("alert")).textContent).toContain("Submit Comment with 1 comment? Your comments changed since the agent wrote the summary.");
  expect(submitReview).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  // The summary is yours now.
  draft = draftOf({ suggestedVerdict: "COMMENT", body: "All fine.", comments });
  await slot.emitRealtime("draft:outdated", {});
  await waitFor(() => expect(slot.queryByText("Your comments changed since the agent wrote this.")).toBeNull());
  fireEvent.click(submit(slot));
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  slot.lifecycle.unmount();
});

test("on your own PR, the panel offers Comment only, and picks it", async () => {
  let draft = draftOf({ verdict: "APPROVE", verdictChosen: true, body: "Notes.", suggestedVerdict: "APPROVE" });
  const setVerdict = vi.fn(({ verdict }: any) => { draft = { ...draft, verdict, verdictChosen: true }; return { draft }; });
  const submitReview = vi.fn(async () => ({ ok: true }));
  const slot = await renderTray("own", { getDraft: () => ({ draft, stale: [], discussions: [] }), setVerdict, submitReview }, { ownPr: true });
  const group = within(slot.getByRole("group", { name: "Review verdict" }));
  await waitFor(() => expect(setVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: "COMMENT" })));
  await waitFor(() => expect(group.getByRole("button", { name: /^Comment/ }).getAttribute("aria-pressed")).toBe("true"));
  for (const name of [/^Approve/, /^Request changes/]) {
    const button = group.getByRole("button", { name });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("This is your PR, so GitHub allows only a Comment review.");
  }
  expect(slot.getByText("This is your PR, so GitHub allows only a Comment review.")).toBeTruthy();
  // A suggestion GitHub wouldn't take isn't shown.
  expect(slot.queryByText(/Agent suggests/)).toBeNull();
  // The agent's other suggestion doesn't hold up Submit.
  fireEvent.click(submit(slot));
  await waitFor(() => expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "COMMENT" })));
  slot.lifecycle.unmount();
});

test("on a chapter with no files, the Add comment form starts on the review's first file", async () => {
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: draftOf({ comments: [comment] }), stale: [], discussions: [] }));
  const slot = await renderTray("nofiles", { getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment }, { activeFiles: [], files: ["src/a.ts", "src/b.ts"] });
  await writeComment(slot, "On the first file.");
  expect((slot.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement).value).toBe("src/a.ts");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts" }) })));
  slot.lifecycle.unmount();
});

test("a comment refused for an older diff says so in the status line too, not that another window changed it", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { useState } = await import("react");
  const saveDraftComment = vi.fn(async () => { throw new Error("This review changed in another window. Open the latest diff before saving or submitting feedback. Your text is still here."); });
  const component = () => {
    const [revision, setRevision] = useState("r1");
    return <><button onClick={() => setRevision("r2")}>New diff</button><DraftTray targetKey="older" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision={revision} account="reviewer" /></>;
  };
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment } as any });
  await slot.findByText("Draft saved");
  await writeComment(slot, "Written on r1.");
  fireEvent.click(slot.getByRole("button", { name: "New diff" }));
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await slot.findByRole("button", { name: "Keep on current diff" });
  expect(status(slot).textContent).toBe("Not saved: it was written against an older diff.");
  slot.lifecycle.unmount();
});

test("Undo after removing keeps an agent's comment the agent's, and isn't offered for a comment on an older diff", async () => {
  const agents = { file: "src/a.ts", line: 2, side: "RIGHT", author: "agent", body: "From the agent." };
  const old = { file: "src/a.ts", line: 9, side: "RIGHT", body: "Older diff." };
  let draft = draftOf({ comments: [agents, old] });
  const removeDraftComment = vi.fn(async ({ line }: any) => { draft = { ...draft, comments: draft.comments.filter((c: any) => c.line !== line) }; return { draft, stale: [], discussions: [] }; });
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [...draft.comments, comment] }; return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("undo-agent", { getDraft: () => ({ draft, stale: [{ file: "src/a.ts", line: 9, side: "RIGHT" }], discussions: [] }), removeDraftComment, saveDraftComment });
  expand(slot, "src/a.ts:9");
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:9" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed"));
  expand(slot, "src/a.ts:2");
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:2" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(2));
  const [, { action }] = vi.mocked(toast.info).mock.calls[1] as any;
  action.onClick();
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "undo-agent", revision: "r1", replaces: null, comment: agents }));
  slot.lifecycle.unmount();
});

test("when BB mounts a review's new workspace before the old one goes, the old one going keeps its draft status and comments", async () => {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { useDraftStatus } = await import("../lib/draft-status");
  const { commentsOf } = await import("./comments/store");
  const draft = draftOf({ targetKey: "pr-7", comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "x" }] });
  const rpc = { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: structuredClone(draft), stale: [] }) };
  const workspace = () => <DraftTray targetKey="pr-7" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" />;
  let status: unknown = "unset";
  const Probe = () => { status = useDraftStatus("pr-7"); return null; };
  const probe = renderSlot({ component: Probe }, {}, { rpc: rpc as any });
  const old = renderSlot({ component: workspace }, {}, { rpc: rpc as any });
  await waitFor(() => expect(status).toEqual({ verdict: "COMMENT", comments: 1 }));
  const fresh = renderSlot({ component: workspace }, {}, { rpc: rpc as any });
  await waitFor(() => expect(fresh.getAllByText("Draft saved").length).toBeGreaterThan(0));
  old.lifecycle.unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(status).toEqual({ verdict: "COMMENT", comments: 1 });
  expect(commentsOf("pr-7").items).toHaveLength(1);
  // The last one going forgets them.
  fresh.lifecycle.unmount();
  await waitFor(() => expect(status).toBeNull());
  expect(commentsOf("pr-7").items).toEqual([]);
  probe.lifecycle.unmount();
});
