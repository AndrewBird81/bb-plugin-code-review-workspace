// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Each diff's new lines, the lines pierre would highlight, and a pick of line 1 as pierre reports it.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff, options, selectedLines }: any) => {
    const pick = () => { const range = { start: 1, end: 1, side: "additions" }; options.onLineSelectionStart?.(range); options.onLineSelectionEnd?.(range); options.onLineSelected?.(range); };
    return (
      <div data-testid="filediff" data-selected={selectedLines ? `${selectedLines.start}-${selectedLines.end}` : ""}>
        <pre>{fileDiff.additionLines.join("\n")}</pre>
        <button onClick={pick}>Pick line 1</button>
      </div>
    );
  },
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = [
  file("src/a.ts", "@@ -1 +1 @@\n-a\n+aa\n"),
  file("src/b.ts", "@@ -1 +1 @@\n-b\n+bb\n"),
  file("src/c.ts", "@@ -1 +1 @@\n-c\n+cc\n"),
].join("");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts", summary: "Reads a row." }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts", summary: "Caches a row." }, { file: "src/c.ts", summary: "Evicts a row." }] },
  ],
};

async function renderWorkspace({ review = {}, rpc = {}, bundle = {} }: { review?: Record<string, unknown>; rpc?: Record<string, unknown>; bundle?: Record<string, unknown> } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: structuredClone(guide), patch, revision: "r1", ...bundle })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [] })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    setFilesViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("heading", { name: "Parse rows" });
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
const currentChapter = (slot: Slot) => chapters(slot).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step");

test("reopening a review returns to the chapter you were on", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace();
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
});

test("the diff opens on the chapter's intro and shows each file's summary in its header", async () => {
  const overview = "Rows are cached by id. The cache evicts the **oldest** row first. Writes go through the cache. Reads fall back to the store. Nothing else changes.";
  const { slot } = await renderWorkspace({ bundle: { guide: { ...guide, sections: [{ ...guide.sections[0], overview, risk: "high" }, guide.sections[1]] } } });
  const main = within(slot.getByRole("main"));
  const intro = within(await main.findByRole("region", { name: "Parsing" }));
  expect(intro.getByText("High risk")).toBeTruthy();
  expect(intro.getByText(/Nothing else changes\./)).toBeTruthy();
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"]')!).getByText("Reads a row.")).toBeTruthy();
  // Hiding the overview sticks in this browser.
  fireEvent.click(intro.getByRole("button", { name: "Hide chapter overview" }));
  expect(intro.queryByText(/Nothing else changes\./)).toBeNull();
  slot.lifecycle.unmount();
  const again = await renderWorkspace();
  const reopened = within(await within(again.slot.getByRole("main")).findByRole("region", { name: "Parsing" }));
  expect(reopened.getByRole("button", { name: "Show chapter overview" }).getAttribute("aria-expanded")).toBe("false");
  expect(reopened.queryByText("Reads rows.")).toBeNull();
  again.slot.lifecycle.unmount();
});

const scroller = (slot: Slot) => slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;

test("after a chapter's last file, Next opens the next chapter at its top", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  scroller(slot).scrollTop = 400;
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Next: Caching" }));
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  expect(scroller(slot).scrollTop).toBe(0);
  // The last chapter has nothing next.
  expect(within(slot.getByRole("main")).queryByRole("button", { name: /^Next:/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("Mark chapter viewed and continue marks the chapter's files and opens the next", async () => {
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Mark chapter viewed and continue" }));
  await slot.findByText("bb");
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] });
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
});

test("a review back with changes opens on the first chapter that changed, unless you were reading one", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+bb", "+b0");
  const sinceReview = { review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) } };
  const { slot } = await renderWorkspace(sinceReview);
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
  patchReviewState("pr-42", { activeId: "c1" });
  const again = await renderWorkspace(sinceReview);
  await waitFor(() => expect(chapters(again.slot).getByText("1 changed")).toBeTruthy());
  expect(currentChapter(again.slot)?.textContent).toContain("Parsing");
  again.slot.lifecycle.unmount();
});

const reviewedPatch = patch.replace("+bb", "+b0");
async function sinceReviewSetup() {
  const { interdiff } = await import("../src/interdiff");
  return { review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewedPatch, patch) }) } };
}

