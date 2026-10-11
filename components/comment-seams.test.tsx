// @vitest-environment jsdom
// What the workspace gives the Comments views it mounts: Finish review's own view in the side panel, the step bar with
// the "need you" pill over the code, and ] and [ through lib/comment-stops.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { registerCommentStepper } from "../lib/comment-stops";
import { patchReviewState } from "../lib/panel-state";

// The props each view was last given.
const given = vi.hoisted(() => ({ finish: null as { shown: boolean; revision: string } | null, stepBar: null as { hidden: boolean; pill: boolean } | null }));
vi.mock("./comments/FinishView", () => ({ FinishView: (props: { shown: boolean; revision: string }) => { given.finish = props; return null; } }));
vi.mock("./comments/StepBar", () => ({ StepBar: (props: { hidden: boolean; pill: boolean }) => { given.stepBar = props; return null; } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each diff's new lines, and a pick of line 1 as pierre reports it.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    const pick = () => { const range = { start: 1, end: 1, side: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff"><pre>{fileDiff.additionLines.join("\n")}</pre><button onClick={pick}>Pick line 1</button></div>;
  },
}));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); given.finish = given.stepBar = null; restores.splice(0).forEach((restore) => restore()); });

/** A phone's screen: every ResizeObserver reports it, and media queries answer for it. */
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
    const matches = !!max && (max[1] === "width" ? 390 : 844) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); });
}

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [
  { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] },
  { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts" }] },
] };
/** It came back to you: the author re-requested your review after you'd given one. */
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
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/b.ts", line: 1, side: "RIGHT", body: "Cache it." }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getFeedback: () => ({ feedback: { baseline: { sha: "old", at: 1, verdict: "REQUEST_CHANGES" }, head: "new", items: [], run: null, suggestionInDraft: false, fetchedAt: 1 } }),
    getReviewThreads: () => ({ threads: [] }),
    markSeen: () => ({ ok: true }),
  } as any });
  await slot.findByRole("main", { name: "Review" });
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const panel = (slot: Slot) => slot.queryByRole("complementary", { name: "Comments and agent" });
const current = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" })).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step")?.textContent;

test("Finish review has its own view in the side panel, shown while Finish is open, with the page's revision", async () => {
  const slot = await renderWorkspace();
  await slot.findByText("aa");
  expect(given.finish).toEqual({ shown: false, revision: "r1" });
  fireEvent.keyDown(document.body, { key: "s" });
  await waitFor(() => expect(given.finish).toEqual({ shown: true, revision: "r1" }));
  fireEvent.click(within(panel(slot)!).getByRole("button", { name: "Close panel" }));
  expect(given.finish?.shown).toBe(false);
  slot.lifecycle.unmount();
});

test("] and [ step with what the Comments list registered, from the file you're on, and through the draft's lines until it does", async () => {
  const slot = await renderWorkspace();
  await slot.findByText("aa");
  // The draft and its comment have loaded.
  await slot.findByRole("button", { name: "Submit review: Comment, 1 comment" });
  const step = vi.fn();
  const withdraw = registerCommentStepper("pr-42", step);
  fireEvent.keyDown(document.body, { key: "]" });
  fireEvent.keyDown(document.body, { key: "[" });
  expect(step.mock.calls).toEqual([[1, "src/a.ts"], [-1, "src/a.ts"]]);
  expect(current(slot)).toContain("Parsing");
  withdraw();
  // The draft's comment on src/b.ts, in the next chapter.
  fireEvent.keyDown(document.body, { key: "]" });
  await slot.findByText("bb");
  expect(current(slot)).toContain("Caching");
  expect(step).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
});

test("where Comments can't open beside the code, a review back to you, or left on Feedback or Threads by 0.5, gets the need-you pill instead", async () => {
  // Wide enough to dock: Comments opens, and there's no pill.
  let slot = await renderWorkspace(backToYou);
  await waitFor(() => expect(panel(slot)).toBeTruthy());
  expect(given.stepBar).toEqual({ hidden: false, pill: false });
  slot.lifecycle.unmount();
  localStorage.clear();
  phone();
  slot = await renderWorkspace(backToYou);
  await waitFor(() => expect(given.stepBar?.pill).toBe(true));
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
  for (const view of ["feedback", "threads"] as const) {
    localStorage.clear();
    patchReviewState("pr-42", { activeId: "c1", view });
    slot = await renderWorkspace({ submittedVerdict: "COMMENT", submittedAt: 1 });
    await waitFor(() => expect(given.stepBar?.pill).toBe(true));
    slot.lifecycle.unmount();
  }
  // Nothing to offer: no pill.
  localStorage.clear();
  slot = await renderWorkspace();
  await slot.findAllByTestId("filediff");
  expect(given.stepBar).toEqual({ hidden: false, pill: false });
  slot.lifecycle.unmount();
});

test("the step bar gives way to the selection bar while lines are selected", async () => {
  const slot = await renderWorkspace();
  await slot.findByText("aa");
  expect(given.stepBar?.hidden).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  expect(given.stepBar?.hidden).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  expect(given.stepBar?.hidden).toBe(false);
  slot.lifecycle.unmount();
});
