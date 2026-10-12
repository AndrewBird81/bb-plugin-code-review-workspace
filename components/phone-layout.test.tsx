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
  // Opened in 0.5 on a bigger screen, on its chapter, with the review panel left open; or since, on its chapter.
  if (!localStorage.getItem("gr:panelstate")) localStorage.setItem("gr:panelstate", JSON.stringify({ perReview: { "pr-42": { activeId: "c1", activeTool: "draft", toolsOpen: true } } }));
  else patchReviewState("pr-42", { activeId: "c1" });
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
const band = (slot: Slot) => slot.getByRole("navigation", { name: "Breadcrumb" }).closest<HTMLElement>("[class*='@container/band']")!;

test("on a phone there's no band: the dock holds the review's commands, and the chapters sheet Review settings", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  expect(slot.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  const dock = within(slot.getByRole("group", { name: "Review commands" }));
  for (const name of ["All reviews", "Chapters: Chapter 1 of 1, Parsing, 0 of 1 files viewed", "Comments", "Ask agent"]) expect(dock.getByRole("button", { name })).toBeTruthy();
  fireEvent.click(dock.getByRole("button", { name: /^Chapters:/ }));
  const sheet = within(slot.getByRole("dialog", { name: "Chapters" }));
  fireEvent.click(sheet.getByRole("button", { name: "Review actions" }));
  fireEvent.click(await slot.findByRole("button", { name: "Review settings…" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "settings/pr-42" } }));
  slot.lifecycle.unmount();
});

