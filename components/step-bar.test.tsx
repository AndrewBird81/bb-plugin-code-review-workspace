// @vitest-environment jsdom
// Stepping through comments without the list: by touch, the step bar after going to a comment from the sheet or an
// overlay; with keys and the list closed, a brief hint; and on a review back to you, the "need you" pill.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, lineAnnotations, renderAnnotation }: any) => {
    const pick = () => { const range = { start: 1, end: 1, side: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff" data-file-name={fileDiff.name}>
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
      <button onClick={pick}>Pick line 1</button>
    </div>;
  },
}));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); restores.splice(0).forEach((restore) => restore()); });

/** A phone's screen, touched: every ResizeObserver reports 390×844, and media queries answer for it. */
function phone() {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width: 390, height: 844 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = query === "(pointer: coarse)" || (!!max && (max[1] === "width" ? 390 : 844) <= Number(max[2]));
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); });
}

const now = Date.now();
const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n one\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [
  { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] },
  { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts" }] },
] };
const backToYou = { submittedVerdict: "REQUEST_CHANGES", submittedAt: 1, turn: { group: "needs", reason: "re-requested", label: "Re-requested", action: "Review changes", signal: "re-requested:1", at: 2, notify: true, blocking: false, updated: true } };

async function renderWorkspace(review: Record<string, unknown> = {}) {
  if (!localStorage.getItem("gr:panelstate")) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [
      { file: "src/a.ts", line: 2, side: "RIGHT", body: "On a." }, { file: "src/b.ts", line: 2, side: "RIGHT", body: "On b." },
    ] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: [{ id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 2, side: "RIGHT", comments: [{ id: "c1", databaseId: 1, author: "bob", body: "Why?", createdAt: now }] }] }),
    // Your thread, which alice answered: it needs you.
    getFeedback: () => ({ feedback: { baseline: { sha: "old", at: 1, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, run: null, suggestionInDraft: false, items: [{
      id: "t9", kind: "thread", title: "Rename it", assessment: null, replyDraft: null,
      thread: { id: "t9", commentId: 9, reviewId: "R1", path: "src/b.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Rename it.", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [{ author: "alice", bot: false, mine: false, body: "Done.", createdAt: now }], status: "answered", replyAt: now, url: null },
    }] } }),
    getReplyDrafts: () => ({ drafts: [] }),
  } as any });
  await slot.findByRole("main", { name: "Review" });
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const bar = (slot: Slot) => slot.queryByRole("toolbar", { name: "Step through comments" });
const chapter = (slot: Slot) => slot.getByRole("group", { name: "Review commands" }).querySelector("[aria-label^='Chapters:']")?.getAttribute("aria-label");

