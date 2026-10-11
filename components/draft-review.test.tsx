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

test("only old-side comments carry a side badge, and the form's sides are New and Old", async () => {
  const draft = draftOf({ comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "New side." }, { file: "src/a.ts", line: 1, side: "LEFT", body: "Old side." }] });
  const slot = await renderTray("side", { getDraft: () => ({ draft, stale: [], discussions: [] }) });
  expect(slot.getByRole("button", { name: "src/a.ts:2" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "src/a.ts:1 · Old line" })).toBeTruthy();
  expect(slot.queryByText("Changed")).toBeNull();
  expect(slot.getAllByText("Old line")).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
  const side = slot.getByRole("combobox", { name: "Comment side" });
  expect(within(side).getAllByRole("option").map((option) => option.textContent)).toEqual(["New line", "Old line"]);
  slot.lifecycle.unmount();
});

test("line comments list in the review's order: chapter by chapter, then file, line, and side", async () => {
  const at = (file: string, line: number, side = "RIGHT") => ({ file, line, side, body: `${file}:${line}:${side}` });
  const draft = draftOf({ comments: [at("src/z.ts", 1), at("src/a.ts", 3), at("src/b.ts", 5), at("src/a.ts", 1), at("src/b.ts", 2), at("src/a.ts", 1, "LEFT")] });
  // src/b.ts is in the first chapter, src/a.ts in the second; src/z.ts in none.
  const slot = await renderTray("order", { getDraft: () => ({ draft, stale: [], discussions: [] }) }, { files: ["src/b.ts", "src/a.ts"] });
  const list = slot.getAllByRole("button", { name: /^src\/.\.ts:\d/ }).map((button) => button.getAttribute("aria-label"));
  expect(list).toEqual(["src/b.ts:2", "src/b.ts:5", "src/a.ts:1 · Old line", "src/a.ts:1", "src/a.ts:3", "src/z.ts:1"]);
  slot.lifecycle.unmount();
});

