// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

// Each line of a file as pierre would take a tap on it: its click reports the line (onLineClick); its number's
// press starts pierre's own pick of that line, reported when the press ends. The lines pierre paints, and its styles.
const given: { options?: any } = {};
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, selectedLines, lineAnnotations, renderAnnotation }: any) => {
    given.options = options;
    const range = (line: number) => ({ start: line, end: line, side: "additions" });
    return (
      <div data-testid="filediff" data-selected={selectedLines ? `${selectedLines.start}-${selectedLines.end}` : ""}>
        {fileDiff.additionLines.map((text: string, index: number) => (
          <div key={index}>
            <button type="button" onPointerDown={() => options.onLineSelectionStart?.(range(index + 1))} onPointerUp={() => { options.onLineSelectionEnd?.(range(index + 1)); options.onLineSelected?.(range(index + 1)); }}
              onClick={(event) => options.onLineClick?.({ type: "diff-line", lineNumber: index + 1, annotationSide: "additions", lineType: "change-addition", event })}>
              {index + 1}
            </button>
            <span onClick={(event) => options.onLineClick?.({ type: "diff-line", lineNumber: index + 1, annotationSide: "additions", lineType: "change-addition", event })}>{text}</span>
          </div>
        ))}
        {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
      </div>
    );
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

installTestPluginRuntime();
const { DiffViewer } = await import("./DiffViewer");

// jsdom has no PointerEvent: a mouse event that says which pointer it is.
globalThis.PointerEvent ??= class extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
} as unknown as typeof PointerEvent;

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,5 @@\n-old\n+one\n+two\n+three\n+four\n+five\n";

/** The diff with its lines picked as the workspace keeps them, and what it was told. */
function renderDiff() {
  const picks: (SelectedLineRange | null)[] = [];
  function Picking() {
    const [picked, setPicked] = useState<{ file: string; range: SelectedLineRange } | null>(null);
    return <DiffViewer patch={patch} files={["src/a.ts"]} views={new Map()} onToggleViewed={() => {}} selectedLines={picked}
      onLineSelected={(file, range) => { picks.push(range); setPicked(range ? { file, range } : null); }} />;
  }
  render(<Picking />);
  return { picks, painted: () => screen.getByTestId("filediff").dataset.selected };
}
/** A tap: a touch's press on a line, then its click. */
function tap(target: Element, pointerType = "touch") {
  fireEvent.pointerDown(target, { pointerType });
  fireEvent.pointerUp(target, { pointerType });
  fireEvent.click(target);
}

test("a tap on a line picks it, a tap on another line of the file makes a range from it, and a tap on the first line clears it", () => {
  const { picks, painted } = renderDiff();
  tap(screen.getByText("two"));
  expect(painted()).toBe("2-2");
  tap(screen.getByText("four"));
  expect(painted()).toBe("2-4");
  // Each later tap moves the range's end, either way.
  tap(screen.getByText("one"));
  expect(painted()).toBe("2-1");
  tap(screen.getByText("two"));
  expect(painted()).toBe("");
  expect(picks).toEqual([{ start: 2, end: 2, side: "additions" }, { start: 2, end: 4, side: "additions" }, { start: 2, end: 1, side: "additions" }, null]);
});

test("a tap on a line's number picks the line once: pierre's own pick of it doesn't count, a drag over the numbers does", () => {
  const { picks, painted } = renderDiff();
  tap(screen.getByRole("button", { name: "3" }));
  expect(picks).toEqual([{ start: 3, end: 3, side: "additions" }]);
  // Tapped again, its number clears it, as the line would.
  tap(screen.getByRole("button", { name: "3" }));
  expect(painted()).toBe("");
  // A finger dragged down the numbers.
  fireEvent.pointerDown(screen.getByRole("button", { name: "2" }), { pointerType: "touch" });
  act(() => given.options.onLineSelectionChange({ start: 2, end: 4, side: "additions" }));
  expect(painted()).toBe("2-4");
  act(() => {
    given.options.onLineSelectionEnd({ start: 2, end: 4, side: "additions" });
    given.options.onLineSelected({ start: 2, end: 4, side: "additions" });
  });
  expect(picks.at(-1)).toEqual({ start: 2, end: 4, side: "additions" });
  expect(painted()).toBe("2-4");
});

test("a mouse's click on a line picks nothing, and its drag over the numbers picks as before", () => {
  const { picks, painted } = renderDiff();
  tap(screen.getByText("two"), "mouse");
  expect(picks).toEqual([]);
  tap(screen.getByRole("button", { name: "2" }), "mouse");
  expect(picks).toEqual([{ start: 2, end: 2, side: "additions" }]);
  expect(painted()).toBe("2-2");
});

test("the gutter's + shows only with a fine pointer, and code lines keep a mouse's text cursor", () => {
  renderDiff();
  const css: string = given.options.unsafeCSS;
  expect(css).toContain("@media not (any-pointer: fine) { [data-gutter-utility-slot] { display: none; } }");
  expect(css).toContain("@media (hover: hover) and (pointer: fine) { [data-interactive-lines] [data-line] { cursor: auto; } }");
});

/** Media queries answer as on a touch screen: a coarse pointer, and no fine one. */
function fakeTouch() {
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }) as MediaQueryList);
  restores.push(() => matchMedia.mockRestore());
}

