// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { setNeedsYou } from "../lib/workspace-store";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each diff's new lines, and a pick of line 1 as pierre reports it.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options }: any) => {
    const pick = () => { const range = { start: 1, end: 1, side: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff"><pre>{fileDiff.additionLines.join("\n")}</pre><button onClick={pick}>Pick line 1</button></div>;
  },
}));

const restores: (() => void)[] = [];
// jsdom has no PointerEvent: a mouse event stands in, for the sheet's handle.
globalThis.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); setNeedsYou("pr-42", 0); restores.splice(0).forEach((restore) => restore()); });

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

async function renderPhone() {
  phone();
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [{ file: "src/b.ts", viewed: true, stale: false }] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [
      { file: "src/a.ts", line: 1, side: "RIGHT", body: "Parse it." },
      { file: "src/b.ts", line: 1, side: "RIGHT", body: "Cache it." },
    ] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  await slot.findAllByTestId("filediff");
  const dock = within(slot.getByRole("group", { name: "Review commands" }));
  return { slot, dock };
}

test("the dock names where you are and what's waiting: the chapter and its viewed files, comments not submitted, and what needs you", async () => {
  const { slot, dock } = await renderPhone();
  expect(await dock.findByRole("button", { name: "Chapters: Chapter 1 of 2, Parsing, 0 of 1 files viewed" })).toBeTruthy();
  expect(await dock.findByRole("button", { name: "Comments, 2 not submitted" })).toBeTruthy();
  act(() => setNeedsYou("pr-42", 3));
  const comments = dock.getByRole("button", { name: "Comments, 2 not submitted, 3 need you" });
  expect(comments.textContent).toBe("2");
  expect(comments.getAttribute("aria-controls")).toBe("gr-side-panel-pr-42");
  expect(dock.getByRole("button", { name: /^Chapters:/ }).getAttribute("aria-controls")).toBe("gr-navigator-pr-42");
  fireEvent.click(dock.getByRole("button", { name: "All reviews" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review" });
  slot.lifecycle.unmount();
});

test("Finish review is part of Comments in the sheet: Comments stays pressed, and pressing it closes the sheet", async () => {
  const { slot, dock } = await renderPhone();
  fireEvent.keyDown(document.body, { key: "s" });
  const sheet = await slot.findByRole("dialog", { name: "Finish review" });
  expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
  const comments = dock.getByRole("button", { name: /^Comments/ });
  expect(comments.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(comments);
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});

test("Esc, ✕ and a tap on the code above close the sheet, and the focus goes back to its tab, after a tap too", async () => {
  const { slot, dock } = await renderPhone();
  const tab = dock.getByRole("button", { name: /^Chapters:/ });
  tab.focus();
  fireEvent.keyDown(tab, { key: "Enter" });
  fireEvent.click(tab);
  const sheet = slot.getByRole("dialog", { name: "Chapters" });
  expect(document.activeElement).toBe(sheet);
  fireEvent.keyDown(sheet, { key: "Escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(tab));
  const tap = (button: HTMLElement) => { fireEvent.pointerDown(button); fireEvent.pointerUp(button); fireEvent.click(button); };
  tap(tab);
  tap(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Close" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(tab));
  fireEvent.click(dock.getByRole("button", { name: "Ask agent" }));
  fireEvent.click(slot.container.querySelector<HTMLElement>(".bg-black\\/40")!);
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});

test("a flick down the sheet's handle closes it, as does a drag a quarter of its height; a short, slow drag puts it back", async () => {
  const { slot, dock } = await renderPhone();
  const open = () => {
    fireEvent.click(dock.getByRole("button", { name: /^Comments/ }));
    const sheet = slot.getByRole("dialog", { name: "Comments" });
    Object.defineProperty(sheet, "clientHeight", { configurable: true, value: 600 });
    return sheet;
  };
  // The finger on the handle, at a time in ms.
  const finger = (sheet: HTMLElement, type: string, clientY: number, timeStamp: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientY });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    act(() => { sheet.querySelector("[data-sheet-handle]")!.dispatchEvent(event); });
  };
  let sheet = open();
  finger(sheet, "pointerdown", 100, 0);
  finger(sheet, "pointermove", 150, 200);
  expect(sheet.style.transform).toBe("translateY(50px)");
  finger(sheet, "pointerup", 150, 400);
  expect(sheet.style.transform).toBe("");
  expect(slot.getByRole("dialog", { name: "Comments" })).toBe(sheet);
  finger(sheet, "pointerdown", 100, 1000);
  finger(sheet, "pointermove", 130, 1010);
  finger(sheet, "pointerup", 130, 1020);
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(sheet.style.transform).toBe("");
  sheet = open();
  finger(sheet, "pointerdown", 100, 2000);
  finger(sheet, "pointermove", 250, 3000);
  finger(sheet, "pointerup", 250, 4000);
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});

test("a pick in the sheet closes it to show what was picked: a chapter, or a comment's line", async () => {
  const { slot, dock } = await renderPhone();
  fireEvent.click(dock.getByRole("button", { name: /^Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByText("Caching"));
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(await dock.findByRole("button", { name: "Chapters: Chapter 2 of 2, Caching, 1 of 1 files viewed" })).toBeTruthy();
  fireEvent.click(dock.getByRole("button", { name: /^Comments/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Comments" })).getByRole("button", { name: /^Draft · not submitted · src\/a\.ts:1/ }));
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(await dock.findByRole("button", { name: /^Chapters: Chapter 1 of 2/ })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the dock makes way while you type, and for the lines you select, whose bar takes its place", async () => {
  const { slot, dock } = await renderPhone();
  const group = slot.getByRole("group", { name: "Review commands" });
  fireEvent.click(dock.getByRole("button", { name: /^Chapters:/ }));
  const find = within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("searchbox", { name: "Find in review" });
  act(() => find.focus());
  expect(group.hidden).toBe(true);
  act(() => find.blur());
  expect(group.hidden).toBe(false);
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Chapters" }), { key: "Escape" });
  fireEvent.click(slot.getAllByRole("button", { name: "Pick line 1" })[0]!);
  expect(group.hidden).toBe(true);
  const bar = slot.getByRole("group", { name: "Selection" });
  expect(bar.className).toContain("bottom-[calc(4px+var(--gr-safe-bottom,0px))]");
  // Each side clear of what of its own safe area reaches the workspace (lib/use-safe-area.ts).
  expect(bar.className.split(" ")).toEqual(expect.arrayContaining(["left-[calc(6px+var(--gr-safe-left,0px))]", "right-[calc(6px+var(--gr-safe-right,0px))]"]));
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  expect(group.hidden).toBe(false);
  slot.lifecycle.unmount();
});

test("while the dock shows, BB's toasts at the page's bottom sit above it, and drop back when it makes way or goes", async () => {
  const { slot, dock } = await renderPhone();
  const group = slot.getByRole("group", { name: "Review commands" });
  const rule = () => document.head.querySelector("style[data-gr-toasts-above-dock]")?.textContent ?? null;
  // jsdom lays out nothing: the dock's top is at 0, so it lifts them by the page's whole height.
  expect(rule()).toBe(`[data-sonner-toaster][data-y-position="bottom"] { margin-bottom: ${document.documentElement.clientHeight}px !important; }`);
  fireEvent.click(dock.getByRole("button", { name: /^Chapters:/ }));
  act(() => within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("searchbox", { name: "Find in review" }).focus());
  expect(group.hidden).toBe(true);
  expect(rule()).toBeNull();
  act(() => (document.activeElement as HTMLElement).blur());
  expect(rule()).not.toBeNull();
  slot.lifecycle.unmount();
  expect(rule()).toBeNull();
});

test("the agent's sheet has no Pop out, and an agent popped out on a bigger screen shows in it", async () => {
  localStorage.setItem("gr:agentdock:pr-42", JSON.stringify({ mode: "widget", rect: { x: 10, y: 10, w: 300, h: 400 } }));
  const { slot, dock } = await renderPhone();
  fireEvent.click(dock.getByRole("button", { name: "Ask agent" }));
  const sheet = within(slot.getByRole("dialog", { name: "Review agent" }));
  expect(await sheet.findByRole("textbox", { name: "Ask the agent" })).toBeTruthy();
  expect(sheet.queryByRole("button", { name: "Pop out" })).toBeNull();
  expect(sheet.queryByRole("button", { name: "Dock" })).toBeNull();
  fireEvent.click(sheet.getByRole("button", { name: "Close" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  // Kept for where it can pop out.
  expect(JSON.parse(localStorage.getItem("gr:agentdock:pr-42")!).mode).toBe("widget");
  slot.lifecycle.unmount();
});

test("Esc in a menu the sheet opened closes the menu, and leaves the sheet open", async () => {
  const { slot, dock } = await renderPhone();
  fireEvent.click(dock.getByRole("button", { name: /^Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Review actions" }));
  const settings = await slot.findByRole("button", { name: "Review settings…" });
  fireEvent.keyDown(settings, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("button", { name: "Review settings…" })).toBeNull());
  expect(slot.getByRole("dialog", { name: "Chapters" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Esc closes the sheet wherever the focus is in the review, the dock included", async () => {
  const { slot, dock } = await renderPhone();
  const tab = dock.getByRole("button", { name: /^Comments/ });
  fireEvent.click(tab);
  expect(slot.getByRole("dialog", { name: "Comments" })).toBeTruthy();
  tab.focus();
  fireEvent.keyDown(tab, { key: "Escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});
