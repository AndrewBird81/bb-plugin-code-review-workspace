// @vitest-environment jsdom
// Folding and unfolding an iPhone Duo, or rotating a phone, resizes the window live: what you had open, typed and
// focused stays (lanes/00-devices.md, requirement 3). BB's pane narrowing alone keeps the shell's older rules.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });

/**
 * The workspace in a BB pane `width` × `height` (Safari's page less BB's bar), in a window that size plus BB's bar.
 * `fold` resizes both, as folding, unfolding or rotating does; `pane` resizes the pane alone, as BB's thread list does.
 */
function fakeScreen(width: number, height: number) {
  const size = { width, height, window: { width, height: height + 48 } };
  const original = globalThis.ResizeObserver;
  const reports: (() => void)[] = [];
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) {
      const report = () => this.notify([{ target, contentRect: { width: size.width, height: size.height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      reports.push(report);
      report();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => size.window.width });
  Object.defineProperty(root, "clientHeight", { configurable: true, get: () => size.window.height });
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = !!max && (max[1] === "width" ? size.width : size.height) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => {
    globalThis.ResizeObserver = original;
    matchMedia.mockRestore();
    delete (root as { clientWidth?: number }).clientWidth;
    delete (root as { clientHeight?: number }).clientHeight;
  });
  const report = () => act(() => reports.forEach((report) => report()));
  return {
    fold: (next: { width: number; height: number }) => { Object.assign(size, next, { window: { width: next.width, height: next.height + 48 } }); report(); },
    pane: (next: { width: number; height: number }) => { Object.assign(size, next); report(); },
  };
}

// The user's phones, as BB's pane in Safari (lanes/00-devices.md).
const OUTER = { width: 382, height: 550 };
const INNER_LANDSCAPE = { width: 951, height: 541 };
const INNER_PORTRAIT = { width: 669, height: 821 };

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };

async function renderWorkspace() {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  await slot.findByTestId("filediff");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const sheet = (slot: Slot, name: string) => slot.queryByRole("dialog", { name });
/** The chapters docked beside the code: shown, and not a dialog. */
const dockedChapters = (slot: Slot) => {
  const host = slot.container.ownerDocument.getElementById("gr-navigator-pr-42");
  return host && !host.hidden && !host.getAttribute("role") ? host : null;
};
const dockedPanel = (slot: Slot) => slot.queryByRole("complementary", { name: "Comments and agent" });

test("folded with Chapters open and Find half typed, unfolding docks them, and folding brings the sheet back: text, caret and focus kept", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  const find = within(sheet(slot, "Chapters")!).getByRole("searchbox", { name: "Find in review" }) as HTMLInputElement;
  find.focus();
  fireEvent.change(find, { target: { value: "cachex" } });
  find.setSelectionRange(4, 4);
  screen.fold(INNER_LANDSCAPE);
  expect(sheet(slot, "Chapters")).toBeNull();
  expect(dockedChapters(slot)).toBeTruthy();
  expect(document.activeElement).toBe(find);
  screen.fold(OUTER);
  expect(sheet(slot, "Chapters")).toBeTruthy();
  expect(document.activeElement).toBe(find);
  expect([find.value, find.selectionStart]).toEqual(["cachex", 4]);
  // Upright, unfolded, it's over the code.
  screen.fold(INNER_PORTRAIT);
  expect(slot.getByRole("dialog", { name: "Chapters" }).getAttribute("aria-modal")).toBe("true");
  slot.lifecycle.unmount();
});

test("folded with Chapters open, unfolding docks them and folding brings the sheet back, as often as it's done", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  for (let i = 0; i < 2; i++) {
    screen.fold(INNER_LANDSCAPE);
    expect(dockedChapters(slot)).toBeTruthy();
    screen.fold(OUTER);
    expect(sheet(slot, "Chapters")).toBeTruthy();
  }
  // Closed, they stay closed through the next fold.
  fireEvent.click(within(sheet(slot, "Chapters")!).getByRole("button", { name: "Close" }));
  screen.fold(INNER_LANDSCAPE);
  screen.fold(OUTER);
  expect(sheet(slot, "Chapters")).toBeNull();
  slot.lifecycle.unmount();
});

test("chapters docked on their own, not opened over the code, step aside as it folds, giving the focus to the chapters tab", async () => {
  const screen = fakeScreen(INNER_LANDSCAPE.width, INNER_LANDSCAPE.height);
  const slot = await renderWorkspace();
  // As after picking one: the focus on a row of the chapters.
  within(dockedChapters(slot)!).getByRole("button", { name: "Overview" }).focus();
  screen.fold(OUTER);
  expect(sheet(slot, "Chapters")).toBeNull();
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Chapters:/));
  slot.lifecycle.unmount();
});

test("typing in the docked chapters, a rotation keeps them open over the code, and docks them again", async () => {
  const screen = fakeScreen(INNER_LANDSCAPE.width, INNER_LANDSCAPE.height);
  const slot = await renderWorkspace();
  const find = within(dockedChapters(slot)!).getByRole("searchbox", { name: "Find in review" });
  find.focus();
  screen.fold(INNER_PORTRAIT);
  expect(slot.getByRole("dialog", { name: "Chapters" })).toBeTruthy();
  expect(document.activeElement).toBe(find);
  screen.fold(INNER_LANDSCAPE);
  expect(dockedChapters(slot)).toBeTruthy();
  expect(document.activeElement).toBe(find);
  slot.lifecycle.unmount();
});

test("Comments docked unfolded becomes the sheet as it folds, and docks again as it unfolds, keeping the focus", async () => {
  const screen = fakeScreen(INNER_LANDSCAPE.width, INNER_LANDSCAPE.height);
  const slot = await renderWorkspace();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = dockedPanel(slot)!;
  expect(panel).toBeTruthy();
  const close = within(panel).getByRole("button", { name: "Close panel" });
  close.focus();
  screen.fold(OUTER);
  expect(sheet(slot, "Comments")).toBe(panel);
  expect(document.activeElement).toBe(close);
  screen.fold(INNER_PORTRAIT);
  expect(slot.getByRole("dialog", { name: "Comments" })).toBe(panel);
  screen.fold(INNER_LANDSCAPE);
  expect(dockedPanel(slot)).toBe(panel);
  expect(document.activeElement).toBe(close);
  slot.lifecycle.unmount();
});

test("BB's pane narrowing, with the window as it was, still hides docked Comments until there's room", async () => {
  const screen = fakeScreen(INNER_LANDSCAPE.width, INNER_LANDSCAPE.height);
  const slot = await renderWorkspace();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  expect(dockedPanel(slot)).toBeTruthy();
  screen.pane({ width: 700, height: INNER_LANDSCAPE.height });
  expect(dockedPanel(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  screen.pane(INNER_LANDSCAPE);
  expect(dockedPanel(slot)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("typing on a phone, the keyboard shortening the workspace doesn't turn it into a phone held sideways", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  const root = slot.getByRole("main").closest<HTMLElement>("[class*='@container/review']")!;
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  within(sheet(slot, "Chapters")!).getByRole("searchbox", { name: "Find in review" }).focus();
  // The keyboard pads the workspace's bottom (lib/use-keyboard-inset.ts), and its content box shrinks.
  root.style.paddingBottom = "290px";
  screen.pane({ width: OUTER.width, height: OUTER.height - 290 });
  expect(slot.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  expect(sheet(slot, "Chapters")).toBeTruthy();
  slot.lifecycle.unmount();
});
