// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { getNavWidth, getPanelWidth, patchReviewState, setPanelWidth } from "../lib/panel-state";

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
  // 900 - 400 leaves 500: the panel docks narrower, keeping 560 for the code, and the chapters give way to it.
  fakePane(900);
  ({ slot, comments } = await renderWorkspace());
  fireEvent.click(comments);
  expect(panel(slot)).toBeTruthy();
  expect(chapters(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore()); localStorage.clear();
  // 860 leaves 540 beside even its narrowest, 320: the panel opens over the code, a modal dialog, and the chapters
  // stay docked under it.
  fakePane(860);
  ({ slot, comments } = await renderWorkspace());
  fireEvent.click(comments);
  const dialog = slot.getByRole("dialog", { name: "Comments" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById("gr-navigator-pr-42")!.hidden).toBe(false);
  slot.lifecycle.unmount();
});

test("over the code, the panel closes on Esc or a tap on the dimmed code, and a pick in it closes it to show what was picked", async () => {
  fakePane(860);
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

test("over the code, Tab in Finish review stops at Private notes, and goes past its notes while they're closed, to the verdict and Submit", async () => {
  fakePane(860);
  const { slot } = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "s" });
  const finish = within(await slot.findByRole("dialog", { name: "Finish review" }));
  const remove = await finish.findByRole("button", { name: "Remove comment on src/b.ts:1" });
  const notes = finish.getByText("Private notes").closest("summary")!;
  const approve = within(finish.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: "Approve" });
  const box = finish.getByRole("textbox", { name: "Private reviewer notes" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  // After the summary takes the focus as Finish opens.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const tab = (from: HTMLElement, shiftKey = false) => { from.focus(); fireEvent.keyDown(from, { key: "Tab", shiftKey }); return document.activeElement; };
  expect(tab(remove)).toBe(notes);
  // jsdom draws a closed <details>' content, which a browser doesn't, and can't focus.
  expect(tab(notes)).toBe(approve);
  expect(tab(approve, true)).toBe(notes);
  expect(tab(notes, true)).toBe(remove);
  (notes.parentElement as HTMLDetailsElement).open = true;
  expect(tab(notes)).toBe(box);
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

test("docked narrower than its width (an unfolded iPhone Duo's 951), a touch of the panel's handle, or a key that can't widen it, saves nothing; a double tap saves its first width", async () => {
  setPanelWidth(500);
  fakePane(951);
  const { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  const handle = slot.getByRole("separator", { name: "Resize panel" });
  expect(handle.getAttribute("aria-valuenow")).toBe("391");
  fireEvent.pointerDown(handle, { button: 0, clientX: 560, timeStamp: 1000 });
  fireEvent.pointerUp(window);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  fireEvent.keyDown(handle, { key: "End" });
  expect(getPanelWidth()).toBe(500);
  expect(handle.getAttribute("aria-valuenow")).toBe("391");
  // Its first width, which shows as wide as there's room for.
  fireEvent.pointerDown(handle, { button: 0, clientX: 560, timeStamp: 5000 });
  fireEvent.pointerUp(window);
  fireEvent.pointerDown(handle, { button: 0, clientX: 560, timeStamp: 5100 });
  expect(getPanelWidth()).toBe(400);
  expect(handle.getAttribute("aria-valuenow")).toBe("391");
  slot.lifecycle.unmount();
});

test("padded clear of a screen edge's inset (a phone's rail), the sides still keep the code at 560px inside the padding", async () => {
  fakePane(1400);
  const { slot, comments } = await renderWorkspace();
  fireEvent.click(comments);
  slot.getByRole("main").closest<HTMLElement>("[class*='@container/review']")!.style.paddingRight = "84px";
  const navHandle = slot.getByRole("separator", { name: "Resize chapters" });
  const panelHandle = slot.getByRole("separator", { name: "Resize panel" });
  fireEvent.keyDown(navHandle, { key: "ArrowRight" });
  fireEvent.pointerDown(panelHandle, { button: 0, clientX: 1000 });
  fireEvent.pointerMove(window, { clientX: 400 });
  fireEvent.pointerUp(window);
  expect(panelHandle.getAttribute("aria-valuenow")).toBe(String(1400 - 84 - 560 - 308));
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

/** A browser's :focus-visible, which jsdom matches on any focus: focus after a key matches, after a pointer it doesn't. */
function fakeFocusVisible() {
  let keyboard = true;
  const onKey = () => { keyboard = true; };
  const onPointer = () => { keyboard = false; };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  const matches = Element.prototype.matches;
  const spy = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":focus-visible" ? keyboard && this === document.activeElement : matches.call(this, selector);
  });
  restores.push(() => { spy.mockRestore(); document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); });
}

test("closing a side gives the focus back to what opened it, after a click as after a key; only the key's focus opens a tooltip there", async () => {
  fakePane(1400);
  fakeFocusVisible();
  const { slot, comments } = await renderWorkspace();
  comments.focus();
  fireEvent.keyDown(comments, { key: "Enter" });
  fireEvent.click(comments, { detail: 0 });
  const close = within(panel(slot)!).getByRole("button", { name: "Close panel" });
  close.focus();
  fireEvent.keyDown(close, { key: "Enter" });
  fireEvent.click(close, { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(comments));
  expect((await slot.findByRole("tooltip")).textContent).toBe("Comments (c)");
  // A click presses and lets go on the button.
  const click = (button: HTMLElement) => { fireEvent.pointerDown(button); fireEvent.pointerUp(button); fireEvent.click(button); };
  click(comments);
  const again = within(panel(slot)!).getByRole("button", { name: "Close panel" });
  again.focus();
  click(again);
  await waitFor(() => expect(document.activeElement).toBe(comments));
  await new Promise((resolve) => setTimeout(resolve, 400));
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
  const code = () => slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  await slot.findByText("bb");
  expect(top).toBe(100);
  // The browser's scroll anchoring, which would move the code off its place as the diff above it draws, waits.
  expect(code().style.overflowAnchor).toBe("none");
  room = 1000;
  await waitFor(() => expect(top).toBe(500));
  expect(code().style.overflowAnchor).toBe("none");
  slot.lifecycle.unmount();
  room = 100; top = 0;
  localStorage.setItem("gr:panelstate", JSON.stringify({ layoutVersion: 2, perReview: { "pr-42": { activeId: "c2", scrollTop: 500 } } }));
  ({ slot } = await renderWorkspace({ opened: false }));
  await slot.findByText("bb");
  fireEvent.wheel(code());
  expect(code().style.overflowAnchor).toBe("");
  room = 1000;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(top).toBe(100);
  slot.lifecycle.unmount();
});
