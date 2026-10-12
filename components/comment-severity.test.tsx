// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DraftProviderProps } from "./DraftProvider";

// Render the diff's annotations, not @pierre/diffs' internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const range = { start: 3, end: 3, side: "additions" };
    return (
      <div data-testid="filediff">
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
        <button onClick={() => { options.onGutterUtilityClick(range); options.onLineSelected(range); }}>Gutter +</button>
      </div>
    );
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });

/** The draft's provider with Comments and Finish review after what it wraps, as the side panel shows them. */
async function draftTray() {
  const { DraftTray } = await import("./draft-tray.test-support");
  return DraftTray;
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,4 @@\n-old\n+one\n+two\n+three\n+four\n";
const at = (line: number) => ({ file: "src/a.ts", line, side: "RIGHT" });
const blocking = { ...at(1), severity: "blocking", body: "This drops writes." };
const nit = { ...at(2), author: "agent", severity: "nit", body: "Spacing." };
const plain = { ...at(4), body: "No label." };

async function renderReview(targetKey: string, rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const DraftTray = await draftTray();
  const { DiffViewer } = await import("./DiffViewer");
  const component = () => (
    <DraftTray targetKey={targetKey} activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" account="reviewer" patch={patch}>
      <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} />
    </DraftTray>
  );
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), ...rpc } as any });
  await slot.findByText("Draft saved");
  return { slot, diff: () => within(slot.getByTestId("filediff")), panel: () => within(slot.getByRole("region", { name: "Comments" })) };
}
type Slot = Awaited<ReturnType<typeof renderReview>>["slot"];
/** Comments' ⋯ Comment options, open. */
async function options(slot: Slot) {
  fireEvent.click(slot.getByRole("button", { name: "Comment options" }));
  return within(await slot.findByRole("dialog"));
}
const draftOf = (comments: any[], over: Record<string, unknown> = {}) => ({ targetKey: "k", verdict: "COMMENT", body: "", comments, ...over });
/** A draft the rpc stubs keep, as the server would. */
function stored(comments: any[], over: Record<string, unknown> = {}) {
  let draft = draftOf(comments, over);
  const state = () => ({ draft: structuredClone(draft), stale: [], discussions: [] });
  return {
    getDraft: state,
    saveDraftComment: vi.fn(async ({ comment }: any) => {
      draft = { ...draft, comments: [...draft.comments.filter((c: any) => c.line !== comment.line), comment] };
      return state();
    }),
    removeDraftComment: vi.fn(async ({ line }: any) => {
      draft = { ...draft, comments: draft.comments.filter((c: any) => c.line !== line) };
      return state();
    }),
  };
}