test("under Since your review, opening a file unchanged since then turns the filter off to show it", async () => {
  const setup = await sinceReviewSetup();
  const comment = { file: "src/a.ts", line: 1, side: "RIGHT", body: "Why?", author: "reviewer" };
  const { slot } = await renderWorkspace({ ...setup, rpc: { ...setup.rpc, getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] } }) } });
  const filter = await slot.findByRole("button", { name: "Since your review" });
  fireEvent.click(chapters(slot).getByText("Parsing"));
  fireEvent.click(filter);
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull();
  fireEvent.click(chapters(slot).getByText("a.ts"));
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeTruthy();
  // A draft comment's Show in diff does the same.
  fireEvent.click(filter);
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  if (draftTool.getAttribute("aria-pressed") !== "true") fireEvent.click(draftTool);
  fireEvent.click(await slot.findByRole("button", { name: /^src\/a\.ts:1/ }));
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  slot.lifecycle.unmount();
}, 15_000);

test("files no chapter lists show in a last Other files chapter, count toward viewed, and open from a comment", async () => {
  const comment = { file: "src/c.ts", line: 1, side: "RIGHT", body: "Why?", author: "reviewer" };
  const placed = { ...guide, unplacedFiles: ["src/c.ts"], sections: [guide.sections[0], { ...guide.sections[1], diffs: [guide.sections[1].diffs[0]] }] };
  const { slot } = await renderWorkspace({ bundle: { guide: placed }, rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] } }) } });
  await slot.findByText("aa");
  expect(chapters(slot).getByText("0/3 files viewed")).toBeTruthy();
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  if (draftTool.getAttribute("aria-pressed") !== "true") fireEvent.click(draftTool);
  fireEvent.click(await slot.findByRole("button", { name: /^src\/c\.ts:1/ }));
  await slot.findByText("cc");
  expect(currentChapter(slot)?.textContent).toContain("Other files");
  slot.lifecycle.unmount();
}, 15_000);

test("a line selection's bar and highlight go once it's used, cleared, or its chapter closes", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const highlighted = () => slot.getByTestId("filediff").dataset.selected;
  const bar = () => slot.queryByRole("button", { name: "Clear selection" })?.parentElement ?? null;
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  expect(highlighted()).toBe("1-1");
  fireEvent.click(within(bar()!).getByRole("button", { name: "Add comment" }));
  expect(bar()).toBeNull();
  await waitFor(() => expect(highlighted()).toBe(""));
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  expect(highlighted()).toBe("");
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Next: Caching" }));
  await slot.findByText("bb");
  expect(bar()).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("Ask agent about this goes when the diff scrolls away from its text", async () => {
  const { slot } = await renderWorkspace();
  const text = await slot.findByText("aa");
  const measure = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 10, height: 10 }) as DOMRect;
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(scroller(slot));
  expect(slot.getByRole("button", { name: "Ask agent about this" })).toBeTruthy();
  fireEvent.scroll(scroller(slot));
  expect(slot.queryByRole("button", { name: "Ask agent about this" })).toBeNull();
  Range.prototype.getBoundingClientRect = measure;
  slot.lifecycle.unmount();
}, 15_000);

// jsdom has no layout: the file last scrolled to sits at the top, the others far below or above it.
function fakeLayout() {
  let top: string | undefined;
  const scrollIntoView = Element.prototype.scrollIntoView;
  const measure = Element.prototype.getBoundingClientRect;
  Element.prototype.scrollIntoView = function (this: Element) { top = (this as HTMLElement).dataset.file ?? top; };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const file = (this as HTMLElement).dataset?.file;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-file]")).map((el) => el.dataset.file);
    const offset = file && top ? (cards.indexOf(file) - cards.indexOf(top)) * 1000 : file ? 500 : 0;
    return { top: offset, left: 0, width: 0, height: 0, right: 0, bottom: 0 } as DOMRect;
  };
  return { top: () => top, restore: () => { Element.prototype.scrollIntoView = scrollIntoView; Element.prototype.getBoundingClientRect = measure; } };
}
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });

test("j and k move between files, n and p between chapters, and v marks the file viewed and moves on", async () => {
  const layout = fakeLayout();
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  press("n");
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  press("j");
  expect(layout.top()).toBe("src/b.ts");
  press("j");
  expect(layout.top()).toBe("src/c.ts");
  press("k");
  expect(layout.top()).toBe("src/b.ts");
  press("v");
  expect(rpc.setFileViewed).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/b.ts", viewed: true });
  await waitFor(() => expect(layout.top()).toBe("src/c.ts"));
  press("p");
  await slot.findByText("aa");
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  layout.restore();
  slot.lifecycle.unmount();
}, 15_000);

