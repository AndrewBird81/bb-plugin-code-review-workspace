// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { setNeedsYou } from "../lib/workspace-store";

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

/** The browser's Fullscreen API, which jsdom lacks: requests and exits take effect at once. */
function fakeFullscreen() {
  let element: Element | null = null;
  const change = (next: Element | null) => { element = next; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: () => change(null) });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value(this: HTMLElement) { return change(this); } });
  restores.push(() => {
    for (const key of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) delete (document as unknown as Record<string, unknown>)[key];
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] }] };

function handlers(review: Record<string, unknown> = {}, rpc: Record<string, unknown> = {}) {
  return {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "REQUEST_CHANGES", body: "Fix it.", comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Here." }, { file: "src/a.ts", line: 1, side: "LEFT", body: "And here." }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
}

/** The review's page, and BB's title bar as the host renders it, apart from the page, with the panel's headerContent. */
async function renderReview({ review, rpc, titleBar = true }: { review?: Record<string, unknown>; rpc?: Record<string, unknown>; titleBar?: boolean } = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.navPanels[0]!;
  const bar = titleBar ? renderSlot({ component: registration.headerContent! }, { subPath: "pr-42" }, { rpc: handlers(review, rpc) as any }) : null;
  const page = renderSlot(registration, { subPath: "pr-42" }, { rpc: handlers(review, rpc) as any });
  await page.findByTestId("filediff");
  const band = () => within(page.getByRole("navigation", { name: "Breadcrumb" }).closest<HTMLElement>("[class*='@container/band']")!);
  return { page, bar, band };
}

test("BB's title bar shows an open review's commands, and none on the list or Settings", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const { TitleBarControls } = await import("./TitleBarControls");
  expect(app.navPanels[0]!.headerContent).toBe(TitleBarControls);
  // A plain function: the SDK takes no memo object as a slot's component.
  expect(typeof TitleBarControls).toBe("function");
  for (const subPath of ["", "settings", "settings/pr-42"]) {
    const slot = renderSlot({ component: TitleBarControls }, { subPath }, { rpc: handlers() as any });
    expect(slot.container.innerHTML).toBe("");
    slot.lifecycle.unmount();
  }
  fakeSize(1400, 900);
  const { bar } = await renderReview();
  const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
  for (const name of ["Comments", "Ask agent", "Review actions"]) expect(commands.getByRole("button", { name })).toBeTruthy();
  // jsdom can't go full screen, nor cover the window.
  expect(commands.queryByRole("button", { name: "Full screen" })).toBeNull();
  expect(await commands.findByRole("button", { name: "Submit review: Request changes, 2 comments" })).toBeTruthy();
});

test("the title bar's commands fit the pane: labeled from 1000px, shorter below, icons on a phone held sideways, and none on a phone", async () => {
  const text = async (bar: Awaited<ReturnType<typeof renderReview>>["bar"]) => {
    const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
    await commands.findByRole("button", { name: /^Submit review/ });
    return ["Comments", "Ask agent", /^Submit review/].map((name) => commands.getByRole("button", { name }).textContent);
  };
  fakeSize(1400, 900);
  let { bar, page } = await renderReview();
  expect(await text(bar)).toEqual(["Comments", "Ask agent", "Submit review· Request changes· 2"]);
  page.lifecycle.unmount(); bar!.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore());
  fakeSize(800, 1200);
  ({ bar, page } = await renderReview());
  expect(await text(bar)).toEqual(["", "Ask agent", "Submit· 2"]);
  page.lifecycle.unmount(); bar!.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore());
  fakeSize(844, 390);
  ({ bar, page } = await renderReview());
  expect(await text(bar)).toEqual(["", "", "Submit· 2"]);
  page.lifecycle.unmount(); bar!.lifecycle.unmount(); restores.splice(0).forEach((restore) => restore());
  // A phone's are its own, in the workspace's dock.
  fakeSize(390, 844);
  ({ bar, page } = await renderReview());
  await page.findByRole("group", { name: "Review commands" });
  expect(bar!.container.innerHTML).toBe("");
});