test("the Add comment form picks from the review's files, and says why the server refused a line", async () => {
  const saveDraftComment = vi.fn(async () => { throw new Error("src/b.ts:99 isn’t in the current diff. Choose a line the diff shows."); });
  const slot = await renderTray("outside", { getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment }, { files: ["src/a.ts", "src/b.ts"] });
  writeComment(slot, "Out of range.");
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

test("Submit waits while comments are on an older diff, and names them", async () => {
  const draft = draftOf({ body: "Summary.", comments: [{ file: "src/a.ts", line: 9, side: "RIGHT", body: "Old." }, { file: "src/a.ts", line: 2, side: "RIGHT", body: "Current." }] });
  const slot = await renderTray("stale", { getDraft: () => ({ draft, stale: [{ file: "src/a.ts", line: 9, side: "RIGHT" }], discussions: [] }) });
  expect(slot.getByRole("button", { name: "Submit to GitHub" }).hasAttribute("disabled")).toBe(true);
  expect(slot.getByText("The diff changed after these comments were drafted. Edit and save, or remove: src/a.ts:9")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("while the guide rebuilds, comment saves and Submit wait; a comment from before offers to keep it on the new diff", async () => {
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./DraftTray");
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
  expect(slot.getByRole("button", { name: "Submit to GitHub" }).hasAttribute("disabled")).toBe(true);
  writeComment(slot, "Written during the rebuild.");
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
  fireEvent.click(slot.getByRole("button", { name: "Remove comment on src/a.ts:2" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Comment removed", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
  await waitFor(() => expect(slot.queryByRole("button", { name: "src/a.ts:2" })).toBeNull());
  const [, { action }] = vi.mocked(toast.info).mock.calls[0] as any;
  action.onClick();
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith({ targetKey: "undo", revision: "r1", comment: mine }));
  await slot.findByRole("button", { name: "src/a.ts:2" });
  slot.lifecycle.unmount();
});

test("the receipt after submitting links to the review on GitHub", async () => {
  let draft = draftOf({ body: "Looks good." });
  const submitReview = vi.fn(async () => { draft = draftOf(); return { ok: true, url: "https://github.com/acme/web/pull/7#pullrequestreview-12" }; });
  const slot = await renderTray("receipt", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  const receipt = await slot.findByRole("region", { name: "Submitted review" });
  expect(within(receipt).getByRole("link", { name: "View on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/7#pullrequestreview-12");
  slot.lifecycle.unmount();
});

test("after saving, focus goes to the saved comment; after cancelling, back to where the box was opened", async () => {
  let draft = draftOf();
  const saveDraftComment = vi.fn(async ({ comment }: any) => { draft = { ...draft, comments: [comment] }; return { draft, stale: [], discussions: [] }; });
  const slot = await renderTray("focus", { getDraft: () => ({ draft, stale: [], discussions: [] }), saveDraftComment });
  const add = slot.getByRole("button", { name: "Add comment" });
  add.focus();
  writeComment(slot, "Never mind.");
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(add));
  writeComment(slot, "Saved.");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(document.activeElement?.getAttribute("data-comment-at")).toBe("src/a.ts:1:RIGHT"));
  slot.lifecycle.unmount();
});

test("Submit asks once more when the verdict isn't the agent's suggestion or the summary is out of date", async () => {
  const comments = [1, 2, 3].map((line) => ({ file: "src/a.ts", line, side: "RIGHT", body: `Note ${line}` }));
  let draft = draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "REQUEST_CHANGES", body: "One blocker.", comments });
  const submitReview = vi.fn(async () => ({ ok: true }));
  const slot = await renderTray("confirm", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  const ask = await slot.findByRole("alert");
  expect(ask.textContent).toContain("Submit Approve with 3 comments? The agent suggested Request changes.");
  expect(submitReview).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" })));
  fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(slot.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Submit to GitHub" })));
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  fireEvent.click(within(await slot.findByRole("alert")).getByRole("button", { name: "Submit anyway" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  slot.lifecycle.unmount();
});

test("an out-of-date summary asks once more; a verdict matching the suggestion and a current summary submit in one click", async () => {
  const comments = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Nit" }];
  let draft = draftOf({ suggestedVerdict: "COMMENT", body: "All fine.", bodyAuthor: "agent", written: { verdict: null, comments: "0:0" }, comments });
  const submitReview = vi.fn(async () => ({ ok: false, error: "Not now." }));
  const slot = await renderTray("outdated", { getDraft: () => ({ draft, stale: [], discussions: [] }), submitReview });
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  expect((await slot.findByRole("alert")).textContent).toContain("Submit Comment with 1 comment? Your comments changed since the agent wrote the summary.");
  expect(submitReview).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  // The summary is yours now.
  draft = draftOf({ suggestedVerdict: "COMMENT", body: "All fine.", comments });
  await slot.emitRealtime("draft:outdated", {});
  await waitFor(() => expect(slot.queryByText("Your comments changed since the agent wrote this.")).toBeNull());
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
  slot.lifecycle.unmount();
});

test("below 768px wide the review panel starts collapsed, and doesn't forget it was open on a wider screen", async () => {
  localStorage.setItem("gr:panelstate", JSON.stringify({ perReview: { narrow: { activeTool: "draft", toolsOpen: true } } }));
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(max-width: 767px)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
  try {
    await loadPluginApp(() => import("../app"));
    const { DraftTray } = await import("./DraftTray");
    const slot = renderSlot({ component: () => <DraftTray targetKey="narrow" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" /> }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }) } as any });
    const tool = await slot.findByRole("button", { name: "Draft review" });
    expect(tool.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("gr:panelstate")!).perReview.narrow.toolsOpen).toBe(true);
    fireEvent.click(tool);
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    slot.lifecycle.unmount();
  } finally { matchMedia.mockRestore(); }
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
  // The agent's other suggestion doesn't hold up Submit.
  fireEvent.click(slot.getByRole("button", { name: "Submit to GitHub" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "COMMENT" })));
  slot.lifecycle.unmount();
});

test("on a chapter with no files, the Add comment form starts on the review's first file", async () => {
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: draftOf({ comments: [comment] }), stale: [], discussions: [] }));
  const slot = await renderTray("nofiles", { getDraft: () => ({ draft: draftOf(), stale: [], discussions: [] }), saveDraftComment }, { activeFiles: [], files: ["src/a.ts", "src/b.ts"] });
  writeComment(slot, "On the first file.");
  expect((slot.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement).value).toBe("src/a.ts");
  fireEvent.click(slot.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts" }) })));
  slot.lifecycle.unmount();
});