test("shortcuts wait while you type, and with Ctrl, Meta, or Alt held", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("n", { ctrlKey: true });
  press("n", { metaKey: true });
  press("n", { altKey: true });
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  if (draftTool.getAttribute("aria-pressed") !== "true") fireEvent.click(draftTool);
  fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
  press("n", {}, slot.getByRole("textbox", { name: "Draft comment" }));
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  slot.lifecycle.unmount();
}, 15_000);

test("shortcuts still work after clicking a Viewed checkbox", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const viewed = slot.getByRole("checkbox", { name: "Viewed src/a.ts" });
  fireEvent.click(viewed);
  press("n", {}, viewed);
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
}, 15_000);

test("u opens the next unviewed file in any chapter", async () => {
  const layout = fakeLayout();
  const { slot } = await renderWorkspace({ rpc: { getFileViews: () => ({ views: [{ file: "src/b.ts", viewed: true, stale: false }] }) } });
  await slot.findByText("aa");
  await waitFor(() => expect(chapters(slot).getByText("1/3 files viewed")).toBeTruthy());
  press("j");
  press("u");
  await slot.findByText("cc");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  await waitFor(() => expect(layout.top()).toBe("src/c.ts"));
  layout.restore();
  slot.lifecycle.unmount();
}, 15_000);

test("] and [ go through draft comments and discussions in the guide's order", async () => {
  const comments = [
    { file: "src/c.ts", line: 1, side: "RIGHT", body: "Third", author: "reviewer" },
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "First", author: "reviewer" },
  ];
  const discussions = [{ file: "src/b.ts", line: 1, side: "RIGHT", waiting: false, undoable: false, entries: [{ author: "reviewer", kind: "message", body: "Second?", createdAt: 1 }] }];
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments, discussions } }),
  } });
  await slot.findByText("aa");
  const draftTool = slot.getByRole("button", { name: "Draft review" });
  if (draftTool.getAttribute("aria-pressed") !== "true") fireEvent.click(draftTool);
  await slot.findByRole("button", { name: /^src\/a\.ts:1/ });
  press("]");
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  press("]");
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  press("[");
  await slot.findByText("aa");
  press("[");
  // Before the first, the last.
  await slot.findByText("cc");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
}, 15_000);

test("a asks the agent, s opens the draft to submit, and ? lists the shortcuts until Esc", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("a");
  await waitFor(() => expect(slot.container.querySelector("[data-tool=\"agent\"]")!.getAttribute("aria-pressed")).toBe("true"));
  press("s");
  await waitFor(() => expect(slot.getByRole("button", { name: "Draft review" }).getAttribute("aria-pressed")).toBe("true"));
  press("?");
  const help = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(within(help).getByText("Next unviewed file, in any chapter")).toBeTruthy();
  fireEvent.keyDown(help, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
  slot.lifecycle.unmount();
}, 15_000);

test("the toolbar counts the chapter's viewed files as such, and marks the chapter viewed", async () => {
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(chapters(slot).getByText("Caching"));
  const main = within(slot.getByRole("main"));
  await main.findByText("0/2 in this chapter");
  fireEvent.click(main.getByRole("button", { name: "Mark chapter viewed" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  slot.lifecycle.unmount();
}, 15_000);

test("a failed re-review offers Retry, and an account without access offers the account switcher", async () => {
  const rereview = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ review: { status: "error" }, rpc: {
    rereview,
    checkRepoAccess: () => ({ accessible: false, repo: "acme/web", account: "me" }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }, { login: "work", active: false }] }),
  } });
  await slot.findByText(/Re-review failed/);
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  await slot.findByText(/can’t access acme\/web/);
  expect(slot.getByRole("button", { name: "GitHub account: @me" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a local review has no Threads view, and the agent goes by one name", async () => {
  const { slot } = await renderWorkspace({ review: { kind: "ref", targetKey: "pr-42" } });
  await slot.findByText("aa");
  expect(within(slot.getByRole("main")).queryByRole("button", { name: "Threads" })).toBeNull();
  expect(slot.queryByRole("button", { name: /assistant/i })).toBeNull();
  expect(slot.getAllByRole("button", { name: "Ask agent" }).length).toBeGreaterThan(0);
  slot.lifecycle.unmount();
}, 15_000);
