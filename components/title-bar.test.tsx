// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";
import { setNeedsYou } from "../lib/workspace-store";
import { reviewAction } from "./review-bar.test-support";
import { panelTabCalls, renderPanelTab } from "./panel-tabs.test-support";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); vi.useRealTimers(); });

/** Every ResizeObserver reports this size, and media queries answer for a screen this size, or `screen`'s. */
function fakeSize(width: number, height: number, screen: [number, number] = [width, height]) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = !!max && (max[1] === "width" ? screen[0] : screen[1]) <= Number(max[2]);
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  // The window is the screen: jsdom's is 0 × 0, a phone's.
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: screen[0] });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: screen[1] });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; });
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
async function renderReview({ review, rpc, titleBar = true, panel, sidebarThreads }: { review?: Record<string, unknown>; rpc?: Record<string, unknown>; titleBar?: boolean; panel?: { openTab: () => boolean }; sidebarThreads?: any } = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.navPanels[0]!;
  const header = titleBar ? renderSlot({ component: registration.headerContent! }, { subPath: "pr-42" }, { rpc: handlers(review, rpc) as any, ...sidebarThreads ? { sidebarThreads } : {} }) : null;
  const page = renderSlot(registration, { subPath: "pr-42" }, { rpc: handlers(review, rpc) as any, ...panel ? { experimental_panel: panel } : {}, ...sidebarThreads ? { sidebarThreads } : {} });
  await page.findByTestId("filediff");
  const band = () => within(page.getByRole("navigation", { name: "Breadcrumb" }).closest<HTMLElement>("[class*='@container/band']")!);
  return { page, bar: page, header, band };
}

