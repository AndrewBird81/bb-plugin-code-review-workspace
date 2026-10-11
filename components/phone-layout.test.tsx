// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });

/** Every ResizeObserver reports this size, and media queries answer for a screen this size. */
function fakeSize(width: number, height: number) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = !!max && (max[1] === "width" ? width : height) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); });
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };

async function renderWorkspace() {
  // The review panel was left open on a bigger screen.
  patchReviewState("pr-42", { activeTool: "draft", toolsOpen: true });
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
  await slot.findAllByText("Parse rows");
  await slot.findByTestId("filediff");
  return slot;
}

test("on a phone the top bar keeps to one row: Ask agent and Settings move into the actions menu", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  const bar = within(slot.getByRole("button", { name: "All reviews" }).parentElement!);
  expect(bar.queryByRole("button", { name: "Ask agent" })).toBeNull();
  expect(bar.queryByRole("button", { name: "Settings" })).toBeNull();
  fireEvent.click(bar.getByRole("button", { name: "Review actions" }));
  fireEvent.click(await slot.findByRole("button", { name: "Settings" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "settings/pr-42" } }));
  fireEvent.click(bar.getByRole("button", { name: "Review actions" }));
  // Not the review panel's own Ask agent.
  fireEvent.click((await slot.findAllByRole("button", { name: "Ask agent" })).find((button) => !button.closest('[role="group"]'))!);
  expect(await slot.findByRole("textbox", { name: "Ask the agent" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on a phone the toolbar keeps to counts and icons, without Split, which can't apply there", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  expect(main.queryByRole("button", { name: "Split view" })).toBeNull();
  const mark = main.getByRole("button", { name: "Mark chapter viewed" });
  expect(within(mark).getByText("Mark chapter viewed").className).toContain("sr-only");
  expect(main.getByText("in this chapter", { exact: false }).className).toContain("sr-only");
  slot.lifecycle.unmount();
});

test("on a phone the chapters give way to the open review panel and scroll, rather than draw over it", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  const main = slot.getByRole("main");
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  const chapters = main.parentElement!.querySelector(":scope > aside")!;
  // Below their 40vh cap when the panel takes the rest, scrolling inside; beside the diff on a wider screen, their width holds.
  expect(chapters.className.split(" ")).not.toContain("shrink-0");
  expect(chapters.className).toContain("overflow-y-auto");
  expect(chapters.className).toContain("@min-[768px]/review:shrink-0");
  expect(main.parentElement!.className.split(" ")).toContain("overflow-hidden");
  // The toolbar's first row keeps its room.
  expect(main.className.split(" ")).toContain("min-h-12");
  slot.lifecycle.unmount();
});

test("a phone held sideways keeps the toolbar to counts and icons, so it fits one row", async () => {
  fakeSize(844, 390);
  const slot = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  expect(within(main.getByRole("button", { name: "Mark chapter viewed" })).getByText("Mark chapter viewed").className).toContain("sr-only");
  expect(main.getByText("in this chapter", { exact: false }).className).toContain("sr-only");
  expect(within(main.getByRole("button", { name: "Wrap lines" })).getByText("Wrap").className).toBe("hidden");
  slot.lifecycle.unmount();
});