test("where BB's title bar takes the commands the band doesn't show them; where it doesn't, the band does, after a moment", async () => {
  fakeSize(1400, 900);
  const withBar = await renderReview();
  await withBar.bar!.findByRole("group", { name: "Review commands" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(withBar.band().queryByRole("group", { name: "Review commands" })).toBeNull();
  withBar.page.lifecycle.unmount(); withBar.bar!.lifecycle.unmount();
  const without = await renderReview({ titleBar: false });
  expect(without.band().queryByRole("group", { name: "Review commands" })).toBeNull();
  expect(await without.band().findByRole("group", { name: "Review commands" })).toBeTruthy();
});

test("Submit shows only what can be submitted: a local review and a closed PR have none", async () => {
  fakeSize(1400, 900);
  for (const review of [{ kind: "ref", gitRef: "main...x", url: null }, { prState: "MERGED", archivedAt: 1 }]) {
    const { bar, page } = await renderReview({ review });
    const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
    expect(commands.getByRole("button", { name: "Comments" })).toBeTruthy();
    expect(commands.queryByRole("button", { name: /^Submit review/ })).toBeNull();
    page.lifecycle.unmount(); bar!.lifecycle.unmount();
  }
});

test("Comments counts what needs you, opens and closes the panel, and says so pressed", async () => {
  fakeSize(1400, 900);
  const { bar, page } = await renderReview();
  const comments = await bar!.findByRole("button", { name: "Comments" });
  expect(comments.getAttribute("aria-controls")).toBe("gr-side-panel-pr-42");
  act(() => setNeedsYou("pr-42", 3));
  expect(bar!.getByRole("button", { name: "Comments, 3 need you" }).textContent).toBe("Comments3");
  fireEvent.click(comments);
  expect(comments.getAttribute("aria-pressed")).toBe("true");
  expect(page.getByRole("complementary", { name: "Comments and agent" })).toBeTruthy();
  fireEvent.click(comments);
  expect(comments.getAttribute("aria-pressed")).toBe("false");
  expect(page.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  act(() => setNeedsYou("pr-42", 0));
});

test("closing the panel a title-bar command opened gives the focus back to the command, where the review's keys still work", async () => {
  fakeSize(1400, 900);
  const { bar, page } = await renderReview();
  const comments = await bar!.findByRole("button", { name: "Comments" });
  // A click presses, focuses the button, and lets go.
  const click = (button: HTMLElement) => { fireEvent.pointerDown(button); button.focus(); fireEvent.pointerUp(button); fireEvent.click(button); };
  click(comments);
  click(within(page.getByRole("complementary", { name: "Comments and agent" })).getByRole("button", { name: "Close panel" }));
  await waitFor(() => expect(document.activeElement).toBe(comments));
  expect(page.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  fireEvent.keyDown(comments, { key: "t" });
  expect(page.queryByRole("navigation", { name: "Chapters" })).toBeNull();
});

test("Review actions offers Update guide for new commits, else Rebuild guide, then Open on GitHub, Keyboard shortcuts and Review settings", async () => {
  fakeSize(1400, 900);
  const rereview = vi.fn(() => ({ ok: true }));
  let { bar, page } = await renderReview({ rpc: { rereview } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  const items = (await bar!.findAllByRole("button", { name: /guide|GitHub|shortcuts|settings/ })).map((item) => item.textContent);
  // Snooze, Pin and Archive come between the guide and GitHub; the shortcuts show their key.
  expect(items.slice(0, 4)).toEqual(["Rebuild guide", "Open on GitHub", "Keyboard shortcuts?", "Review settings…"]);
  fireEvent.click(bar!.getByRole("button", { name: "Keyboard shortcuts" }));
  expect(await page.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  page.lifecycle.unmount(); bar!.lifecycle.unmount();
  ({ bar, page } = await renderReview({ rpc: { rereview, checkForUpdates: () => ({ hasNewCommits: true }) } }));
  await page.findByText("New commits since this guide was written.");
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  // The menu's, not the notice's.
  fireEvent.click((await bar!.findAllByRole("button", { name: "Update guide" })).find((item) => !item.closest("[role=status]"))!);
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
});

test("an archived review's actions don't offer to rebuild its guide, which the server would refuse", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview({ review: { prState: "MERGED", archivedAt: 1 } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  await bar!.findByRole("button", { name: "Open on GitHub" });
  expect(bar!.queryByRole("button", { name: /guide/ })).toBeNull();
});

test("Full screen goes from the title bar to the band's end and back; from the keyboard the focus goes along", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  const { bar, page, band } = await renderReview();
  const enter = await bar!.findByRole("button", { name: "Full screen" });
  // detail 0: a click from the keyboard.
  fireEvent.click(enter, { detail: 0 });
  expect(document.fullscreenElement).toBe(band().getByRole("button", { name: "Exit full screen" }).closest("[class*='@container/review']"));
  expect(bar!.container.innerHTML).toBe("");
  // With the commands at its end, a band under 1000px puts the diff's controls behind Diff options.
  expect(band().getByRole("button", { name: "Diff options" }).className).toContain("@min-[1000px]/band:hidden");
  expect(band().getByRole("button", { name: "Wrap lines" }).parentElement!.className).toContain("hidden @min-[1000px]/band:flex");
  const exit = await band().findByRole("button", { name: "Exit full screen" });
  await waitFor(() => expect(document.activeElement).toBe(exit));
  fireEvent.click(exit, { detail: 0 });
  expect(document.fullscreenElement).toBeNull();
  const again = await bar!.findByRole("button", { name: "Full screen" });
  await waitFor(() => expect(document.activeElement).toBe(again));
  // A pointer's click leaves the focus, so no tooltip opens where it lands.
  (document.activeElement as HTMLElement).blur();
  fireEvent.click(again, { detail: 1 });
  await band().findByRole("button", { name: "Exit full screen" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(document.activeElement).toBe(document.body);
  page.lifecycle.unmount();
});

test("⇧F goes full screen and back, and leaving the review leaves full screen: All reviews, Review settings, or any other way", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  let { page, band } = await renderReview();
  // Caps Lock's F, without Shift, is an f.
  fireEvent.keyDown(document.body, { key: "F" });
  expect(document.fullscreenElement).toBeNull();
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  const root = page.getByRole("main").closest("[class*='@container/review']");
  expect(document.fullscreenElement).toBe(root);
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  expect(document.fullscreenElement).toBeNull();
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  fireEvent.click(within(page.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "All reviews" }));
  await waitFor(() => expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review" }));
  expect(document.fullscreenElement).toBeNull();
  page.lifecycle.unmount();
  ({ page, band } = await renderReview({ titleBar: false }));
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  fireEvent.click(await band().findByRole("button", { name: "Review actions" }));
  fireEvent.click(await page.findByRole("button", { name: "Review settings…" }));
  await waitFor(() => expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "settings/pr-42" } }));
  expect(document.fullscreenElement).toBeNull();
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  expect(document.fullscreenElement).not.toBeNull();
  page.lifecycle.unmount();
  expect(document.fullscreenElement).toBeNull();
});
