// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getNavWidth, getPanelWidth, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));

const restores: (() => void)[] = [];
// jsdom has no PointerEvent: a mouse event stands in, for the resize handles' drags.
globalThis.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });

/** Every ResizeObserver reports this size, as if the workspace sat in a BB pane that size; `resize` changes it. */
function fakePane(width: number, height = 900) {
  const original = globalThis.ResizeObserver;
  const observers: (() => void)[] = [];
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      const report = () => this.notify([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      observers.push(report);
      report();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The pane's width for the resize handles, which measure it.
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get() { return width; } });
  restores.push(() => { globalThis.ResizeObserver = original; Object.defineProperty(Element.prototype, "clientWidth", clientWidth); });
  return { resize: (next: number) => { width = next; act(() => observers.forEach((report) => report())); } };
}

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [
  { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] },
  { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts" }] },
] };

async function renderWorkspace({ opened = true }: { opened?: boolean } = {}) {
  if (opened && !localStorage.getItem("gr:panelstate")) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ file: "src/b.ts", line: 1, side: "RIGHT", body: "Cache it." }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  await slot.findByRole("main", { name: "Review" });
  // The commands sit in the band, where BB's title bar didn't take them.
  const comments = await slot.findByRole("button", { name: "Comments" });
  return { slot, comments };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const panel = (slot: Slot) => slot.queryByRole("complementary", { name: "Comments and agent" });
const chapters = (slot: Slot) => slot.queryByRole("navigation", { name: "Chapters" });

test("the panel docks where the code keeps 560px, and the chapters dock beside it only with room for both", async () => {
  fakePane(1400);
  let { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  expect(panel(slot)).toBeTruthy();
  expect(chapters(slot)).toBeTruthy();
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore()); localStorage.clear();
  // 1056 - 400 leaves 656 for the code: the panel docks, and the chapters give way to it.
  fakePane(1056);
  ({ slot, comments } = await renderWorkspace());
  expect(chapters(slot)).toBeTruthy();
  fireEvent.click(comments);
  expect(panel(slot)).toBeTruthy();
  expect(chapters(slot)).toBeNull();
  expect(slot.getByRole("button", { name: "Show chapters" })).toBeTruthy();
  // Closing the panel docks them again.
  fireEvent.click(within(panel(slot)!).getByRole("button", { name: "Close panel" }));
  expect(chapters(slot)).toBeTruthy();
  slot.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore()); localStorage.clear();
  // 900 - 400 leaves 500: the panel opens over the code, a modal dialog, and the chapters stay docked under it.
  fakePane(900);
  ({ slot, comments } = await renderWorkspace());
  fireEvent.click(comments);
  const dialog = slot.getByRole("dialog", { name: "Comments" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById("gr-navigator-pr-42")!.hidden).toBe(false);
  slot.lifecycle.unmount();
});

