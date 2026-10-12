// @vitest-environment jsdom
// Folding and unfolding an iPhone Duo, or rotating a phone, resizes the window live: what you had open, typed and
// focused stays (lanes/00-devices.md, requirement 3). BB's pane narrowing alone, and an iPad's or a desktop's window
// resizing, keep the shell's older rules.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The diff draws the comment box under its line, and picks a line as a tap on its number does.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => {
    const pick = () => { const range = { start: 1, side: "additions", end: 1, endSide: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
      <button onClick={pick}>Pick line 1</button>
    </div>;
  },
}));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });

/**
 * The workspace in a BB pane `width` × `height`, in a window (`window`: by default the pane plus BB's bar, as Safari's
 * page on a phone), on a touch screen, or a desktop's (`pointer: "fine"`). `fold` resizes both, the window to the pane
 * plus BB's bar, as folding, unfolding or rotating a phone does; `pane` resizes the pane alone, as BB's thread list
 * does; `resize` resizes each to its own size, as an iPad's rotation or Split View, or a desktop's window, does.
 */
function fakeScreen(width: number, height: number, { pointer = "coarse", window: frame = { width, height: height + 48 } }: { pointer?: "coarse" | "fine"; window?: Size } = {}) {
  const size = { width, height, window: frame };
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
    const matches = query === "(pointer: coarse)" ? pointer === "coarse" : !!max && (max[1] === "width" ? size.width : size.height) <= Number(max[2]);
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
    fold: (next: Size) => { Object.assign(size, next, { window: { width: next.width, height: next.height + 48 } }); report(); },
    pane: (next: Size) => { Object.assign(size, next); report(); },
    resize: (next: Size, frame: Size) => { Object.assign(size, next, { window: frame }); report(); },
  };
}
type Size = { width: number; height: number };

// The user's phones, as BB's pane in Safari (lanes/00-devices.md).
const OUTER = { width: 382, height: 550 };
const INNER_LANDSCAPE = { width: 951, height: 541 };
const INNER_PORTRAIT = { width: 669, height: 821 };
// The 13" iPad with BB's thread list open, each way (spec §3.1), and a desktop's 1440 × 900 window with it open.
const IPAD_LANDSCAPE = { pane: { width: 1056, height: 984 }, window: { width: 1376, height: 1032 } };
const IPAD_PORTRAIT = { pane: { width: 712, height: 1328 }, window: { width: 1032, height: 1376 } };
const DESKTOP = { pane: { width: 1120, height: 852 }, window: { width: 1440, height: 900 } };

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

/** Starts a comment on line 1 of the code, from the selection bar, and types half of it: the caret mid-word. */
async function typeInlineComment(slot: Slot) {
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  fireEvent.click(within(slot.getByRole("button", { name: "Clear selection" }).parentElement!).getByRole("button", { name: "Comment" }));
  const box = await within(slot.getByTestId("filediff")).findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  box.focus();
  fireEvent.change(box, { target: { value: "Does this need a test" } });
  box.setSelectionRange(4, 4);
  return box;
}
/** Still typing in `box`: the focus, the text and the caret where they were, and nothing over it (a sheet makes the code inert). */
function stillTyping(slot: Slot, box: HTMLTextAreaElement) {
  expect(document.activeElement).toBe(box);
  expect([box.value, box.selectionStart]).toEqual(["Does this need a test", 4]);
  expect(slot.getByRole("main").hasAttribute("inert")).toBe(false);
  expect(slot.queryByRole("dialog")).toBeNull();
}

test("typing a comment in the code beside docked Comments, folding or turning steps Comments aside rather than cover the box, and it docks again", async () => {
  const screen = fakeScreen(INNER_LANDSCAPE.width, INNER_LANDSCAPE.height);
  const slot = await renderWorkspace();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = dockedPanel(slot)!;
  const box = await typeInlineComment(slot);
  screen.fold(OUTER);
  expect(dockedPanel(slot)).toBeNull();
  stillTyping(slot, box);
  screen.fold(INNER_LANDSCAPE);
  expect(dockedPanel(slot)).toBe(panel);
  stillTyping(slot, box);
  // Upright, unfolded, the same.
  screen.fold(INNER_PORTRAIT);
  expect(dockedPanel(slot)).toBeNull();
  stillTyping(slot, box);
  screen.fold(INNER_LANDSCAPE);
  expect(dockedPanel(slot)).toBe(panel);
  stillTyping(slot, box);
  slot.lifecycle.unmount();
});

test("typing a comment in the code, chapters opened folded and docked as it unfolded step aside as it folds again, rather than cover the box", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  screen.fold(INNER_LANDSCAPE);
  expect(dockedChapters(slot)).toBeTruthy();
  const box = await typeInlineComment(slot);
  screen.fold(OUTER);
  stillTyping(slot, box);
  // Not typing any more, a fold doesn't bring them back over the code either: they were hidden.
  box.blur();
  screen.fold(INNER_LANDSCAPE);
  screen.fold(OUTER);
  expect(sheet(slot, "Chapters")).toBeNull();
  slot.lifecycle.unmount();
});