test("comment cards in the diff and the panel show each severity but none, and Draft review counts them", async () => {
  const { slot, diff, panel } = await renderReview("badges", stored([blocking, nit, { ...at(3), severity: "should-fix", body: "Rename." }, plain]));
  const card = (line: number) => diff().getByRole("article", { name: `Draft comment on src/a.ts:${line}` });
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(within(card(1)).getByText("Blocking")).toBeTruthy();
  expect(within(card(2)).getByText("Nit")).toBeTruthy();
  expect(within(card(3)).getByText("Should fix")).toBeTruthy();
  expect(within(card(4)).queryByText(/Blocking|Nit|Should fix|Question/)).toBeNull();
  expect(panel().getByRole("button", { name: "Draft · not submitted · src/a.ts:1 · Blocking" })).toBeTruthy();
  expect(panel().getByRole("button", { name: "Agent draft · not submitted · src/a.ts:2 · Nit" })).toBeTruthy();
  expect(panel().getByRole("button", { name: "Draft · not submitted · src/a.ts:4" })).toBeTruthy();
  expect(panel().getByText("1 blocking · 1 should fix · 1 nit")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the comment box sets a comment's severity, in the panel and the diff, and an edit starts from the comment's", async () => {
  const rpc = stored([blocking]);
  const { slot, diff, panel } = await renderReview("control", rpc);
  fireEvent.click((await options(slot)).getByRole("button", { name: "Add comment by line…" }));
  fireEvent.change(panel().getByRole("spinbutton", { name: "Comment line" }), { target: { value: "2" } });
  fireEvent.change(panel().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Why?" } });
  fireEvent.change(panel().getByRole("combobox", { name: "Severity" }), { target: { value: "question" } });
  fireEvent.click(panel().getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ comment: { ...at(2), chapterId: "c1", severity: "question", body: "Why?" } })));

  // In the diff, editing the blocking comment starts at Blocking; No severity drops it.
  fireEvent.click(within(await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" })).getByRole("button", { name: "Edit" }));
  const severity = diff().getByRole("combobox", { name: "Severity" }) as HTMLSelectElement;
  expect(severity.value).toBe("blocking");
  fireEvent.change(severity, { target: { value: "none" } });
  fireEvent.click(diff().getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenLastCalledWith(expect.objectContaining({ comment: { ...at(1), chapterId: "c1", body: "This drops writes." } })));

  // A new comment's box starts with none.
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  expect((diff().getByRole("combobox", { name: "Severity" }) as HTMLSelectElement).value).toBe("none");
  slot.lifecycle.unmount();
});

test("typing in Comments' comment box keeps it in view with its buttons as Finish's hint changes", async () => {
  const scrolled = vi.fn();
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled(this); };
  try {
    const { slot, panel } = await renderReview("composer-view", stored([blocking]));
    fireEvent.click((await options(slot)).getByRole("button", { name: "Add comment by line…" }));
    const box = panel().getByRole("textbox", { name: "Draft comment" });
    box.focus();
    scrolled.mockClear();
    fireEvent.change(box, { target: { value: "Why?" } });
    expect(slot.getByText("Add the comment you’re writing to the draft before submitting.")).toBeTruthy();
    const controls = panel().getByRole("combobox", { name: "Severity" }).closest("[data-composer-controls]");
    expect(controls).toBeTruthy();
    // The whole box, nearest: all of it where it fits, else its top, where you type.
    expect(scrolled).toHaveBeenCalledWith(controls!.closest("[data-keyboard-box]"));
    expect(controls!.closest("[data-keyboard-box]")!.contains(box)).toBe(true);
    slot.lifecycle.unmount();
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
});

test("Hide nits hides nit cards in the diff and the panel, and from the file's count, and stays hidden in this browser", async () => {
  const rpc = stored([blocking, nit]);
  let { slot, diff, panel } = await renderReview("hide", rpc);
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  const header = () => within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!);
  expect(header().getByText("2 not submitted")).toBeTruthy();
  const menu = await options(slot);
  fireEvent.click(menu.getByRole("switch", { name: "Hide nits" }));
  expect(menu.getByRole("switch", { name: "Hide nits" }).getAttribute("aria-checked")).toBe("true");
  // The file's row leaves the hidden nit out, and Comments says how many it hides, still counting what Submit sends.
  expect(header().getByText("1 not submitted")).toBeTruthy();
  expect(panel().getByText("1 blocking · 1 nit · 1 hidden")).toBeTruthy();
  expect(diff().queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull();
  expect(diff().getByRole("article", { name: "Draft comment on src/a.ts:1" })).toBeTruthy();
  expect(panel().queryByRole("button", { name: /src\/a\.ts:2/ })).toBeNull();
  expect(panel().getByRole("button", { name: "Draft · not submitted · src/a.ts:1 · Blocking" })).toBeTruthy();
  slot.lifecycle.unmount();
  ({ slot, diff, panel } = await renderReview("hide-again", rpc));
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(diff().queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull();
  fireEvent.click((await options(slot)).getByRole("switch", { name: "Hide nits" }));
  expect(await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Remove nits removes every nit, and Undo puts them back as they were", async () => {
  const other = { ...at(3), severity: "nit", body: "Typo." };
  const rpc = stored([blocking, nit, other]);
  const { slot, diff, panel } = await renderReview("remove-nits", rpc);
  await diff().findByRole("article", { name: "Draft comment on src/a.ts:2" });
  fireEvent.click((await options(slot)).getByRole("button", { name: "Remove nits" }));
  await waitFor(() => expect(rpc.removeDraftComment).toHaveBeenCalledTimes(2));
  expect(rpc.removeDraftComment.mock.calls.map(([input]: any) => input.line)).toEqual([2, 3]);
  await waitFor(() => expect(diff().queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull());
  // No nits left to remove.
  await waitFor(async () => expect((await options(slot)).getByRole("button", { name: "Remove nits" }).hasAttribute("disabled")).toBe(true));
  expect(toast.info).toHaveBeenLastCalledWith("Removed 2 nits", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
  (vi.mocked(toast.info).mock.lastCall![1] as any).action.onClick();
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledTimes(2));
  expect(rpc.saveDraftComment.mock.calls.map(([input]: any) => input.comment)).toEqual([
    { ...at(2), author: "agent", severity: "nit", body: "Spacing." },
    { ...at(3), severity: "nit", body: "Typo." },
  ]);
  expect(await diff().findByRole("article", { name: "Draft comment on src/a.ts:3" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("approving with blocking comments in the draft asks once more", async () => {
  const submitReview = vi.fn(async () => ({ ok: true }));
  const rpc = stored([blocking, { ...blocking, ...at(2) }, plain], { verdict: "APPROVE", verdictChosen: true });
  const { slot } = await renderReview("approve", { ...rpc, submitReview });
  fireEvent.click(slot.getByRole("button", { name: /^Submit to GitHub/ }));
  const ask = await slot.findByRole("alert");
  expect(ask.textContent).toContain("Approve with 2 blocking comments?");
  expect(submitReview).not.toHaveBeenCalled();
  fireEvent.click(within(ask).getByRole("button", { name: "Submit anyway" }));
  await waitFor(() => expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "APPROVE", comments: expect.arrayContaining([expect.objectContaining({ severity: "blocking" })]) })));
  slot.lifecycle.unmount();
});

test("a Comment review with blocking comments doesn’t ask", async () => {
  const submitReview = vi.fn(async () => ({ ok: true }));
  const { slot } = await renderReview("no-ask", { ...stored([blocking], { body: "Summary." }), submitReview });
  fireEvent.click(slot.getByRole("button", { name: /^Submit to GitHub/ }));
  await waitFor(() => expect(submitReview).toHaveBeenCalled());
  expect(slot.queryByText(/blocking comment/)).toBeNull();
  slot.lifecycle.unmount();
});

test("an unfinished comment's severity is recovered with its text after the page reloads", async () => {
  const rpc = stored([]);
  let { slot, diff } = await renderReview("recover", rpc);
  fireEvent.click(diff().getByRole("button", { name: "Gutter +" }));
  fireEvent.change(diff().getByRole("textbox", { name: "Draft comment" }), { target: { value: "Don't lose this" } });
  fireEvent.change(diff().getByRole("combobox", { name: "Severity" }), { target: { value: "should-fix" } });
  slot.lifecycle.unmount();
  ({ slot, diff } = await renderReview("recover", rpc));
  expect((diff().getByRole("combobox", { name: "Severity" }) as HTMLSelectElement).value).toBe("should-fix");
  slot.lifecycle.unmount();
});
