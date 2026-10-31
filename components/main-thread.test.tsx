// @vitest-environment jsdom
// The main thread: Main thread ↗ in BB's title bar and a phone's dock, which goes to it, and its tab in BB's side panel
// beside the diff, showing the thread that writes the code with BB's chat, which thread and machine it is, Change main
// thread and Go to thread; and Send now on a comment's card.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { updateComments } from "./comments/store";
import type { ReviewLinks } from "../lib/review-links";
import { panelTabCalls, renderPanelTab } from "./panel-tabs.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
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
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: height });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); delete (root as { clientWidth?: number }).clientWidth; delete (root as { clientHeight?: number }).clientHeight; });
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Snoozes checks.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Snooze", overview: "Waits.", diffs: [{ file: "src/a.ts", summary: "Waits a day." }] }] };
/** A folder's review of acme/api at feat/snooze, on MaxBook, its main thread `coder`. */
const folderReview = {
  targetKey: "br-1", kind: "ref", status: "ready", createdAt: 1, title: "Build snooze", gitRef: "feat/snooze", projectId: "p1",
  feature: { environmentId: "env1", hostId: "h1", machine: "MaxBook", path: "/Users/me/src/api", branch: "feat/snooze", baseRef: "main", repo: "acme/api" },
  mainThread: { threadId: "coder", environmentId: "env1", origin: "adopted", since: 1 }, sourceThreadId: "coder",
  place: { repo: "acme/api", machine: "MaxBook", path: "/Users/me/src/api" },
};
const MAIN = { thread: { threadId: "coder", title: "Build snooze", state: "open", machine: "MaxBook" } };

function handlers(review: Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  return {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkFeature: () => ({ state: "current", alsoActive: [], hidden: [], flagged: [] }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: review.targetKey, verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "Here." }] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSourceThread: () => MAIN,
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
}

/** The review's page at `width` × `height`, and BB's title bar, as the host renders it apart from the page. */
async function renderReview(review: Record<string, unknown>, size: [number, number], rpc: Record<string, unknown> = {}) {
  fakeSize(...size);
  patchReviewState(review.targetKey as string, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.navPanels[0]!;
  const options = { rpc: handlers(review, rpc) as any, sidebarThreads: { threads: [{ id: "coder", displayTitle: "Build snooze", status: "active" }] } as any };
  const bar = renderSlot({ component: registration.headerContent! }, { subPath: review.targetKey as string }, options);
  const page = renderSlot(registration, { subPath: review.targetKey as string }, options);
  await page.findByTestId("filediff");
  return { app, bar, page, options };
}

test("BB's title bar goes to the main thread, and shows it beside the diff in BB's side panel: its own chat, which can't widen its permissions, named with its machine", async () => {
  const getSourceThread = vi.fn(() => MAIN);
  const { app, bar, page, options } = await renderReview(folderReview, [1440, 1000], { getSourceThread });
  // Main thread ↗ is the switch from reviewing to doing.
  fireEvent.click(await bar.findByRole("button", { name: "Go to main thread" }));
  expect(bar.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "coder" }]);
  // Show beside review opens BB's Main thread tab.
  const beside = bar.getByRole("button", { name: "Show main thread beside review" });
  expect(beside.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(beside);
  expect(panelTabCalls(page)).toEqual(["openTab:main"]);
  const slot = renderPanelTab(app, "main", "br-1", options);
  const tab = await slot.findByRole("region", { name: "Main thread" });
  expect(within(tab).getByRole("heading", { level: 2 }).textContent).toBe("Main thread·api:feat/snooze·Build snooze");
  const chat = await within(tab).findByTestId("bb-thread-chat");
  expect(chat.dataset).toMatchObject({ threadId: "coder", variant: "compact", permissionPolicy: "inherit" });
  // Which thread, on which machine, and that it's working now, so a Send waits.
  expect(within(tab).getByText("MaxBook")).toBeTruthy();
  expect(within(tab).getByText(/Working: a Send waits for its turn/)).toBeTruthy();
  expect(getSourceThread).toHaveBeenCalledWith({ targetKey: "br-1" });
  await waitFor(() => expect(bar.getByRole("button", { name: "Show main thread beside review" }).getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(within(tab).getByRole("button", { name: "Main thread" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "coder" }]);
  slot.lifecycle.unmount();
  bar.lifecycle.unmount();
  page.lifecycle.unmount();
});

test("on a phone, the dock's Main thread goes to the main thread", async () => {
  const { page, bar } = await renderReview(folderReview, [390, 844]);
  const dock = within(page.getByRole("group", { name: "Review commands" }));
  fireEvent.click(dock.getByRole("button", { name: "Go to main thread" }));
  expect(page.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "coder" }]);
  expect(page.queryByRole("dialog", { name: "Main thread" })).toBeNull();
  page.lifecycle.unmount();
  bar.lifecycle.unmount();
});