test("BB's title bar renders no review controls, and none on Settings; All reviews keeps its own", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const { TitleBarControls } = await import("./TitleBarControls");
  expect(app.navPanels[0]!.headerContent).toBe(TitleBarControls);

  expect(typeof TitleBarControls).toBe("function");
  for (const subPath of ["settings", "settings/pr-42", "pr-42"]) {
    const slot = renderSlot({ component: TitleBarControls }, { subPath }, { rpc: handlers() as any });
    expect(slot.container.innerHTML).toBe("");
    slot.lifecycle.unmount();
  }
  fakeSize(1400, 900);
  const { header, band } = await renderReview();
  expect(header!.container.innerHTML).toBe("");
  expect(band().getByRole("group", { name: "Review commands" })).toBeTruthy();
});
test("the review bar has the same order at every non-phone size; labels use its CSS container", async () => {
  for (const [width, height] of [[1400, 900], [820, 900], [594, 338], [560, 952], [669, 821], [951, 541]]) {
    fakeSize(width!, height!, [1440, 1000]);
    const { page, header, band } = await renderReview({ review: { mainThread: { threadId: "coder", origin: "adopted", since: 1 } } });
    const commands = within(band().getByRole("group", { name: "Review commands" }));
    await commands.findByRole("button", { name: /^Finish review:/ });
    expect(commands.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Comments", "Agent", "Main thread", "Finish review: Request changes, 2 comments", "Review actions"]);
    for (const text of ["Comments", "Agent", "Main thread", "review"]) {
      const label = commands.getByText(text);
      expect(label.className).toContain("hidden min-w-0 truncate @min-[880px]/band:inline");
    }
    const crumbs = within(page.getByRole("navigation", { name: "Breadcrumb" }));
    for (const name of ["All reviews", "pr-42"]) {
      const button = crumbs.getByRole("button", { name });
      expect(button.className).toContain(height! < 500 ? "pointer-coarse:h-9" : "pointer-coarse:h-11");
      expect(button.className).toContain(height! < 500 ? "pointer-coarse:after:-inset-1" : "pointer-coarse:min-w-11");
    }
    const left = page.getByRole("navigation", { name: "Breadcrumb" }).parentElement!;
    expect(left.style.maxWidth).toBe("calc(var(--gr-fold-end, 100000px) - 48px)");
    expect(header!.container.innerHTML).toBe("");
    page.lifecycle.unmount(); header!.lifecycle.unmount();
    restores.splice(0).forEach((restore) => restore());
  }
});
test("beside BB's side panel on a desktop, a 560px review keeps its commands in the band; Ask agent is pressed while its tab shows, and closes it", async () => {
  fakeSize(560, 952, [1440, 1000]);
  const { bar, page } = await renderReview();
  const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
  const ask = commands.getByRole("button", { name: "Agent" });
  // Icons, leaving BB's crumbs their room.
  expect(ask.textContent).toBe("Agent");
  // Not a phone's dock.
  expect(page.queryByRole("button", { name: /^pr-42, Chapters:/ })).toBeNull();
  expect(ask.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(ask);
  expect(panelTabCalls(page)).toEqual(["openTab:agent"]);
  const app = await loadPluginApp(() => import("../app"));
  const tab = renderPanelTab(app, "agent", "pr-42", { rpc: handlers() as any });
  await waitFor(() => expect(ask.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(ask);
  expect(panelTabCalls(page)).toEqual(["openTab:agent", "close"]);
  tab.lifecycle.unmount();
  await waitFor(() => expect(ask.getAttribute("aria-pressed")).toBe("false"));
});

test("Ask agent on a file opens the agent's first message empty, naming no file", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview({ panel: { openTab: () => true } });
  const { currentFileOf } = await import("../lib/workspace-store");
  await waitFor(() => expect(currentFileOf("pr-42")).toBe("src/a.ts"));
  fireEvent.click(await bar!.findByRole("button", { name: "Agent" }));
  const app = await loadPluginApp(() => import("../app"));
  const tab = renderPanelTab(app, "agent", "pr-42", { rpc: handlers() as any });
  const agent = within(await tab.findByRole("region", { name: "Review agent" }));
  const box = await agent.findByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(box.value).toBe("");
  expect(agent.queryByText("Context")).toBeNull();
  expect(agent.queryByText("a.ts")).toBeNull();
  tab.lifecycle.unmount();
});

test("Ask agent in full screen leaves it, as BB's side panel is outside it, though its tab showed before", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  const { bar, page, band } = await renderReview({ panel: { openTab: () => true } });
  const app = await loadPluginApp(() => import("../app"));
  const tab = renderPanelTab(app, "agent", "pr-42", { rpc: handlers() as any });
  await waitFor(() => expect(bar!.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(reviewAction(page, "Full screen"));
  await waitFor(() => expect(document.fullscreenElement).toBeTruthy());
  const ask = await band().findByRole("button", { name: "Agent" });
  expect(ask.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(ask);
  await waitFor(() => expect(document.fullscreenElement).toBeNull());
  expect(panelTabCalls(page)).toEqual(["openTab:agent"]);
  expect(toast.error).not.toHaveBeenCalled();
  tab.lifecycle.unmount();
});

test("where BB's panel declines the tab, Ask agent says it isn't available here", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview();
  fireEvent.click(await bar!.findByRole("button", { name: "Agent" }));
  expect(toast.error).toHaveBeenCalledWith("The review agent isn’t available here.");
});

test("Main thread is one side-panel toggle; navigation lives in ⋯", async () => {
  fakeSize(820, 900);
  const withMain = { sourceThreadId: "coder", mainThread: { threadId: "coder", environmentId: null, origin: "adopted", since: 1 } };
  const { page, band } = await renderReview({ review: withMain });
  const beside = band().getByRole("button", { name: "Main thread" });
  expect(beside.getAttribute("aria-pressed")).toBe("false");
  expect(beside.querySelector("[data-icon=ArrowUpRight]")).toBeNull();
  fireEvent.click(beside);
  expect(panelTabCalls(page)).toEqual(["openTab:main"]);
  const app = await loadPluginApp(() => import("../app"));
  const tab = renderPanelTab(app, "main", "pr-42", { rpc: handlers(withMain) as any });
  await waitFor(() => expect(beside.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(beside);
  expect(panelTabCalls(page)).toEqual(["openTab:main", "close"]);
  tab.lifecycle.unmount();
  fireEvent.click(reviewAction(page, "Go to main thread ↗"));
  expect(page.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "coder" });
});
test("commands live in the band immediately, whether or not BB mounts headerContent", async () => {
  fakeSize(1400, 900);
  for (const titleBar of [true, false]) {
    const { page, header, band } = await renderReview({ titleBar });
    expect(band().getByRole("group", { name: "Review commands" })).toBeTruthy();
    expect(header?.container.innerHTML ?? "").toBe("");
    page.lifecycle.unmount(); header?.lifecycle.unmount();
  }
});
test("Submit shows only what can be submitted: a closed PR has none", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview({ review: { prState: "MERGED", archivedAt: 1 } });
  const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
  expect(commands.getByRole("button", { name: "Comments" })).toBeTruthy();
  expect(commands.queryByRole("button", { name: /^Finish review/ })).toBeNull();
});

test("Finish is filled until its panel shows, then outlined; a local review counts Send's open comments", async () => {
  fakeSize(1400, 900);
  const { page, band } = await renderReview({ review: { kind: "ref", gitRef: "main...x", url: null } });
  const finish = await band().findByRole("button", { name: "Finish review: 2 comments to send" });
  expect(finish.textContent).toBe("Finish review· 2");
  expect(finish.querySelector("svg")).toBeNull();
  expect(finish.className.split(" ")).toContain("bg-primary");
  expect(finish.getAttribute("aria-keyshortcuts")).toBe("s");
  fireEvent.click(finish);
  expect(finish.className.split(" ")).not.toContain("bg-primary");
  expect(finish.className.split(" ")).toContain("border");
  fireEvent.click(band().getByRole("button", { name: "Comments" }));
  expect(finish.className.split(" ")).toContain("bg-primary");
  expect(page.getByRole("complementary", { name: "Comments and Finish review" })).toBeTruthy();
});
test("a local review's Finish review leaves the draft status alone: nothing to submit, as the phone dock reads it", async () => {
  fakeSize(1400, 900);
  const { useDraftStatus } = await import("../lib/draft-status");
  let status: unknown = "unset";
  const Probe = () => { status = useDraftStatus("pr-42"); return null; };
  const probe = renderSlot({ component: Probe }, {}, {});
  const { bar } = await renderReview({ review: { kind: "ref", gitRef: "main...x", url: null } });
  await within(await bar!.findByRole("group", { name: "Review commands" })).findByRole("button", { name: /^Finish review/ });
  expect(status).toBeNull();
  probe.lifecycle.unmount();
});

test("Comments counts what needs you, opens and closes the panel, and says so pressed", async () => {
  fakeSize(1400, 900);
  const { bar, page } = await renderReview();
  const comments = await bar!.findByRole("button", { name: "Comments" });
  expect(comments.getAttribute("aria-controls")).toBe("gr-side-panel-pr-42");
  act(() => setNeedsYou("pr-42", 3));
  expect(bar!.getByRole("button", { name: "Comments, 3 need you" }).textContent).toBe("Comments3");
  // The tooltip says what the count is: what needs you, where Finish review's is what will be sent.
  const matches = Element.prototype.matches;
  const focusVisible = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":focus-visible" ? this === document.activeElement : matches.call(this, selector);
  });
  comments.focus();
  expect((await bar!.findByRole("tooltip")).textContent).toBe("Comments · 3 need you (c)");
  comments.blur();
  focusVisible.mockRestore();
  fireEvent.click(comments);
  expect(comments.getAttribute("aria-pressed")).toBe("true");
  expect(page.getByRole("complementary", { name: "Comments and Finish review" })).toBeTruthy();
  fireEvent.click(comments);
  expect(comments.getAttribute("aria-pressed")).toBe("false");
  expect(page.queryByRole("complementary", { name: "Comments and Finish review" })).toBeNull();
  act(() => setNeedsYou("pr-42", 0));
});

test("closing the panel a title-bar command opened gives the focus back to the command, where the review's keys still work", async () => {
  fakeSize(1400, 900);
  const { bar, page } = await renderReview();
  const comments = await bar!.findByRole("button", { name: "Comments" });
  // A click presses, focuses the button, and lets go.
  const click = (button: HTMLElement) => { fireEvent.pointerDown(button); button.focus(); fireEvent.pointerUp(button); fireEvent.click(button); };
  click(comments);
  click(within(page.getByRole("complementary", { name: "Comments and Finish review" })).getByRole("button", { name: "Close panel" }));
  await waitFor(() => expect(document.activeElement).toBe(comments));
  expect(page.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  fireEvent.keyDown(comments, { key: "t" });
  expect(page.queryByRole("navigation", { name: "Chapters" })).toBeNull();
});

test("Review actions offers Rebuild guide, new commits or not, then Open on GitHub, Keyboard shortcuts and Review settings", async () => {
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
  // The notice's Update review updates the review; the menu's guide rebuild is from scratch, and named so.
  expect(bar!.queryByRole("button", { name: "Update guide" })).toBeNull();
  fireEvent.click(await bar!.findByRole("button", { name: "Rebuild guide" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
});

test("a local review's Review actions offers Rewrite guide after Rename, with the agent's sparkle: the notices only offer Update review", async () => {
  fakeSize(1400, 900);
  const rereview = vi.fn(() => ({ ok: true }));
  const { bar } = await renderReview({ review: { kind: "ref", gitRef: "main...feature", cwd: "/repo" }, rpc: { rereview } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  const rewrite = await bar!.findByRole("button", { name: "Rewrite guide" });
  // Not where the menu opens: after Rename… and Move to section.
  const names = Array.from(rewrite.parentElement!.querySelectorAll("button")).map((item) => item.textContent);
  expect(names.indexOf("Rewrite guide")).toBe(names.indexOf("Rename…") + 2);
  expect(rewrite.querySelector("svg")?.getAttribute("data-icon")).toBe("Sparkles");
  expect(rewrite.getAttribute("aria-description")).toBe("Starts the guide writer to write a new guide for the code now.");
  expect(bar!.queryByRole("button", { name: /^(Update|Rebuild) guide$/ })).toBeNull();
  fireEvent.click(rewrite);
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
});

test("Review actions offers Move to section after Rename, as BB's thread menus do, and moves the review", async () => {
  fakeSize(1400, 900);
  const moveReview = vi.fn(() => ({ ok: true }));
  const sections = [{ id: "sec_needs", name: "Needs review", createdAt: 1, updatedAt: 1 }, { id: "sec_later", name: "Later", createdAt: 2, updatedAt: 2 }];
  const { bar } = await renderReview({ review: { kind: "ref", gitRef: "main...feature", cwd: "/repo", sectionId: "sec_later" }, rpc: { moveReview, needsReviewSection: () => ({ sectionId: "sec_needs" }) }, sidebarThreads: { status: "ready", threads: [], sections } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  const move = await bar!.findByRole("button", { name: /Move to section/ });
  const names = Array.from(move.parentElement!.querySelectorAll("button")).map((item) => item.textContent);
  expect(names.indexOf("Move to section")).toBe(names.indexOf("Rename…") + 1);
  expect(names.indexOf("Rewrite guide")).toBe(names.indexOf("Move to section") + 1);
  fireEvent.click(move);
  const choices = await waitFor(() => { const found = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-move-choice]")); expect(found).toHaveLength(3); return found; });
  // With no thread list drawn, in the order BB made them; the one it's in can't be picked.
  expect(choices.map((choice) => [choice.textContent, choice.disabled])).toEqual([["Needs review", false], ["Later", true], ["Threads", false]]);
  fireEvent.click(choices[2]!);
  await waitFor(() => expect(moveReview).toHaveBeenCalledWith({ targetKey: "pr-42", sectionId: "threads" }));
});

test("after Keep both, Review actions offers Merge into one review on either review, its line saying which stays, while neither is archived", async () => {
  fakeSize(1400, 900);
  const mergeReviews = vi.fn(() => ({ ok: true, targetKey: "pr-42" }));
  const cases = [
    { review: { keptApart: { targetKey: "br-1", id: "api:feat/qa", number: 42 } }, line: "This PR’s branch has a local review. Merging keeps that one and archives this one." },
    { review: { kind: "ref", gitRef: "main...feat/qa", url: null, keptApart: { targetKey: "pr-x", id: "web#42", number: 42 } }, line: "PR #42 has its own review. Merging keeps this one and archives that one." },
    // The local review of another branch, which Make it PR #42's review linked.
    { review: { keptApart: { targetKey: "br-1", id: "api:part2", number: 42, branch: "part2" } }, line: "A local review of part2 is linked to this PR. Merging keeps that one and archives this one." },
  ];
  for (const { review, line } of cases) {
    const { bar, page } = await renderReview({ review, rpc: { mergeReviews } });
    fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
    const merge = await bar!.findByRole("button", { name: "Merge into one review" });
    // Said before you choose it, not only to a screen reader.
    expect(merge.textContent).toContain(line);
    expect(merge.getAttribute("aria-description")).toBe(line);
    // A branch in monospace, as the notice shows it.
    if (review.keptApart.branch) expect(merge.querySelector(".font-mono")?.textContent).toBe(review.keptApart.branch);
    // On the PR's review, for the local review it names, of the PR's two or more.
    fireEvent.click(merge);
    await waitFor(() => expect(mergeReviews).toHaveBeenLastCalledWith({ targetKey: review.kind === "ref" ? "pr-42" : review.keptApart.targetKey }));
    page.lifecycle.unmount(); bar!.lifecycle.unmount();
  }
  const { bar } = await renderReview({ review: { ...cases[0]!.review, archivedAt: 1 } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  const menu = within((await bar!.findByRole("button", { name: "Rename…" })).parentElement!);
  expect(menu.queryByRole("button", { name: "Merge into one review" })).toBeNull();
});

test("a merge from Review actions that fails says why", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview({ review: { keptApart: { targetKey: "br-1", id: "api:feat/qa", number: 42 } }, rpc: { mergeReviews: () => ({ ok: false, error: "Nope." }) } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  fireEvent.click(await bar!.findByRole("button", { name: "Merge into one review" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope."));
});

test("after Not this one, a local review's Review actions offers Make it PR #12's review, which the notice offered", async () => {
  fakeSize(1400, 900);
  const takePendingPr = vi.fn(() => ({ ok: true }));
  const local = { kind: "ref", gitRef: "main...feat/qa", url: null };
  const pending = { number: 12, url: "https://github.com/acme/web/pull/12", why: "older", at: 1 };
  // Its line says why it was held, as the notice did.
  const lines = [
    { prPending: { ...pending, declined: true }, line: "This branch has PR #12, opened before this review." },
    { prPending: { ...pending, why: "branch", head: "part1", declined: true }, line: "PR #12 is from part1, not this branch." },
  ];
  for (const { prPending, line } of lines) {
    const { bar, page } = await renderReview({ review: { ...local, prPending }, rpc: { takePendingPr } });
    fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
    const take = await bar!.findByRole("button", { name: "Make it PR #12’s review" });
    expect(take.textContent).toContain(line);
    expect(take.getAttribute("aria-description")).toBe(line);
    if ("head" in prPending) expect(take.querySelector(".font-mono")?.textContent).toBe(prPending.head);
    fireEvent.click(take);
    await waitFor(() => expect(takePendingPr).toHaveBeenLastCalledWith({ targetKey: "pr-42" }));
    page.lifecycle.unmount(); bar!.lifecycle.unmount();
  }
  // Not declined, the notice offers it; GitHub not answering, its Try again.
  for (const prPending of [pending, { ...pending, why: "error", declined: true }]) {
    const { bar, page } = await renderReview({ review: { ...local, prPending } });
    fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
    expect(within((await bar!.findByRole("button", { name: "Rename…" })).parentElement!).queryByRole("button", { name: "Make it PR #12’s review" })).toBeNull();
    page.lifecycle.unmount(); bar!.lifecycle.unmount();
  }
});

test("an iPad without a mouse keeps Keyboard shortcuts in Review actions, for its keyboard", async () => {
  fakeSize(1032, 1376);
  const { bar } = await renderReview();
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  expect(await bar!.findByRole("button", { name: "Keyboard shortcuts" })).toBeTruthy();
});

test("with single-key shortcuts off, the commands' tooltips name no key, and Review actions has no Keyboard shortcuts", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  // A tooltip opens on the focus a key gives.
  const matches = Element.prototype.matches;
  const focusVisible = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
    return selector === ":focus-visible" ? this === document.activeElement : matches.call(this, selector);
  });
  restores.push(() => focusVisible.mockRestore());
  const off = { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, singleKeyShortcuts: false } }, revision: 1 };
  const { bar, page } = await renderReview({ rpc: { getPreferences: () => off } });
  const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
  await commands.findByRole("button", { name: /^Finish review:/ });
  await waitFor(() => expect(page.inspection.rpcCalls.filter((call) => call.method === "getPreferences")).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tips: string[] = [];
  for (const name of ["Comments", "Agent", /^Finish review:/]) {
    const button = commands.getByRole("button", { name });
    button.focus();
    tips.push((await bar!.findByRole("tooltip")).textContent!);
    button.blur();
    await waitFor(() => expect(bar!.queryByRole("tooltip")).toBeNull());
  }
  expect(tips).toEqual(["Comments", "Agent", "Finish review"]);
  fireEvent.click(commands.getByRole("button", { name: "Review actions" }));
  await bar!.findByRole("button", { name: "Review settings…" });
  expect(bar!.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
  page.lifecycle.unmount(); bar!.lifecycle.unmount();
});

test("the commands and the band's chapters toggle name their keys for screen readers, only while single-key shortcuts are on", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  const keysOf = async (preferences: unknown) => {
    const { bar, page } = await renderReview({ rpc: { getPreferences: () => preferences } });
    const commands = within(await bar!.findByRole("group", { name: "Review commands" }));
    await commands.findByRole("button", { name: /^Finish review:/ });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const keys = ["Comments", "Agent", /^Finish review:/].map((name) => commands.getByRole("button", { name }).getAttribute("aria-keyshortcuts"));
    keys.push(reviewAction(page, "Full screen").getAttribute("aria-keyshortcuts"));
    keys.push(page.getAllByRole("button", { name: "Hide chapters" })[0]!.getAttribute("aria-keyshortcuts"));
    page.lifecycle.unmount(); bar!.lifecycle.unmount();
    return keys;
  };
  expect(await keysOf({ preferences: defaultPreferences, revision: 0 })).toEqual(["c", "a", "s", "Shift+F", "t"]);
  expect(await keysOf({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, singleKeyShortcuts: false } }, revision: 1 })).toEqual([null, null, null, null, null]);
});

test("an archived review's actions don't offer to rebuild its guide, which the server would refuse", async () => {
  fakeSize(1400, 900);
  const { bar } = await renderReview({ review: { prState: "MERGED", archivedAt: 1 } });
  fireEvent.click(await bar!.findByRole("button", { name: "Review actions" }));
  await bar!.findByRole("button", { name: "Open on GitHub" });
  expect(bar!.queryByRole("button", { name: /guide/ })).toBeNull();
});

test("full screen keeps the same breadcrumb links and commands", async () => {
  fakeSize(1400, 900);
  fakeFullscreen();
  const { page, header, band } = await renderReview();
  const crumbs = () => within(page.getByRole("navigation", { name: "Breadcrumb" }));
  expect(crumbs().getByRole("button", { name: "pr-42" })).toBeTruthy();
  expect(crumbs().getByRole("button", { name: "All reviews" })).toBeTruthy();
  fireEvent.click(reviewAction(page, "Full screen"));
  expect(document.fullscreenElement).toBeTruthy();
  expect(crumbs().getByText("pr-42", { selector: ".sr-only" })).toBeTruthy();
  expect(header!.container.innerHTML).toBe("");
  expect(band().getByRole("button", { name: "Agent" })).toBeTruthy();
  fireEvent.click(reviewAction(page, "Exit full screen"));
  expect(document.fullscreenElement).toBeNull();
  expect(crumbs().getByRole("button", { name: "pr-42" })).toBeTruthy();
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
  fireEvent.click(band().getByRole("button", { name: "All reviews" }));
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
