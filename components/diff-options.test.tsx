// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

/** A pane this size, its pointer `fine` (a mouse or trackpad) or not; media queries answer for a screen this size. */
function fakeScreen(width: number, height: number, fine: boolean) {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private notify: ResizeObserverCallback) {}
    observe(target: Element) { this.notify([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const max = query.match(/max-(width|height): (\d+)px/);
    const matches = max ? (max[1] === "width" ? width : height) <= Number(max[2]) : query === "(any-pointer: fine)" ? fine : query === "(pointer: coarse)" ? !fine : false;
    return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  });
  restores.push(() => { globalThis.ResizeObserver = original; matchMedia.mockRestore(); });
}

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const patch = file("src/a.ts", "aa") + file("src/b.ts", "bb");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };
const thread = { id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 1, side: "RIGHT", comments: [{ id: "c", databaseId: 1, author: "bob", body: "Why?" }] };

async function renderWorkspace(review: Record<string, unknown> = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: [thread] }),
    getPrCommits: () => ({ commits: [{ sha: "new", headline: "Parse rows", committedAt: 2 }, { sha: "c1aaaaa", headline: "Read rows", committedAt: 1 }] }),
    getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(file("src/a.ts", "a0") + file("src/b.ts", "bb"), patch) }),
  } as any });
  await slot.findAllByTestId("filediff");
  return slot;
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const openOptions = (slot: Slot) => fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
const names = (slot: Slot) => slot.getAllByRole("switch").map((option) => option.textContent);

test("Diff options holds how the diff draws, then the chapter's files, then the keyboard shortcuts where there's a fine pointer", async () => {
  fakeScreen(1400, 900, true);
  const slot = await renderWorkspace();
  openOptions(slot);
  const layout = within(await slot.findByRole("radiogroup", { name: "Layout" }));
  expect(layout.getAllByRole("radio").map((choice) => choice.textContent)).toEqual(["Unified", "Split"]);
  // Fold comments is the band's own button here.
  await waitFor(() => expect(names(slot)).toEqual(["Wrap long lines", "Hide whitespace changes", "GitHub threads in code"]));
  expect(slot.getByText("Files in this chapter")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Keyboard shortcuts ?" }));
  expect(await slot.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on touch alone, Diff options has no keyboard shortcuts", async () => {
  fakeScreen(1400, 900, false);
  const slot = await renderWorkspace();
  openOptions(slot);
  await slot.findByRole("switch", { name: "Wrap long lines" });
  expect(slot.queryByRole("button", { name: /^Keyboard shortcuts/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("Collapse all and Expand all fold and unfold every file of the chapter, closing Diff options", async () => {
  fakeScreen(1400, 900, true);
  const slot = await renderWorkspace();
  openOptions(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Collapse all" }));
  await waitFor(() => expect(slot.queryAllByTestId("filediff")).toEqual([]));
  expect(slot.queryByRole("switch", { name: "Wrap long lines" })).toBeNull();
  openOptions(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Expand all" }));
  await waitFor(() => expect(slot.getAllByTestId("filediff")).toHaveLength(2));
  slot.lifecycle.unmount();
});

test("on a first review Diff options compares with a commit, on a page of its own with the way back", async () => {
  fakeScreen(1400, 900, true);
  const slot = await renderWorkspace();
  openOptions(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Compare with a commit…" }));
  const menu = within(await slot.findByRole("menu", { name: "Show changes" }));
  expect(await menu.findByText("Read rows")).toBeTruthy();
  expect(slot.queryByRole("switch", { name: "Wrap long lines" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Back to Diff options" }));
  expect(await slot.findByRole("switch", { name: "Wrap long lines" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on a phone Diff options is a drawer from the chapters sheet, with Fold comments, and Show changes, which the diff then says above its files", async () => {
  fakeScreen(390, 844, false);
  const slot = await renderWorkspace({ signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" });
  fireEvent.click(slot.getByRole("button", { name: /^pr-42, Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Diff options" }));
  expect(await slot.findByRole("switch", { name: "Fold comments in code" })).toBeTruthy();
  expect(slot.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
  fireEvent.click(within(slot.getByRole("radiogroup", { name: "Show changes" })).getByRole("radio", { name: "All" }));
  await waitFor(() => expect(slot.getAllByTestId("filediff")).toHaveLength(2));
  const shown = within(slot.getByRole("radiogroup", { name: "Changes shown" }));
  expect(shown.getByRole("radio", { name: "All changes" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(shown.getByRole("radio", { name: "Since your review · 1 of 2 files" }));
  await waitFor(() => expect(slot.getAllByTestId("filediff")).toHaveLength(1));
  expect(within(slot.getByRole("radiogroup", { name: "Show changes" })).getByRole("radio", { name: "Since your review" }).getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
});

test("on a phone, a local review with a Send switches between all changes and since your last Send in Diff options, and the diff says which", async () => {
  fakeScreen(390, 844, false);
  const slot = await renderWorkspace({ kind: "ref", gitRef: "main...feature", headSha: null, sends: [{ n: 2, at: 1, threadId: "thr_main", ids: ["c2"] }] });
  fireEvent.click(slot.getByRole("button", { name: /Chapters:/ }));
  fireEvent.click(within(slot.getByRole("dialog", { name: "Chapters" })).getByRole("button", { name: "Diff options" }));
  const changes = within(await slot.findByRole("radiogroup", { name: "Show changes" }));
  expect(changes.getAllByRole("radio").map((choice) => choice.textContent)).toEqual(["All", "Since your last Send"]);
  expect(slot.queryByRole("button", { name: "Compare with a commit…" })).toBeNull();
  fireEvent.click(changes.getByRole("radio", { name: "Since your last Send" }));
  await waitFor(() => expect(slot.getAllByTestId("filediff")).toHaveLength(1));
  expect(within(slot.getByRole("radiogroup", { name: "Changes shown" })).getByRole("radio", { name: "Since your last Send · 1 of 2 files" }).getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
});