test("a review with no main thread, or with Send to thread off, has no Main thread tab", async () => {
  const { app, page, bar } = await renderReview({ ...folderReview, mainThread: null, sourceThreadId: null }, [1440, 1000]);
  await bar.findByRole("button", { name: "Ask agent" });
  expect(bar.queryByRole("button", { name: "Go to main thread" })).toBeNull();
  expect(bar.queryByRole("button", { name: "Show main thread beside review" })).toBeNull();
  // BB's panel doesn't list the tab either; it does beside a review with one.
  const visible = (subPath: string) => {
    const tab = app.tabs.find((registration) => registration.id === "main")!;
    const probe = renderSlot({ component: () => <p>{String(tab.useVisible!({ subPath } as never))}</p> }, {}, {});
    const text = probe.container.textContent;
    probe.lifecycle.unmount();
    return text;
  };
  expect(visible("br-1")).toBe("false");
  page.lifecycle.unmount();
  bar.lifecycle.unmount();
  const off = await renderReview(folderReview, [390, 844], { getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, sendToThread: false } }, revision: 0 }) });
  await waitFor(() => expect(within(off.page.getByRole("group", { name: "Review commands" })).queryByRole("button", { name: "Go to main thread" })).toBeNull());
  off.page.lifecycle.unmount();
  off.bar.lifecycle.unmount();
});

/** The tab on its own, in a workspace showing `review`, with BB's thread list `threads`. */
async function renderTab(review: Record<string, unknown>, rpc: Record<string, unknown>, threads: unknown[] = []) {
  fakeSize(1440, 1000);
  const { WorkspaceProvider } = await import("../lib/workspace-context");
  const { testWorkspace } = await import("./draft-tray.test-support");
  const { MainThreadPanel } = await import("./MainThreadPanel");
  const api = testWorkspace(review.targetKey as string, { review: review as any, mainThread: { threadId: "coder", title: "Build snooze", machine: "MaxBook" } });
  const component = () => <WorkspaceProvider api={api}><MainThreadPanel active reviewId="api:feat/snooze" /></WorkspaceProvider>;
  return renderSlot({ component }, {}, { rpc: rpc as any, sidebarThreads: { threads } as any });
}
const listed = (id: string, displayTitle: string, over: Record<string, unknown> = {}) => ({ id, displayTitle, projectId: "p1", status: "idle", isHidden: false, isArchived: false, environment: { id: "env1" }, ...over });