test("a phone held sideways folds the review's title and Re-review into the top bar, with Ask agent and Settings in the actions menu", async () => {
  fakeSize(844, 390);
  const slot = await renderWorkspace();
  const bar = within(slot.getByRole("button", { name: "All reviews" }).parentElement!);
  expect(bar.getByText("Parse rows")).toBeTruthy();
  // The title needs the room: All reviews keeps to its arrow.
  expect(slot.getByRole("button", { name: "All reviews" }).textContent).toBe("");
  expect(await bar.findByRole("button", { name: "Re-review" })).toBeTruthy();
  expect(bar.queryByRole("button", { name: "Ask agent" })).toBeNull();
  expect(slot.getAllByText("Parse rows")).toHaveLength(1);
  fireEvent.click(bar.getByRole("button", { name: "Review actions" }));
  expect(await slot.findByRole("button", { name: "Settings" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on a wide screen the top bar and toolbar keep their labels", async () => {
  fakeSize(1400, 900);
  const slot = await renderWorkspace();
  const bar = within(slot.getByRole("button", { name: "All reviews" }).parentElement!);
  expect(bar.getByRole("button", { name: "Ask agent" })).toBeTruthy();
  expect(bar.getByRole("button", { name: "Settings" })).toBeTruthy();
  const main = within(slot.getByRole("main"));
  expect(main.getByRole("button", { name: "Split view" })).toBeTruthy();
  expect(main.getByText("0/1 in this chapter")).toBeTruthy();
  expect(within(main.getByRole("button", { name: "Mark chapter viewed" })).getByText("Mark chapter viewed").className).not.toContain("sr-only");
  // The icons' labels show by the toolbar's own width, which the chapters and review panel narrow: Hide whitespace's too.
  const label = (name: string, text: string) => within(main.getByRole("button", { name })).getByText(text).className;
  expect(label("Wrap lines", "Wrap")).toContain("/toolbar:inline");
  expect(label("Hide whitespace", "Hide whitespace")).toBe(label("Wrap lines", "Wrap"));
  // Not short: chapters, the overview, the full header, and the saved open panel show.
  expect(bar.getByRole("button", { name: "Hide chapters" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Hide chapter overview" })).toBeTruthy();
  expect(slot.getByRole("heading", { name: "Parse rows" })).toBeTruthy();
  expect(within(slot.getByRole("group", { name: "Review tools" })).getByRole("button", { name: "Draft review" }).getAttribute("aria-expanded")).toBe("true");
  // Collapsed there, the header keeps its title out of the top bar.
  fireEvent.click(slot.getByRole("button", { name: "Collapse header" }));
  expect(bar.queryByText("Parse rows")).toBeNull();
  expect(slot.getByText("Parse rows")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a phone held sideways opens on code: the header collapsed, and the chapters, overview and review panel hidden until shown", async () => {
  fakeSize(844, 390);
  const slot = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  expect(slot.getByRole("button", { name: "Expand header" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Show chapters" }).getAttribute("aria-pressed")).toBe("false");
  expect(slot.queryByText("Reads rows.")).toBeNull();
  expect(within(slot.getByRole("group", { name: "Review tools" })).getByRole("button", { name: "Draft review" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  expect(slot.getByRole("button", { name: "Hide chapters" })).toBeTruthy();
  fireEvent.click(main.getByRole("button", { name: "Show chapter overview" }));
  expect(await within(main.getByRole("region", { name: "Parsing" })).findByText("Reads rows.")).toBeTruthy();
  slot.lifecycle.unmount();
  // Showing the overview sticks in this browser, even on a short screen.
  const again = await renderWorkspace();
  expect(again.getByRole("button", { name: "Hide chapter overview" })).toBeTruthy();
  again.lifecycle.unmount();
});

test("the chapters toggle sits beside All reviews, not in the diff's toolbar", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  const toggle = slot.getByRole("button", { name: "Show chapters" });
  expect(slot.getByRole("button", { name: "All reviews" }).nextElementSibling).toBe(toggle);
  const main = within(slot.getByRole("main"));
  expect(main.queryByRole("button", { name: /chapters$/ })).toBeNull();
  fireEvent.click(toggle);
  expect(slot.getByRole("main").parentElement!.querySelector(":scope > aside")).toBeTruthy();
  expect(toggle.getAttribute("aria-label")).toBe("Hide chapters");
  slot.lifecycle.unmount();
});

test("the header collapses from its top-right corner and expands from the same spot, saved for the review", async () => {
  fakeSize(1400, 900);
  const slot = await renderWorkspace();
  const header = slot.getByRole("heading", { name: "Parse rows" }).closest("header")!;
  expect(header.lastElementChild).toBe(slot.getByRole("button", { name: "Collapse header" }));
  expect(slot.getByText("Parses rows.")).toBeTruthy();
  expect(within(slot.getByRole("main")).queryByRole("button", { name: "Focus mode" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Collapse header" }));
  expect(slot.queryByText("Parses rows.")).toBeNull();
  const expand = slot.getByRole("button", { name: "Expand header" });
  expect(expand.parentElement!.lastElementChild).toBe(expand);
  slot.lifecycle.unmount();
  const again = await renderWorkspace();
  fireEvent.click(again.getByRole("button", { name: "Expand header" }));
  expect(again.getByText("Parses rows.")).toBeTruthy();
  again.lifecycle.unmount();
});

test("a phone opens on the collapsed header, even for a review an earlier version saved with Focus off", async () => {
  fakeSize(390, 844);
  localStorage.setItem("gr:panelstate", JSON.stringify({ perReview: { "pr-42": { focus: false } } }));
  const slot = await renderWorkspace();
  expect(slot.getByRole("button", { name: "Expand header" })).toBeTruthy();
  expect(slot.queryByText("Parses rows.")).toBeNull();
  // Expanded, the title row's actions wrap within the screen rather than run off it.
  fireEvent.click(slot.getByRole("button", { name: "Expand header" }));
  const actions = slot.getByRole("button", { name: "Re-review" }).closest("div")!;
  expect(actions.className.split(" ")).toContain("min-w-0");
  expect(actions.className.split(" ")).not.toContain("shrink-0");
  slot.lifecycle.unmount();
});

test("where the browser can't go full screen, as on an iPhone, Full screen covers the window from the top layer, overlays and all", async () => {
  fakeSize(390, 844);
  const show = vi.fn(), hide = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: show });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: hide });
  restores.push(() => { delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover; delete (HTMLElement.prototype as { hidePopover?: unknown }).hidePopover; });
  const slot = await renderWorkspace();
  expect(document.fullscreenEnabled).toBeFalsy();
  const root = slot.getByRole("button", { name: "All reviews" }).closest("[class*='@container/review']")!;
  fireEvent.click(slot.getByRole("button", { name: "Full screen" }));
  expect(show.mock.contexts).toEqual([root]);
  expect(root.getAttribute("popover")).toBe("manual");
  expect(root.className.split(" ")).toEqual(expect.arrayContaining(["fixed", "inset-0", "pt-[env(safe-area-inset-top)]"]));
  fireEvent.click(slot.getByRole("button", { name: "Review actions" }));
  expect(root.contains(await slot.findByRole("button", { name: "Settings" }))).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(slot.getByRole("button", { name: "Exit full screen" }));
  expect(hide.mock.contexts).toEqual([root]);
  expect(root.hasAttribute("popover")).toBe(false);
  expect(root.className.split(" ")).not.toContain("fixed");
  slot.lifecycle.unmount();
});

test("where the browser can neither go full screen nor cover the window, there's no Full screen button", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  expect(slot.queryByRole("button", { name: "Full screen" })).toBeNull();
  slot.lifecycle.unmount();
});

test("where the browser can go full screen, Full screen asks it to, for the workspace", async () => {
  fakeSize(1400, 900);
  const request = vi.fn(() => Promise.resolve());
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  restores.push(() => { delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled; delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen; });
  const slot = await renderWorkspace();
  const root = slot.getByRole("button", { name: "All reviews" }).closest("[class*='@container/review']")!;
  fireEvent.click(slot.getByRole("button", { name: "Full screen" }));
  expect(request.mock.contexts).toEqual([root]);
  expect(root.className.split(" ")).not.toContain("fixed");
  slot.lifecycle.unmount();
});

test("collapsing or expanding the header from the keyboard keeps the focus on its chevron; a click doesn't move it", async () => {
  fakeSize(1400, 900);
  const slot = await renderWorkspace();
  fireEvent.click(slot.getByRole("button", { name: "Collapse header" }), { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Expand header" })));
  fireEvent.click(slot.getByRole("button", { name: "Expand header" }), { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: "Collapse header" })));
  (document.activeElement as HTMLElement).blur();
  fireEvent.click(slot.getByRole("button", { name: "Collapse header" }), { detail: 1 });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(document.activeElement).toBe(document.body);
  slot.lifecycle.unmount();
});