test("over the code, the panel closes on Esc or a tap on the dimmed code, and a pick in it closes it to show what was picked", async () => {
  fakePane(900);
  const { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Comments" }), { key: "Escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  fireEvent.click(comments);
  fireEvent.click(slot.container.querySelector<HTMLElement>(".bg-black\\/40")!);
  expect(slot.queryByRole("dialog")).toBeNull();
  fireEvent.click(comments);
  fireEvent.click(within(slot.getByRole("dialog", { name: "Comments" })).getByRole("button", { name: /^src\/b\.ts:1/ }));
  expect(slot.queryByRole("dialog")).toBeNull();
  await slot.findByText("bb");
  slot.lifecycle.unmount();
});

test("with the panel docked, the chapters toggle peeks the chapters over the code; a pick closes them, and the panel stays", async () => {
  fakePane(1056);
  const { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  const peek = slot.getByRole("dialog", { name: "Chapters" });
  expect(panel(slot)).toBeTruthy();
  fireEvent.click(within(peek).getByText("Caching"));
  expect(slot.queryByRole("dialog", { name: "Chapters" })).toBeNull();
  await slot.findByText("bb");
  expect(panel(slot)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the chapters and the panel resize by dragging or arrow keys, keep the code at 560px or wider, and keep their widths in every review", async () => {
  fakePane(1400);
  const { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  const navHandle = slot.getByRole("separator", { name: "Resize chapters" });
  const panelHandle = slot.getByRole("separator", { name: "Resize panel" });
  expect([navHandle.getAttribute("aria-valuenow"), panelHandle.getAttribute("aria-valuenow")]).toEqual(["288", "400"]);
  fireEvent.keyDown(navHandle, { key: "ArrowRight" });
  expect(navHandle.getAttribute("aria-valuenow")).toBe("308");
  // The panel's handle is on its left: dragging it left widens the panel, as far as the code keeps 560px.
  fireEvent.pointerDown(panelHandle, { button: 0, clientX: 1000 });
  fireEvent.pointerMove(window, { clientX: 400 });
  fireEvent.pointerUp(window);
  expect(panelHandle.getAttribute("aria-valuenow")).toBe(String(1400 - 560 - 308));
  expect([getNavWidth(), getPanelWidth()]).toEqual([308, 532]);
  // Twice in a row, as a double-click or a double tap: its first width back.
  fireEvent.pointerDown(panelHandle, { button: 0, clientX: 600, timeStamp: 1000 });
  fireEvent.pointerUp(window);
  fireEvent.pointerDown(panelHandle, { button: 0, clientX: 600, timeStamp: 1100 });
  expect(panelHandle.getAttribute("aria-valuenow")).toBe("400");
  slot.lifecycle.unmount();
});

test("a panel left open opens again only where it docks, and a pane too narrow for it doesn't forget it", async () => {
  fakePane(1400);
  let { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  slot.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore());
  fakePane(800);
  ({ slot } = await renderWorkspace());
  expect(panel(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore());
  fakePane(1400);
  ({ slot } = await renderWorkspace());
  expect(panel(slot)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("closing a side from the keyboard gives the focus back to what opened it; a click leaves it, so no tooltip opens there", async () => {
  fakePane(1400);
  const { slot, comments } = await renderWorkspace();
  comments.focus();
  fireEvent.keyDown(comments, { key: "Enter" });
  fireEvent.click(comments, { detail: 0 });
  const close = within(panel(slot)!).getByRole("button", { name: "Close panel" });
  close.focus();
  fireEvent.keyDown(close, { key: "Enter" });
  fireEvent.click(close, { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(comments));
  fireEvent.pointerDown(comments);
  fireEvent.click(comments);
  const again = within(panel(slot)!).getByRole("button", { name: "Close panel" });
  again.focus();
  fireEvent.pointerDown(again);
  fireEvent.click(again);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(document.activeElement).not.toBe(comments);
  expect(slot.queryByRole("tooltip")).toBeNull();
  slot.lifecycle.unmount();
});

test("the chapters hidden with the focus in them, as when the pane gets too narrow for them, give it to the chapters toggle", async () => {
  const pane = fakePane(1056);
  const { slot } = await renderWorkspace();
  const chapter = within(chapters(slot)!).getByText("Caching").closest("button")!;
  chapter.focus();
  fireEvent.keyDown(chapter, { key: "Tab" });
  // BB's thread list opens beside the pane: the chapters no longer fit beside the code.
  pane.resize(700);
  expect(chapters(slot)).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(within(slot.getByRole("navigation", { name: "Breadcrumb" }).parentElement!).getByRole("button", { name: "Show chapters" })));
  slot.lifecycle.unmount();
});

test("an older version's saved state opens at its chapter and scroll position, with its open tool as the docked panel", async () => {
  fakePane(1400);
  const errors = vi.spyOn(console, "error");
  localStorage.setItem("gr:panelstate", JSON.stringify({
    lastTargetKey: "pr-42", navView: "chapters",
    perReview: { "pr-42": { activeId: "c2", view: "diff", scrollTop: 120, sidebarWidth: 340, headerCollapsed: true, activeTool: "agent", toolsOpen: true } },
  }));
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  const scrolled: number[] = [];
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return 0; }, set(value: number) { scrolled.push(value); } });
  restores.push(() => Object.defineProperty(Element.prototype, "scrollTop", scrollTop));
  const { slot } = await renderWorkspace({ opened: false });
  await slot.findByText("bb");
  expect(scrolled).toContain(120);
  expect(within(panel(slot)!).getByRole("region", { name: "Review agent" })).toBeTruthy();
  expect(slot.getByRole("separator", { name: "Resize chapters" }).getAttribute("aria-valuenow")).toBe("340");
  expect(errors).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test("a saved scroll position the diff can't reach yet is reached as its files draw, unless you scroll first", async () => {
  fakePane(1400);
  // How far the code can scroll so far, as its files draw.
  let room = 100;
  let top = 0;
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return top; }, set(value: number) { top = Math.min(value, room); } });
  restores.push(() => Object.defineProperty(Element.prototype, "scrollTop", scrollTop));
  localStorage.setItem("gr:panelstate", JSON.stringify({ layoutVersion: 2, perReview: { "pr-42": { activeId: "c2", scrollTop: 500 } } }));
  let { slot } = await renderWorkspace({ opened: false });
  await slot.findByText("bb");
  expect(top).toBe(100);
  room = 1000;
  await waitFor(() => expect(top).toBe(500));
  slot.lifecycle.unmount();
  room = 100; top = 0;
  localStorage.setItem("gr:panelstate", JSON.stringify({ layoutVersion: 2, perReview: { "pr-42": { activeId: "c2", scrollTop: 500 } } }));
  ({ slot } = await renderWorkspace({ opened: false }));
  await slot.findByText("bb");
  fireEvent.wheel(slot.getByRole("main").querySelector(".overflow-y-auto")!);
  room = 1000;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(top).toBe(100);
  slot.lifecycle.unmount();
});