async function renderWorkspace(comments: unknown[] = []) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const saveDraftComment = vi.fn(async ({ comment }: any) => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] }, stale: [], discussions: [] }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Count", headSha: "h" }, guide: { title: "Guide", intent: "Counts.", unplacedFiles: [], sections: [{ id: "c1", title: "Counting", overview: "Counts.", diffs: [{ file: "src/a.ts" }] }] }, patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments }, stale: [], discussions: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    saveDraftComment,
  } as any });
  await slot.findByTestId("filediff");
  return { slot, saveDraftComment };
}

test("in the review, lines tapped on touch get the selection bar, which says how to make a range, and Comment opens a box on them", async () => {
  fakeTouch();
  const { slot, saveDraftComment } = await renderWorkspace();
  tap(slot.getByText("two"));
  tap(slot.getByText("four"));
  const bar = within(slot.getByRole("group", { name: "Selection" }));
  expect(bar.getByText("L2–4")).toBeTruthy();
  expect(bar.getByText("Tap another line to select a range")).toBeTruthy();
  fireEvent.click(bar.getByRole("button", { name: "Comment" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" });
  fireEvent.change(box, { target: { value: "Fold these." } });
  fireEvent.click(within(slot.getByTestId("filediff")).getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts", line: 4, side: "RIGHT", startLine: 2 }) })));
  expect(slot.queryByRole("group", { name: "Selection" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("with a mouse, the bar has no tap hint", async () => {
  const { slot } = await renderWorkspace();
  tap(slot.getByRole("button", { name: "2" }), "mouse");
  const bar = within(slot.getByRole("group", { name: "Selection" }));
  expect(bar.getByText("L2")).toBeTruthy();
  expect(bar.queryByText("Tap another line to select a range")).toBeNull();
  fireEvent.click(bar.getByRole("button", { name: "Clear selection" }));
  expect(slot.queryByRole("group", { name: "Selection" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("text selected in a draft comment isn't code to ask about", async () => {
  const { slot } = await renderWorkspace([{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Parse it once.", author: "reviewer" }]);
  const range = document.createRange();
  range.selectNodeContents(await within(slot.getByTestId("filediff")).findByText("Parse it once."));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.queryByRole("group", { name: "Selection" })).toBeNull();
  // Its code is.
  range.selectNodeContents(slot.getByText("three"));
  fireEvent(document, new Event("selectionchange"));
  expect(await slot.findByRole("button", { name: "Ask agent about selection" })).toBeTruthy();
  window.getSelection()!.removeAllRanges();
  slot.lifecycle.unmount();
}, 15_000);