test("by touch, a comment tapped in the sheet closes it to show the comment, and the step bar steps through the list from there", async () => {
  phone();
  const slot = await renderWorkspace();
  const dock = within(slot.getByRole("group", { name: "Review commands" }));
  fireEvent.click(await dock.findByRole("button", { name: /^Comments/ }));
  const sheet = within(await slot.findByRole("dialog", { name: "Comments" }));
  fireEvent.click(await sheet.findByRole("button", { name: "Draft · not submitted · src/b.ts:2" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(chapter(slot)).toMatch(/^Chapters: Chapter 2 of 2, Caching/));
  const steps = within(bar(slot)!);
  // All: Needs you, then not submitted, then on GitHub.
  expect(steps.getByRole("status").textContent).toBe("3 of 4 · All");
  fireEvent.click(steps.getByRole("button", { name: "Next comment" }));
  await waitFor(() => expect(steps.getByRole("status").textContent).toBe("4 of 4 · All"));
  await waitFor(() => expect(chapter(slot)).toMatch(/^Chapters: Chapter 1 of 2, Parsing/));
  fireEvent.click(steps.getByRole("button", { name: "Next comment" }));
  await waitFor(() => expect(steps.getByRole("status").textContent).toBe("1 of 4 · All"));
  fireEvent.click(steps.getByRole("button", { name: "Previous comment" }));
  await waitFor(() => expect(steps.getByRole("status").textContent).toBe("4 of 4 · All"));
  // Show in list: the sheet again, with the comment open.
  fireEvent.click(steps.getByRole("button", { name: "Show in list" }));
  const again = within(await slot.findByRole("dialog", { name: "Comments" }));
  expect(again.getByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  expect(bar(slot)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("the selection bar takes the step bar's place, and Close puts it away", async () => {
  phone();
  const slot = await renderWorkspace();
  fireEvent.click(await within(slot.getByRole("group", { name: "Review commands" })).findByRole("button", { name: /^Comments/ }));
  fireEvent.click(await within(await slot.findByRole("dialog", { name: "Comments" })).findByRole("button", { name: "Draft · not submitted · src/a.ts:2" }));
  await waitFor(() => expect(bar(slot)).toBeTruthy());
  fireEvent.click(slot.getAllByRole("button", { name: "Pick line 1" })[0]);
  expect(bar(slot)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  expect(bar(slot)).toBeTruthy();
  fireEvent.click(within(bar(slot)!).getByRole("button", { name: "Close" }));
  expect(bar(slot)).toBeNull();
  slot.lifecycle.unmount();
});

test("text selected, as a long-press selects it, puts the step bar away until it's cleared", async () => {
  phone();
  const slot = await renderWorkspace();
  fireEvent.click(await within(slot.getByRole("group", { name: "Review commands" })).findByRole("button", { name: /^Comments/ }));
  fireEvent.click(await within(await slot.findByRole("dialog", { name: "Comments" })).findByRole("button", { name: "Draft · not submitted · src/a.ts:2" }));
  await waitFor(() => expect(bar(slot)).toBeTruthy());
  // The slot's tree isn't the document's here, so the text is beside it.
  const text = document.body.appendChild(document.createElement("p"));
  text.textContent = "return entry.value;";
  restores.push(() => text.remove());
  document.getSelection()!.selectAllChildren(text);
  act(() => { document.dispatchEvent(new Event("selectionchange")); });
  expect(bar(slot)).toBeNull();
  document.getSelection()!.removeAllRanges();
  act(() => { document.dispatchEvent(new Event("selectionchange")); });
  // It waits as long as the selection bar stays, for a tap on it.
  expect(bar(slot)).toBeNull();
  await waitFor(() => expect(bar(slot)).toBeTruthy());
  slot.lifecycle.unmount();
});

test("with keys and the list closed, ] and [ show where they went for 2 seconds", async () => {
  // jsdom can't scroll: the diff lands on the comment's file when it can't find the line drawn.
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  restores.push(() => { Element.prototype.scrollIntoView = scrollIntoView; });
  const slot = await renderWorkspace();
  await slot.findAllByTestId("filediff");
  // Wait for GitHub's side to be read, so the list has all four.
  fireEvent.click(await slot.findByRole("button", { name: /^Comments/ }));
  await within(slot.getByRole("region", { name: "Comments" })).findByRole("radio", { name: "All, 4" });
  fireEvent.click(slot.getByRole("button", { name: "Close panel" }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.keyDown(document.body, { key: "]" });
  const hint = await slot.findByText("2 of 4 · All");
  expect(hint.getAttribute("role")).toBe("status");
  expect(bar(slot)).toBeNull();
  act(() => { vi.advanceTimersByTime(2100); });
  await waitFor(() => expect(slot.queryByText("2 of 4 · All")).toBeNull());
  slot.lifecycle.unmount();
});

test("back to you where Comments couldn't open beside the code, \"1 need you\" offers it once, on Needs you", async () => {
  phone();
  const slot = await renderWorkspace(backToYou);
  const pill = await slot.findByRole("button", { name: "1 need you" });
  fireEvent.click(pill);
  const sheet = within(await slot.findByRole("dialog", { name: "Comments" }));
  expect(sheet.getByRole("radio", { name: "Needs you, 1" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(sheet.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.queryByRole("button", { name: "1 need you" })).toBeNull();
  slot.lifecycle.unmount();
});

test("✕ puts the pill away", async () => {
  phone();
  const slot = await renderWorkspace(backToYou);
  await slot.findByRole("button", { name: "1 need you" });
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  expect(slot.queryByRole("button", { name: "1 need you" })).toBeNull();
  slot.lifecycle.unmount();
});