test("on a desktop, a window resize hides docked Comments as BB's pane narrowing does, leaves the focus where it is, and docks it again with room", async () => {
  const screen = fakeScreen(DESKTOP.pane.width, DESKTOP.pane.height, { pointer: "fine", window: DESKTOP.window });
  const slot = await renderWorkspace();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = dockedPanel(slot)!;
  const options = slot.getByRole("button", { name: "Diff options" });
  options.focus();
  // Narrower than the code and the panel need, then snapped to half the screen, under a phone's width.
  screen.resize({ width: 680, height: 852 }, { width: 1000, height: 900 });
  expect(dockedPanel(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(options);
  screen.resize({ width: 400, height: 852 }, { width: 720, height: 900 });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(slot.getByRole("main").hasAttribute("inert")).toBe(false);
  screen.resize(DESKTOP.pane, DESKTOP.window);
  expect(dockedPanel(slot)).toBe(panel);
  slot.lifecycle.unmount();
});

test("an iPad's rotation hides docked Comments, as BB's pane narrowing does, and docks it again as it turns back; so does Split View", async () => {
  const screen = fakeScreen(IPAD_LANDSCAPE.pane.width, IPAD_LANDSCAPE.pane.height, { window: IPAD_LANDSCAPE.window });
  const slot = await renderWorkspace();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = dockedPanel(slot)!;
  screen.resize(IPAD_PORTRAIT.pane, IPAD_PORTRAIT.window);
  expect(dockedPanel(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  screen.resize(IPAD_LANDSCAPE.pane, IPAD_LANDSCAPE.window);
  expect(dockedPanel(slot)).toBe(panel);
  // Full screen to half of it in Split View, under the smallest iPad's width: still the iPad's rules.
  screen.resize({ width: 678, height: 984 }, { width: 678, height: 1032 });
  expect(dockedPanel(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});

test("chapters opened folded and docked as it unfolded hide as BB's pane narrows, rather than open over the code by themselves", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  screen.fold(INNER_LANDSCAPE);
  expect(dockedChapters(slot)).toBeTruthy();
  screen.pane({ width: 800, height: INNER_LANDSCAPE.height });
  expect(dockedChapters(slot)).toBeNull();
  expect(slot.queryByRole("dialog")).toBeNull();
  // Nor on the next render.
  fireEvent.click(slot.getByRole("button", { name: "Fold comments in code" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  screen.pane(INNER_LANDSCAPE);
  expect(dockedChapters(slot)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("unfolded, chapters peeked at beside docked Comments and docked as it closes hide as BB's pane narrows, rather than open over the code", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  screen.fold(INNER_LANDSCAPE);
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  expect(sheet(slot, "Chapters")).toBeTruthy();
  fireEvent.click(within(dockedPanel(slot)!).getByRole("button", { name: "Close panel" }));
  expect(dockedChapters(slot)).toBeTruthy();
  screen.pane({ width: 800, height: INNER_LANDSCAPE.height });
  expect(slot.queryByRole("dialog")).toBeNull();
  slot.lifecycle.unmount();
});

test("unfolded, chapters peeked at beside docked Comments: folding shows the one sheet, the chapters, and unfolding brings back both as they were", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  screen.fold(INNER_LANDSCAPE);
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  const panel = dockedPanel(slot)!;
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  screen.fold(OUTER);
  expect(slot.getAllByRole("dialog").map((dialog) => dialog.getAttribute("aria-label"))).toEqual(["Chapters"]);
  screen.fold(INNER_LANDSCAPE);
  expect(sheet(slot, "Chapters")).toBeTruthy();
  expect(dockedPanel(slot)).toBe(panel);
  slot.lifecycle.unmount();
});

/**
 * The code in the workspace's scroll `box`, which jsdom doesn't lay out: 30 lines 40px tall in the file's diff, the box
 * 380 × 500 at y 100 and scrolled to 300, with what's at each point found from those (lib/use-scroll-anchor.ts).
 */
function fakeCode(box: HTMLElement, diff: HTMLElement) {
  const size = { width: 380, height: 500 };
  const lines = Array.from({ length: 30 }, (_, i) => {
    const line = diff.appendChild(document.createElement("div"));
    line.dataset.line = String(i + 1);
    return line;
  });
  const heights = lines.map(() => 40);
  Object.defineProperty(box, "clientWidth", { configurable: true, get: () => size.width });
  Object.defineProperty(box, "clientHeight", { configurable: true, get: () => size.height });
  box.getBoundingClientRect = () => new DOMRect(0, 100, size.width, size.height);
  box.scrollTop = 300;
  const topOf = (index: number) => 100 - box.scrollTop + heights.slice(0, index).reduce((sum, h) => sum + h, 0);
  lines.forEach((line, i) => { line.getBoundingClientRect = () => new DOMRect(0, topOf(i), size.width, heights[i]); });
  document.elementsFromPoint = (_x: number, y: number) => {
    const line = lines.find((_, i) => y >= topOf(i) && y < topOf(i) + heights[i]);
    return [...(line ? [line, box] : [box]), document.body];
  };
  restores.push(() => { delete (document as { elementsFromPoint?: unknown }).elementsFromPoint; });
  return { lines, heights, size };
}

test("a comment unfolding above the line you read, without a scroll, then the box resizing as the dock hides: the code stays where it is", async () => {
  const screen = fakeScreen(OUTER.width, OUTER.height);
  const slot = await renderWorkspace();
  const box = slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  const { lines, heights, size } = fakeCode(box, slot.getByTestId("filediff"));
  // What's at the top is read as the box reports: line 8.
  screen.pane(OUTER);
  // A comment under line 7 unfolds, 150px taller: line 8 and what follows move down, with no scroll.
  heights[6] += 150;
  screen.pane(OUTER);
  expect(box.scrollTop).toBe(300);
  const reading = lines[7].getBoundingClientRect().top;
  // Tapping a line hides the dock: the box is 52px taller, and nothing rewraps.
  size.height += 52;
  screen.pane(OUTER);
  expect(box.scrollTop).toBe(300);
  expect(lines[7].getBoundingClientRect().top).toBe(reading);
  slot.lifecycle.unmount();
});