test("Change main thread lists the threads working in the folder, and the one you choose gets your Sends from now on", async () => {
  const setMainThread = vi.fn(async () => ({ ok: true }));
  const getSourceThread = vi.fn(() => MAIN);
  const slot = await renderTab(folderReview, { getSourceThread, setMainThread }, [
    listed("coder", "Build snooze"), listed("docs", "Fix the docs", { status: "active" }), listed("away", "Elsewhere", { environment: { id: "env9" } }),
    listed("agent", "Review agent", { isHidden: true }), listed("old", "Old work", { isArchived: true }),
  ]);
  fireEvent.click(await slot.findByRole("button", { name: "Change main thread" }));
  const menu = within(await slot.findByRole("menu", { name: "Change main thread" }));
  expect(menu.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["Build snooze", "true"], ["Fix the docsWorking now", "false"]]);
  fireEvent.click(menu.getByRole("menuitemradio", { name: /Fix the docs/ }));
  await waitFor(() => expect(setMainThread).toHaveBeenCalledWith({ targetKey: "br-1", threadId: "docs" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Your Sends go to Fix the docs now."));
  await waitFor(() => expect(getSourceThread).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

test("Finish review's Change main thread opens the tab with its Change thread menu open, once", async () => {
  const { askChangeThread } = await import("../lib/main-thread");
  askChangeThread("br-1");
  const slot = await renderTab(folderReview, { getSourceThread: () => MAIN }, [listed("coder", "Build snooze")]);
  expect(await slot.findByRole("menu", { name: "Change main thread" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Change main thread" }).textContent).toBe("Change thread");
  slot.lifecycle.unmount();
  const again = await renderTab(folderReview, { getSourceThread: () => MAIN }, [listed("coder", "Build snooze")]);
  await again.findByRole("button", { name: "Change main thread" });
  expect(again.queryByRole("menu")).toBeNull();
  again.lifecycle.unmount();
});

test("Change main thread's menu, opened by Finish review, stays open as BB focuses the chat box, until a click outside it", async () => {
  const { askChangeThread } = await import("../lib/main-thread");
  askChangeThread("br-1");
  const slot = await renderTab(folderReview, { getSourceThread: () => MAIN }, [listed("coder", "Build snooze")]);
  await slot.findByRole("menu", { name: "Change main thread" });
  // BB's chat box, which the harness doesn't have.
  const chatBox = document.body.appendChild(document.createElement("textarea"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  chatBox.focus();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.queryByRole("menu", { name: "Change main thread" })).toBeTruthy();
  fireEvent.pointerDown(chatBox);
  await waitFor(() => expect(slot.queryByRole("menu", { name: "Change main thread" })).toBeNull());
  // Opened by a click, focus leaving closes it, as any menu.
  fireEvent.click(slot.getByRole("button", { name: "Change main thread" }));
  await slot.findByRole("menu", { name: "Change main thread" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  chatBox.focus();
  await waitFor(() => expect(slot.queryByRole("menu", { name: "Change main thread" })).toBeNull());
  chatBox.remove();
  slot.lifecycle.unmount();
});

test("an ask of the Main thread tab that BB doesn't open goes, rather than open the menu unasked later", async () => {
  const { askChangeThread } = await import("../lib/main-thread");
  const { bar, page } = await renderReview(folderReview, [1440, 1000]);
  askChangeThread("br-1");
  // The harness's panel declines, as BB does where it doesn't list the tab.
  fireEvent.click(await bar.findByRole("button", { name: "Show main thread beside review" }));
  expect(toast.error).toHaveBeenCalledWith("The main thread isn’t available here.");
  page.lifecycle.unmount();
  bar.lifecycle.unmount();
  const slot = await renderTab(folderReview, { getSourceThread: () => MAIN }, [listed("coder", "Build snooze")]);
  await slot.findByRole("button", { name: "Change main thread" });
  expect(slot.queryByRole("menu")).toBeNull();
  slot.lifecycle.unmount();
});

test("Change main thread can start a fresh thread here, which gets your Sends from then on", async () => {
  const setMainThread = vi.fn(async () => ({ ok: true }));
  const slot = await renderTab(folderReview, { getSourceThread: () => MAIN, setMainThread }, [listed("coder", "Build snooze")]);
  fireEvent.click(await slot.findByRole("button", { name: "Change main thread" }));
  const menu = within(await slot.findByRole("menu", { name: "Change main thread" }));
  expect(menu.getAllByRole("menuitemradio")).toHaveLength(1);
  fireEvent.click(menu.getByRole("menuitem", { name: "Start a fresh thread here" }));
  await waitFor(() => expect(setMainThread).toHaveBeenCalledWith({ targetKey: "br-1", fresh: true }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Started a fresh thread: your Sends go there now."));
  slot.lifecycle.unmount();
});

test("a main thread that's archived shows its conversation with no box to write in, and one deleted says what the next Send does", async () => {
  const archived = await renderTab(folderReview, { getSourceThread: () => ({ thread: { ...MAIN.thread, state: "archived" } }) });
  expect((await archived.findByTestId("bb-thread-chat")).dataset.variant).toBe("timeline");
  expect(archived.getByText(/This thread is archived\. Your next Send offers to unarchive it or start a fresh thread/)).toBeTruthy();
  archived.lifecycle.unmount();
  const gone = await renderTab(folderReview, { getSourceThread: () => ({ thread: { threadId: "coder", title: null, state: "gone" } }) });
  await waitFor(() => expect(gone.getByRole("status").textContent).toBe("The main thread was deleted. Your next Send starts a fresh thread, or choose another with Change thread."));
  expect(gone.queryByTestId("bb-thread-chat")).toBeNull();
  gone.lifecycle.unmount();
});

/** What Watch, on a Send's toast, opened beside the review. */
const watched = vi.fn();
/** A draft comment's card in Comments, its row opened, in a review whose main thread is `coder`, with `links`. */
async function renderCard(rpc: Record<string, unknown>, comment: Record<string, unknown> = {}, links: Partial<ReviewLinks> = {}) {
  fakeSize(1440, 1000);
  await loadPluginApp(() => import("../app"));
  const { DraftTray } = await import("./draft-tray.test-support");
  const { ReviewLinksContext } = await import("../lib/review-links");
  const draft = { targetKey: "k", verdict: "COMMENT", body: "", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Rename this.", ...comment }] };
  updateComments("k", { expanded: "draft:src/a.ts:2:RIGHT" });
  const component = () => <ReviewLinksContext.Provider value={{ status: { posts: false, own: true }, editor: null, ...links }}>
    <DraftTray targetKey="k" activeChapterId="c1" activeFiles={["src/a.ts"]} reviewRevision="r1" isLocal review={{ targetKey: "k", kind: "ref", sourceThreadId: "coder" } as any} workspace={{ mainThread: { threadId: "coder", title: "Build snooze", machine: "MaxBook" }, panel: { view: null, open: watched, toggle: () => {}, close: () => {} } }} />
  </ReviewLinksContext.Provider>;
  const slot = renderSlot({ component }, {}, { rpc: { setReviewPresence: () => ({ ok: true }), getReviewerNotes: () => ({ body: "", revision: 0 }), getDraft: () => ({ draft, stale: [], discussions: [] }), getSourceThread: () => MAIN, ...rpc } as any });
  await slot.findByText("Draft saved");
  return within(await slot.findByRole("article", { name: "Draft comment on src/a.ts:2" }));
}

test("Send now on a comment's card sends it alone, and says when the main thread is busy and gets it after its turn", async () => {
  const sendNow = vi.fn(async () => ({ ok: true, sent: { id: "c7", sendN: 2, threadId: "coder", title: "Build snooze", delivery: "queued" } }));
  const card = await renderCard({ sendNow });
  fireEvent.click(card.getByRole("button", { name: "Send now to Build snooze (main thread) on MaxBook" }));
  await waitFor(() => expect(sendNow).toHaveBeenCalledWith({ targetKey: "k", comment: { file: "src/a.ts", line: 2, side: "RIGHT" } }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Queued for Build snooze: it’s busy, and gets the comment when its turn ends.", expect.objectContaining({ action: expect.objectContaining({ label: "Watch" }) })));
  // Watch shows the thread beside the review, in BB's Main thread tab.
  (vi.mocked(toast.success).mock.calls.at(-1)![1] as unknown as { action: { onClick: () => void } }).action.onClick();
  expect(watched).toHaveBeenCalledWith("main");
});

test("Send now's warning shows on the card with its choices, and Send anyway sends it", async () => {
  const sendNow = vi.fn()
    .mockResolvedValueOnce({ ok: false, warning: "This is @alice’s PR, not yours. Your review on GitHub stays as it is.", offers: ["anyway"] })
    .mockResolvedValueOnce({ ok: true, sent: { id: "c7", sendN: 1, threadId: "coder", title: "Build snooze", delivery: "sent" } });
  const card = await renderCard({ sendNow });
  fireEvent.click(card.getByRole("button", { name: "Send now to Build snooze (main thread) on MaxBook" }));
  const alert = await card.findByRole("alert");
  expect(alert.textContent).toContain("This is @alice’s PR, not yours.");
  fireEvent.click(within(alert).getByRole("button", { name: "Send anyway" }));
  await waitFor(() => expect(sendNow).toHaveBeenLastCalledWith({ targetKey: "k", comment: { file: "src/a.ts", line: 2, side: "RIGHT" }, force: true }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent the comment to Build snooze.", expect.objectContaining({ action: expect.objectContaining({ label: "Watch" }) })));
  expect(card.queryByRole("alert")).toBeNull();
});

test("a sent comment says which Send carried it, to which thread, on its row, and its card offers no Send now until it changes", async () => {
  const card = await renderCard({}, { id: "c7", state: "sent", sendN: 2 }, {
    status: { posts: false, own: true, sends: [{ n: 2, at: Date.now() - 120_000, threadId: "coder", ids: ["c7"] }], sent: { at: 1, threadId: "coder", title: "Build snooze", comments: [] } },
  });
  expect(within(document.body).getByRole("button", { name: /^Sent to Build snooze · Send 2 · src\/a\.ts:2/ })).toBeTruthy();
  expect(card.queryByRole("button", { name: /^Send now/ })).toBeNull();
});

test("on your PR whose folder a fixer took over, Change offers a fresh thread, not one here: the server starts a fixer at the PR's head", async () => {
  const setMainThread = vi.fn(async () => ({ ok: true }));
  const rehomed = { ...folderReview, targetKey: "pr-12", kind: "pr", repo: "acme/api", number: 12, ownPr: true,
    feature: { ...folderReview.feature, environmentId: "env_fix", workBranch: "bb/fix" }, mainThread: { threadId: "coder", environmentId: "env_fix", origin: "fresh", since: 2, fixer: { sha: "a".repeat(40), at: 2 } } };
  const slot = await renderTab(rehomed, { getSourceThread: () => MAIN, setMainThread }, [listed("coder", "Build snooze", { environment: { id: "env_fix" } })]);
  fireEvent.click(await slot.findByRole("button", { name: "Change main thread" }));
  const menu = within(await slot.findByRole("menu", { name: "Change main thread" }));
  expect(menu.queryByRole("menuitem", { name: "Start a fresh thread here" })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Start a fresh thread" }));
  await waitFor(() => expect(setMainThread).toHaveBeenCalledWith({ targetKey: "pr-12", fresh: true }));
  slot.lifecycle.unmount();
});