test("on a phone the diff's options are behind the chapters sheet's Diff options, without Split, which can't apply there", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  // The chapter's end marks it viewed.
  expect(main.queryByRole("button", { name: "Mark chapter viewed" })).toBeNull();
  expect(main.getByRole("button", { name: "Mark chapter viewed and finish" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Diff options" }));
  const wrap = await slot.findByRole("switch", { name: "Wrap long lines" });
  expect(wrap.getAttribute("aria-checked")).toBe("true");
  expect(slot.getByRole("switch", { name: "Hide whitespace changes" }).getAttribute("aria-checked")).toBe("false");
  expect(slot.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
  fireEvent.click(wrap);
  expect(wrap.getAttribute("aria-checked")).toBe("false");
  slot.lifecycle.unmount();
});

test("on a phone the chapters, Comments and the agent share one sheet above the dock, which never opens by itself", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  // The panel left open on a bigger screen doesn't open over the code.
  expect(slot.queryByRole("dialog")).toBeNull();
  const dock = within(slot.getByRole("group", { name: "Review commands" }));
  const chaptersTab = dock.getByRole("button", { name: /^Chapters:/ });
  fireEvent.click(chaptersTab);
  // Not modal: the dock under it stays in reach, its tabs switching the sheet; the code behind it doesn't.
  const sheet = slot.getByRole("dialog", { name: "Chapters" });
  expect(sheet.hasAttribute("aria-modal")).toBe(false);
  expect(chaptersTab.getAttribute("aria-pressed")).toBe("true");
  expect(slot.getByRole("main", { hidden: true }).hasAttribute("inert")).toBe(true);
  fireEvent.click(dock.getByRole("button", { name: "Comments" }));
  expect(slot.queryByRole("dialog", { name: "Chapters" })).toBeNull();
  expect(slot.getByRole("dialog", { name: "Comments" })).toBeTruthy();
  expect(chaptersTab.getAttribute("aria-pressed")).toBe("false");
  // Its tab again closes it.
  fireEvent.click(dock.getByRole("button", { name: "Comments" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(slot.getByRole("main").hasAttribute("inert")).toBe(false);
  // A pick closes it.
  fireEvent.click(chaptersTab);
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Overview" }));
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(dock.getByRole("button", { name: "Chapters: Overview" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a phone held sideways keeps its band to 40px: All reviews and the chapter, and the diff's options behind one button", async () => {
  fakeSize(844, 390);
  const slot = await renderWorkspace();
  expect(band(slot).className.split(" ")).toContain("h-10");
  const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
  // With 720px of room, ‹ says where it goes.
  expect(crumbs.getByRole("button", { name: "All reviews" }).textContent).toBe("All reviews");
  expect(crumbs.getByText("Chapter 1 of 1: Parsing, 0 of 1 files viewed")).toBeTruthy();
  // Of the diff's settings only Fold comments, folded here to start with, has its own button.
  const options = within(slot.getByRole("main")).getByRole("button", { name: "Diff options" });
  expect(within(options.parentElement!).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Unfold comments in code", "Diff options"]);
  fireEvent.click(options);
  expect(await slot.findByRole("switch", { name: "Wrap long lines" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on a wide screen the band shows the review's title beside the chapter, then Fold comments and Diff options", async () => {
  // The code keeps 912px between the chapters and the panel.
  fakeSize(1600, 900);
  const slot = await renderWorkspace();
  const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
  expect(crumbs.getByRole("button", { name: "All reviews" }).textContent).toBe("All reviews");
  expect(crumbs.getByRole("button", { name: "Parse rows" })).toBeTruthy();
  expect(crumbs.getByText("Chapter 1 of 1: Parsing, 0 of 1 files viewed")).toBeTruthy();
  // The diff's settings are behind Diff options; the chapter's end and the chapters mark it viewed.
  const controls = within(band(slot)).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  expect(controls.slice(-2)).toEqual(["Fold comments in code", "Diff options"]);
  expect(within(band(slot)).queryByRole("button", { name: "Mark chapter viewed" })).toBeNull();
  // Not short: the chapters, the chapter's overview, and the saved open panel show.
  expect(slot.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Hide chapter overview" })).toBeTruthy();
  expect(slot.getByRole("complementary", { name: "Comments and agent" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a phone held sideways opens on code: the chapter overview, the chapters and the saved panel hidden until shown", async () => {
  fakeSize(844, 390);
  const slot = await renderWorkspace();
  const main = within(slot.getByRole("main"));
  expect(slot.getByRole("button", { name: "Show chapters" }).getAttribute("aria-pressed")).toBe("false");
  expect(within(main.getByRole("region", { name: "Parsing" })).queryByText("Reads rows.")).toBeNull();
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  expect(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Hide chapters" })).toBeTruthy();
  fireEvent.keyDown(slot.getByRole("dialog", { name: "Chapters" }), { key: "Escape" });
  fireEvent.click(main.getByRole("button", { name: "Show chapter overview" }));
  expect(await within(main.getByRole("region", { name: "Parsing" })).findByText("Reads rows.")).toBeTruthy();
  slot.lifecycle.unmount();
  // Showing the overview sticks in this browser, even on a short screen.
  const again = await renderWorkspace();
  expect(again.getByRole("button", { name: "Hide chapter overview" })).toBeTruthy();
  again.lifecycle.unmount();
});

test("the chapters toggle sits beside Find in review, and takes the same spot in the band when the chapters aren't docked", async () => {
  fakeSize(1400, 900);
  const slot = await renderWorkspace();
  const chapters = slot.getByRole("navigation", { name: "Chapters" });
  const host = document.getElementById("gr-navigator-pr-42")!;
  expect(host.contains(chapters)).toBe(true);
  const toggle = within(host).getByRole("button", { name: "Hide chapters" });
  expect(toggle.closest("div")!.nextElementSibling).toBe(within(host).getByRole("search"));
  expect(within(band(slot)).queryByRole("button", { name: /chapters$/ })).toBeNull();
  fireEvent.click(toggle);
  expect(slot.queryByRole("navigation", { name: "Chapters" })).toBeNull();
  const first = band(slot).querySelector("button")!;
  expect(first.getAttribute("aria-label")).toBe("Show chapters");
  expect(within(band(slot)).getByRole("button", { name: "Find in review" })).toBeTruthy();
  fireEvent.click(first);
  expect(slot.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("the Overview comes before the chapters: the band and the chapters list show it, n leaves it for chapter 1, and p comes back", async () => {
  fakeSize(1400, 900);
  const slot = await renderWorkspace();
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }).parentElement!.parentElement!);
  fireEvent.click(nav.getByRole("button", { name: "Overview" }));
  expect(await slot.findByRole("heading", { name: "Parse rows" })).toBeTruthy();
  expect(within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByText("Overview")).toBeTruthy();
  expect(nav.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  fireEvent.keyDown(document.body, { key: "n" });
  await slot.findByTestId("filediff");
  fireEvent.keyDown(document.body, { key: "p" });
  expect(await slot.findByRole("heading", { name: "Parse rows" })).toBeTruthy();
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
  const root = slot.getByRole("main").closest("[class*='@container/review']")!;
  fireEvent.click(await slot.findByRole("button", { name: "Full screen" }));
  expect(show.mock.contexts).toEqual([root]);
  expect(root.getAttribute("popover")).toBe("manual");
  // Clear of the notch; the dock, inside it, keeps clear of the home indicator.
  expect(root.className.split(" ")).toEqual(expect.arrayContaining(["fixed", "inset-0", "pt-[env(safe-area-inset-top)]"]));
  expect(root.className).not.toContain("safe-area-inset-bottom");
  expect(slot.getByRole("group", { name: "Review commands" }).className).toContain("env(safe-area-inset-bottom)");
  fireEvent.click(slot.getByRole("button", { name: /^Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Review actions" }));
  expect(root.contains(await slot.findByRole("button", { name: "Review settings…" }))).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.click(slot.getByRole("button", { name: "Exit full screen" }));
  expect(hide.mock.contexts).toEqual([root]);
  expect(root.hasAttribute("popover")).toBe(false);
  expect(root.className.split(" ")).not.toContain("fixed");
  // ⇧F covers it again. Esc closes the sheet still open over the code, and then leaves.
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  expect(root.getAttribute("popover")).toBe("manual");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(slot.queryByRole("dialog", { name: "Chapters" })).toBeNull();
  expect(root.getAttribute("popover")).toBe("manual");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(root.hasAttribute("popover")).toBe(false);
  slot.lifecycle.unmount();
});

test("where the browser can neither go full screen nor cover the window, there's no Full screen button", async () => {
  fakeSize(390, 844);
  const slot = await renderWorkspace();
  expect(within(slot.getByRole("group", { name: "Review commands" })).getByRole("button", { name: "Ask agent" })).toBeTruthy();
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
  const root = band(slot).closest("[class*='@container/review']")!;
  fireEvent.click(await slot.findByRole("button", { name: "Full screen" }));
  expect(request.mock.contexts).toEqual([root]);
  expect(root.className.split(" ")).not.toContain("fixed");
  slot.lifecycle.unmount();
});
