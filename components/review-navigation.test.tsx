// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import { getCommentsFolded, getReviewState, patchReviewState, setHideNits } from "../lib/panel-state";

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
// A pane as wide as a desktop's, where the side panel docks beside the chapters.
const windowWidth = window.innerWidth;
beforeEach(() => { window.innerWidth = 1440; });
afterEach(() => { window.innerWidth = windowWidth; });

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

async function renderWorkspace({ review = {}, rpc = {}, bundle = {}, opened = true }: { review?: Record<string, unknown>; rpc?: Record<string, unknown>; bundle?: Record<string, unknown>; opened?: boolean } = {}) {
  // Opened before, on its first chapter, unless `opened` is false: a first open shows the Overview.
  if (opened && !getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
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
  await slot.findByRole("main", { name: "Review" });
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
/** Comments' Drafts, in the side panel, from the band's Comments where BB's title bar didn't take it. */
const openDrafts = async (slot: Slot) => fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
const finishing = (slot: Slot) => !!slot.queryByRole("heading", { name: "Finish review" });
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
  // The last chapter has no next chapter, but offers to finish.
  expect(within(slot.getByRole("main")).queryByRole("button", { name: /^Next:/ })).toBeNull();
  slot.lifecycle.unmount();
});

test("the chapter end's Next, and Mark viewed and continue, give the focus to the next chapter's title", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const main = within(slot.getByRole("main"));
  const next = main.getByRole("button", { name: "Next: Caching" });
  next.focus();
  fireEvent.click(next);
  await waitFor(() => expect(document.activeElement).toBe(main.getByRole("heading", { name: "Caching" })));
  slot.lifecycle.unmount();
  patchReviewState("pr-42", { activeId: "c1" });
  const again = await renderWorkspace();
  await again.slot.findByText("aa");
  const button = within(again.slot.getByRole("main")).getByRole("button", { name: "Mark viewed and continue" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Caching"));
  again.slot.lifecycle.unmount();
}, 15_000);

test("the last chapter ends on Finish review, marking the chapter viewed if you ask", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("bb");
  const main = within(slot.getByRole("main"));
  expect(finishing(slot)).toBe(false);
  fireEvent.click(main.getByRole("button", { name: "Mark viewed and finish" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  await waitFor(() => expect(finishing(slot)).toBe(true));
  fireEvent.click(slot.getByRole("button", { name: "Close panel" }));
  await waitFor(() => expect(finishing(slot)).toBe(false));
  fireEvent.click(main.getByRole("button", { name: "Finish review" }));
  await waitFor(() => expect(finishing(slot)).toBe(true));
  slot.lifecycle.unmount();
}, 15_000);

test("Mark viewed and continue marks the chapter's files and opens the next", async () => {
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Mark viewed and continue" }));
  await slot.findByText("bb");
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] });
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
});

test("a chapter's end counts its files viewed and its comments, and once they're all viewed, the way on is its main button", async () => {
  const comments = [
    { file: "src/b.ts", line: 1, side: "RIGHT", body: "Why?", author: "reviewer" },
    { file: "src/c.ts", line: 1, side: "RIGHT", body: "Spacing.", author: "agent", severity: "nit" },
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Elsewhere.", author: "reviewer" },
  ];
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments } }),
    getFileViews: () => ({ views: [{ file: "src/b.ts", viewed: true, stale: false }, { file: "src/c.ts", viewed: true, stale: false }] }),
  } });
  // Viewed files open folded.
  const main = within(slot.getByRole("main"));
  expect(await main.findByText("2 of 2 files viewed")).toBeTruthy();
  expect(main.getByText("2 comments")).toBeTruthy();
  // Nothing left to mark: finishing is the way on.
  expect(main.queryByRole("button", { name: "Mark viewed and finish" })).toBeNull();
  expect(main.getByRole("button", { name: "Finish review" }).className).toContain("bg-primary");
  slot.lifecycle.unmount();
});

test("the last chapter's end names the files not viewed yet in the others, and Next unviewed opens the first", async () => {
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace({ rpc: { getFileViews: () => ({ views: [{ file: "src/c.ts", viewed: true, stale: false }] }) } });
  await slot.findByText("bb");
  const main = within(slot.getByRole("main"));
  const left = await main.findByText(/not viewed yet/);
  expect(left.textContent).toBe("1 file not viewed yet: a.ts");
  // jsdom has no scrollIntoView: record the file the chapter switch scrolls to, a frame later.
  const scrollIntoView = Element.prototype.scrollIntoView;
  const scrolled: (string | undefined)[] = [];
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push((this as HTMLElement).dataset.file); };
  try {
    fireEvent.click(main.getByRole("button", { name: "Next unviewed" }));
    // From b.ts, the chapter's own unviewed file, it goes on to the next: around to a.ts in chapter 1.
    await slot.findByText("aa");
    expect(currentChapter(slot)?.textContent).toContain("Parsing");
    expect(main.queryByText(/not viewed yet/)).toBeNull();
    await waitFor(() => expect(scrolled).toContain("src/a.ts"));
    slot.lifecycle.unmount();
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
}, 15_000);

test("picking a file jumps to it in a chapter still drawing its files, or far down; nearby it scrolls smoothly", async () => {
  // 150 files of 40 rows: over the 3,000 rows that make a chapter draw its files as they near the screen, which a smooth
  // scroll would cross, drawing each. jsdom has no IntersectionObserver, without which the chapter draws them all.
  const lines = (path: string, count: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${count} +1,${count} @@\n${Array.from({ length: count }, (_, i) => `-old${i}`).join("\n")}\n${Array.from({ length: count }, (_, i) => `+new${i}`).join("\n")}\n`;
  const paths = Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`);
  const big = { ...guide, sections: [{ id: "c1", title: "Parsing", overview: "", diffs: paths.map((path) => ({ file: path })) }] };
  const observer = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
  const layout = fakeLayout({ height: 400 });
  const scrolls: Array<{ file?: string; behavior?: ScrollBehavior }> = [];
  const fake = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    // The file cards, not the sidebar's rows that follow them.
    if ((this as HTMLElement).dataset.file) scrolls.push({ file: (this as HTMLElement).dataset.file, behavior: typeof options === "object" ? options.behavior : undefined });
    fake.call(this, options);
  };
  const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 800 });
  const pick = (slot: Slot, path: string) => fireEvent.click(chapters(slot).getByTitle(new RegExp(`^${path.replace(".", "\\.")}`)));
  try {
    const large = await renderWorkspace({ bundle: { guide: big, patch: paths.map((path) => lines(path, 20)).join("") } });
    await waitFor(() => expect(large.slot.container.querySelector("[data-pending-diff]")).toBeTruthy());
    pick(large.slot, "src/f140.ts");
    await waitFor(() => expect(scrolls.at(-1)).toEqual({ file: "src/f140.ts", behavior: "auto" }));
    large.slot.lifecycle.unmount();
    cleanup();
    layout.scrollTo(undefined);
    // A chapter of usual size: smooth to a file within three screens, a jump past them.
    const usual = await renderWorkspace({ bundle: { guide: big, patch: paths.map((path) => lines(path, 2)).join("") } });
    await waitFor(() => expect(usual.slot.getAllByTestId("filediff")).toHaveLength(150));
    expect(usual.slot.container.querySelector("[data-pending-diff]")).toBeNull();
    pick(usual.slot, "src/f2.ts");
    await waitFor(() => expect(scrolls.at(-1)).toEqual({ file: "src/f2.ts", behavior: "smooth" }));
    pick(usual.slot, "src/f40.ts");
    await waitFor(() => expect(scrolls.at(-1)).toEqual({ file: "src/f40.ts", behavior: "auto" }));
    usual.slot.lifecycle.unmount();
  } finally {
    layout.restore();
    Object.defineProperty(Element.prototype, "clientHeight", clientHeight);
    globalThis.IntersectionObserver = observer;
  }
}, 30_000);

test("a review back with changes opens on its Overview, which goes on to the first chapter that changed, unless you were reading one", async () => {
  const { interdiff } = await import("../src/interdiff");
  const reviewed = patch.replace("+bb", "+b0");
  const sinceReview = { review: { signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }) } };
  const { slot } = await renderWorkspace({ ...sinceReview, opened: false });
  fireEvent.click(await slot.findByRole("button", { name: "Review changes: Caching" }));
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
  // The band's compare select, narrowed to what changed since your review.
  const narrow = async () => {
    fireEvent.click(await slot.findByRole("button", { name: /^Show changes: / }));
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /^Since your review/ }));
  };
  const showing = () => slot.getByRole("button", { name: /^Show changes: / }).getAttribute("aria-label");
  fireEvent.click(chapters(slot).getByText("Parsing"));
  await narrow();
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull();
  fireEvent.click(chapters(slot).getByText("a.ts"));
  expect(showing()).toBe("Show changes: All changes");
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeTruthy();
  // A draft comment's Show in diff does the same.
  await narrow();
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: /^Draft · not submitted · src\/a\.ts:1/ }));
  expect(showing()).toBe("Show changes: All changes");
  slot.lifecycle.unmount();
}, 15_000);

test("files no chapter lists show in a last Other files chapter, count toward viewed, and open from a comment", async () => {
  const comment = { file: "src/c.ts", line: 1, side: "RIGHT", body: "Why?", author: "reviewer" };
  const placed = { ...guide, unplacedFiles: ["src/c.ts"], sections: [guide.sections[0], { ...guide.sections[1], diffs: [guide.sections[1].diffs[0]] }] };
  const { slot } = await renderWorkspace({ bundle: { guide: placed }, rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment] } }) } });
  await slot.findByText("aa");
  expect(chapters(slot).getByText("0/3 files viewed")).toBeTruthy();
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: /^Draft · not submitted · src\/c\.ts:1/ }));
  await slot.findByText("cc");
  expect(currentChapter(slot)?.textContent).toContain("Other files");
  slot.lifecycle.unmount();
}, 15_000);

test("a line selection's bar and highlight go once it's used, cleared, or its chapter closes", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const highlighted = () => slot.getByTestId("filediff").dataset.selected;
  const bar = () => slot.queryByRole("group", { name: "Selection" });
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  expect(highlighted()).toBe("1-1");
  fireEvent.click(within(bar()!).getByRole("button", { name: "Comment" }));
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

test("Esc clears a line selection, once nothing is over the code", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const highlighted = () => slot.getByTestId("filediff").dataset.selected;
  fireEvent.click(slot.getByRole("button", { name: "Pick line 1" }));
  expect(highlighted()).toBe("1-1");
  // The shortcuts over the code go first.
  press("?");
  const help = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
  fireEvent.keyDown(help, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
  expect(highlighted()).toBe("1-1");
  press("Escape");
  expect(highlighted()).toBe("");
  expect(slot.queryByRole("group", { name: "Selection" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("code you select, as a long-press does on touch, offers Ask agent about selection, which asks the agent about it", async () => {
  const { slot } = await renderWorkspace();
  const text = await slot.findByText("aa");
  const select = (node: Node | null) => {
    window.getSelection()!.removeAllRanges();
    if (node) { const range = document.createRange(); range.selectNodeContents(node); window.getSelection()!.addRange(range); }
    // A touch selection tells only selectionchange, not mouseup.
    fireEvent(document, new Event("selectionchange"));
  };
  select(text);
  const bar = within(await slot.findByRole("group", { name: "Selection" }));
  expect(bar.getByText("a.ts")).toBeTruthy();
  // Gone with the selection, a moment later: a tap on the bar can clear it before the tap's click.
  select(null);
  await waitFor(() => expect(slot.queryByRole("group", { name: "Selection" })).toBeNull());
  select(text);
  fireEvent.click(await slot.findByRole("button", { name: "Ask agent about selection" }));
  expect(await slot.findByRole("textbox", { name: "Ask the agent" })).toBeTruthy();
  expect(await within(slot.getByRole("complementary", { name: "Comments and agent" })).findByText("a.ts")).toBeTruthy();
  expect(window.getSelection()!.toString()).toBe("");
  expect(slot.queryByRole("group", { name: "Selection" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

// jsdom has no layout: the file last scrolled to sits at the top, the others `height` apart below or above it.
// A chapter that can't scroll keeps its first file below the intro, whatever is scrolled to.
function fakeLayout({ height = 1000, stuck = false } = {}) {
  let top: string | undefined;
  const scrollIntoView = Element.prototype.scrollIntoView;
  const measure = Element.prototype.getBoundingClientRect;
  const tops: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) { const file = (this as HTMLElement).dataset.file; if (file) tops.push(file); if (!stuck) top = file ?? top; };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const file = (this as HTMLElement).dataset?.file;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-file]")).map((el) => el.dataset.file);
    const offset = file && top ? (cards.indexOf(file) - cards.indexOf(top)) * height : file ? 500 + cards.indexOf(file) * height : 0;
    return { top: offset, left: 0, width: 0, height: file ? height : 0, right: 0, bottom: file ? offset + height : 0 } as DOMRect;
  };
  return {
    top: () => (stuck ? tops.at(-1) : top),
    scrollTo: (file: string | undefined) => { top = file; },
    restore: () => { Element.prototype.scrollIntoView = scrollIntoView; Element.prototype.getBoundingClientRect = measure; },
  };
}
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });

test("j and k move between files, n and p between chapters, and v marks the file viewed and moves on", async () => {
  const layout = fakeLayout();
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  press("n");
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  // The chapter opens on its first file, so j goes to the second.
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

const currentFile = (slot: Slot) => chapters(slot).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "true")?.textContent;

test("on the Overview, j starts the first chapter, and k stays", async () => {
  const { slot } = await renderWorkspace({ opened: false });
  await slot.findByRole("button", { name: /^Overview/ });
  expect(currentChapter(slot)).toBeUndefined();
  press("k");
  expect(currentChapter(slot)).toBeUndefined();
  press("j");
  await waitFor(() => expect(currentChapter(slot)?.textContent).toContain("Parsing"));
  await slot.findByText("aa");
  slot.lifecycle.unmount();
}, 15_000);

test("on a chapter's intro, j goes to the chapter's first file before the next one", async () => {
  const layout = fakeLayout();
  // A chapter long enough to scroll.
  const sizes = { scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"), clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 800 });
  try {
    const { slot } = await renderWorkspace();
    await slot.findByText("aa");
    press("n");
    await slot.findByText("bb");
    press("j");
    expect(layout.top()).toBe("src/b.ts");
    press("j");
    expect(layout.top()).toBe("src/c.ts");
    slot.lifecycle.unmount();
  } finally {
    for (const [name, descriptor] of Object.entries(sizes)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as any)[name];
    }
    layout.restore();
  }
}, 15_000);

test("choosing a chapter by click, n, or p makes its first file current, so j from its intro goes there", async () => {
  const layout = fakeLayout();
  const sizes = { scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"), clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 800 });
  // c.ts is in both chapters, so going to it in one keeps it in the other.
  const shared = { ...guide, sections: [{ ...guide.sections[0], diffs: [guide.sections[0].diffs[0], guide.sections[1].diffs[1]] }, guide.sections[1]] };
  try {
    const { slot } = await renderWorkspace({ bundle: { guide: shared } });
    await slot.findByText("aa");
    press("j");
    press("j");
    expect(layout.top()).toBe("src/c.ts");
    press("n");
    await slot.findByText("bb");
    // A chapter opens at its top.
    layout.scrollTo(undefined);
    await waitFor(() => expect(currentFile(slot)).toBe("b.ts"));
    press("j");
    expect(layout.top()).toBe("src/b.ts");
    press("p");
    await slot.findByText("aa");
    layout.scrollTo(undefined);
    press("j");
    expect(layout.top()).toBe("src/a.ts");
    fireEvent.click(chapters(slot).getByText("Caching"));
    await slot.findByText("bb");
    layout.scrollTo(undefined);
    press("j");
    expect(layout.top()).toBe("src/b.ts");
    slot.lifecycle.unmount();
  } finally {
    for (const [name, descriptor] of Object.entries(sizes)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as any)[name];
    }
    layout.restore();
  }
}, 15_000);

test("j, k, and v act on the file they went to, even in a chapter that can't scroll, and the sidebar marks it", async () => {
  const layout = fakeLayout({ stuck: true });
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  press("n");
  await slot.findByText("bb");
  expect(currentFile(slot)).toBe("b.ts");
  press("j");
  expect(currentFile(slot)).toBe("c.ts");
  press("v");
  expect(rpc.setFileViewed).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/c.ts", viewed: true });
  press("k");
  expect(currentFile(slot)).toBe("b.ts");
  press("v");
  expect(rpc.setFileViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", file: "src/b.ts", viewed: true });
  layout.restore();
  slot.lifecycle.unmount();
}, 15_000);

test("v marks the file at the top even when the next file's header is just below it, and scrolling moves the current file", async () => {
  const layout = fakeLayout({ height: 50 });
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  press("n");
  await slot.findByText("bb");
  press("k");
  expect(layout.top()).toBe("src/b.ts");
  press("v");
  expect(rpc.setFileViewed).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/b.ts", viewed: true });
  await waitFor(() => expect(currentFile(slot)).toBe("c.ts"));
  // Scrolling yourself makes the file at the top current.
  fireEvent.wheel(scroller(slot));
  layout.scrollTo("src/b.ts");
  fireEvent.scroll(scroller(slot));
  await waitFor(() => expect(currentFile(slot)).toBe("b.ts"));
  layout.restore();
  slot.lifecycle.unmount();
}, 15_000);

test("shortcuts wait while you type, and with Ctrl, Meta, or Alt held", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("n", { ctrlKey: true });
  press("n", { metaKey: true });
  press("n", { altKey: true });
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Comment options" }));
  fireEvent.click(await slot.findByRole("button", { name: "Add comment by line…" }));
  press("n", {}, slot.getByRole("textbox", { name: "Draft comment" }));
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  slot.lifecycle.unmount();
}, 15_000);

test("keys work inside the chapters over the code, as in docked ones", async () => {
  // Too narrow for the chapters to dock: they open over the code, a dialog with the focus in it.
  window.innerWidth = 700;
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(slot.getByRole("button", { name: "Show chapters" }));
  const side = slot.getByRole("dialog", { name: "Chapters" });
  press("n", {}, within(side).getAllByRole("button")[0]!);
  await slot.findByText("bb");
  slot.lifecycle.unmount();
}, 15_000);

test("v and Mark chapter viewed (⇧V) fold or open a file the checkbox folded before", async () => {
  const viewed = new Set<string>();
  const { slot } = await renderWorkspace({ rpc: {
    getFileViews: () => ({ views: [...viewed].map((file) => ({ file, viewed: true, stale: false })) }),
    setFileViewed: ({ file, viewed: on }: { file: string; viewed: boolean }) => { if (on) viewed.add(file); else viewed.delete(file); return { ok: true }; },
    setFilesViewed: ({ files }: { files: string[] }) => { files.forEach((file) => viewed.add(file)); return { ok: true }; },
  } });
  await slot.findByText("aa");
  fireEvent.click(slot.getByRole("checkbox", { name: "Viewed src/a.ts" }));
  await waitFor(() => expect(slot.queryByText("aa")).toBeNull());
  press("v");
  await slot.findByText("aa");
  press("V", { shiftKey: true });
  await waitFor(() => expect(slot.queryByText("aa")).toBeNull());
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

// bug bash RDG-2: a chapter opens on its intro with its first file current but not reached (j knows this and goes to
// it first). Next unviewed started after the current file, so from the intro it skipped the chapter's first file.
test("from a chapter's intro, u goes to the chapter's first file when it isn't viewed", async () => {
  const layout = fakeLayout();
  // A chapter long enough to scroll.
  const sizes = { scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"), clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 800 });
  try {
    // Parsing is read; Caching isn't.
    const { slot } = await renderWorkspace({ rpc: { getFileViews: () => ({ views: [{ file: "src/a.ts", viewed: true, stale: false, viewedAt: 1 }] }) } });
    await slot.findByRole("checkbox", { name: "Viewed src/a.ts" });
    await waitFor(() => expect(chapters(slot).getByText("1/3 files viewed")).toBeTruthy());
    // Caching opens on its intro.
    fireEvent.click(chapters(slot).getByText("Caching"));
    await slot.findByText("bb");
    layout.scrollTo(undefined);
    await waitFor(() => expect(currentFile(slot)).toBe("b.ts"));
    press("u");
    await waitFor(() => expect(layout.top()).toBe("src/b.ts"));
    expect(currentFile(slot)).toBe("b.ts");
    // Reached, the file you're on is behind you: u goes on from it.
    press("u");
    await waitFor(() => expect(layout.top()).toBe("src/c.ts"));
    slot.lifecycle.unmount();
  } finally {
    for (const [name, descriptor] of Object.entries(sizes)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as any)[name];
    }
    layout.restore();
  }
}, 15_000);

test("] and [ go through draft comments and discussions in the Comments list's order", async () => {
  const comments = [
    { file: "src/c.ts", line: 1, side: "RIGHT", body: "Third", author: "reviewer" },
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "First", author: "reviewer" },
  ];
  const discussions = [{ file: "src/b.ts", line: 1, side: "RIGHT", waiting: false, undoable: false, entries: [{ author: "reviewer", kind: "message", body: "Second?", createdAt: 1 }] }];
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments }, discussions }),
  } });
  await slot.findByText("aa");
  await openDrafts(slot);
  await slot.findByRole("button", { name: /^Draft · not submitted · src\/a\.ts:1/ });
  // From the file you're on: the comment on a.ts.
  press("]");
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  // Then the list's order: the comments not submitted, in reading order, then the private discussion on b.ts.
  press("]");
  await slot.findByText("cc");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  await waitFor(() => expect(currentFile(slot)).toBe("c.ts"));
  press("]");
  await waitFor(() => expect(currentFile(slot)).toBe("b.ts"));
  press("[");
  await waitFor(() => expect(currentFile(slot)).toBe("c.ts"));
  press("[");
  await slot.findByText("aa");
  press("[");
  // Before the first, the last.
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  await waitFor(() => expect(currentFile(slot)).toBe("b.ts"));
  slot.lifecycle.unmount();
}, 15_000);

test("] and [ skip nits while Hide nits is on", async () => {
  setHideNits(true);
  const comments = [
    { file: "src/a.ts", line: 1, side: "RIGHT", body: "Spacing.", author: "agent", severity: "nit" },
    { file: "src/c.ts", line: 1, side: "RIGHT", body: "Evict it.", author: "reviewer" },
  ];
  // Its discussion hides with the nit.
  const discussions = [{ file: "src/a.ts", line: 1, side: "RIGHT", waiting: false, undoable: false, entries: [{ author: "reviewer", kind: "message", body: "Why?", createdAt: 1 }] }];
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments }, discussions }),
  } });
  await slot.findByText("aa");
  await openDrafts(slot);
  await slot.findByRole("button", { name: /^Draft · not submitted · src\/c\.ts:1/ });
  press("]");
  await slot.findByText("cc");
  press("]");
  expect(currentChapter(slot)?.textContent).toContain("Caching");
  slot.lifecycle.unmount();
}, 15_000);

test("a asks the agent, s opens the draft to submit, and ? lists the shortcuts until Esc", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("a");
  expect(await slot.findByRole("textbox", { name: "Ask the agent" })).toBeTruthy();
  press("s");
  await waitFor(() => expect(finishing(slot)).toBe(true));
  press("?");
  const help = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(within(help).getByText("Next unviewed file, in any chapter")).toBeTruthy();
  fireEvent.keyDown(help, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
  slot.lifecycle.unmount();
}, 15_000);

test("with the agent popped out, Ask agent asks it there, leaving the side panel closed", async () => {
  localStorage.setItem("gr:agentdock:pr-42", JSON.stringify({ mode: "widget", rect: { x: 100, y: 100, w: 400, h: 500 } }));
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  const widget = within(await slot.findByRole("dialog", { name: "Review agent" }));
  await widget.findByRole("textbox", { name: "Ask the agent" });
  press("a");
  // The file you're on is the question's context.
  expect(await widget.findByText("a.ts")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(widget.getByRole("textbox", { name: "Ask the agent" })));
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("keys work as soon as Esc closes the shortcuts, while they fade out", async () => {
  // A browser keeps the help in the page, the focus in it, while it fades out; jsdom has no animations to wait for.
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const style = computed(el, pseudo);
    if (el.getAttribute("role") !== "dialog") return style;
    const fade = () => el.getAttribute("data-state") === "closed" ? "exit" : "enter";
    return new Proxy(style, { get: (target, prop) => prop === "animationName" ? fade() : ((value) => typeof value === "function" ? value.bind(target) : value)(Reflect.get(target, prop)) });
  });
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("?");
  const help = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
  fireEvent.keyDown(help, { key: "Escape" });
  expect(help.isConnected && help.getAttribute("data-state")).toBe("closed");
  // The help hides the rest from screen readers until it's gone: the chapters' own state says whether t hid them.
  const navigator = document.getElementById("gr-navigator-pr-42")!;
  expect(navigator.hidden).toBe(false);
  press("t", {}, document.activeElement!);
  expect(navigator.hidden).toBe(true);
  slot.lifecycle.unmount();
  vi.mocked(window.getComputedStyle).mockRestore();
}, 15_000);

test("with single-key shortcuts off, keys do nothing, but Esc still closes what's over the code", async () => {
  const request = vi.fn(() => Promise.resolve());
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  const off = { preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, singleKeyShortcuts: false } }, revision: 1 };
  const { slot, rpc } = await renderWorkspace({ rpc: { getPreferences: () => off } });
  await slot.findByText("aa");
  for (const key of ["j", "n", "v", "t", "c", "a", "s", "?"]) press(key);
  press("V", { shiftKey: true });
  press("F", { shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  expect(slot.queryByText("bb")).toBeNull();
  expect(slot.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  expect(slot.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  expect(rpc.setFileViewed).not.toHaveBeenCalled();
  expect(rpc.setFilesViewed).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
  delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
  delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  // Too narrow for the chapters to dock: they open over the code, and Esc closes them.
  window.innerWidth = 700;
  const narrow = await renderWorkspace({ rpc: { getPreferences: () => off } });
  await narrow.slot.findByText("aa");
  fireEvent.click(narrow.slot.getByRole("button", { name: "Show chapters" }));
  expect(narrow.slot.getByRole("dialog", { name: "Chapters" })).toBeTruthy();
  press("Escape");
  await waitFor(() => expect(narrow.slot.queryByRole("dialog", { name: "Chapters" })).toBeNull());
  narrow.slot.lifecycle.unmount();
}, 15_000);

test("the band names the chapter with its files viewed as such, and ⇧V marks the chapter viewed", async () => {
  const { slot, rpc } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(chapters(slot).getByText("Caching"));
  const crumbs = within(slot.getByRole("navigation", { name: "Breadcrumb" }));
  await crumbs.findByText("Chapter 2 of 2: Caching, 0 of 2 files viewed");
  press("V", { shiftKey: true });
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  expect(await crumbs.findByText("Chapter 2 of 2: Caching, 2 of 2 files viewed")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a failed re-review offers Try again, and an account without access offers the account switcher", async () => {
  const rereview = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ review: { status: "error" }, rpc: {
    rereview,
    checkRepoAccess: () => ({ accessible: false, repo: "acme/web", account: "me" }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }, { login: "work", active: false }] }),
  } });
  const failed = await slot.findByRole("alert");
  expect(failed.textContent).toContain("Couldn’t update the guide. Showing the previous one.");
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rereview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  // The first notice shows, and the rest under it.
  fireEvent.click(slot.getByRole("button", { name: "1 more notice" }));
  await slot.findByText(/can’t access acme\/web/);
  expect(slot.getByRole("button", { name: "GitHub account: @me" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("a local review's Comments has no Feedback or Threads, and the agent goes by one name", async () => {
  const { slot } = await renderWorkspace({ review: { kind: "ref", targetKey: "pr-42" } });
  await slot.findByText("aa");
  await openDrafts(slot);
  const panel = within(slot.getByRole("complementary", { name: "Comments and agent" }));
  expect(panel.getByRole("region", { name: "Comments" })).toBeTruthy();
  expect(panel.getByText("Comments on a local review stay in BB.")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Threads" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Feedback" })).toBeNull();
  expect(slot.queryByRole("button", { name: /assistant/i })).toBeNull();
  expect(slot.getAllByRole("button", { name: "Ask agent" }).length).toBeGreaterThan(0);
  slot.lifecycle.unmount();
}, 15_000);

// bug bash RDG-7: a local review has no PR, so a place in a file it no longer changes isn't "changed in this PR".
test("a local review says a file outside every chapter isn't in this diff anymore", async () => {
  patchReviewState("pr-42", { activeId: "overview" });
  const { slot } = await renderWorkspace({ review: { kind: "ref", targetKey: "pr-42" }, bundle: { guide: { ...guide, hotspots: [{ file: "src/gone.ts", line: 2, why: "Never closed." }] } } });
  fireEvent.click(within(await slot.findByRole("region", { name: "Start here" })).getByRole("button", { name: "src/gone.ts:2" }));
  expect(toast.info).toHaveBeenCalledWith("src/gone.ts isn’t in this diff anymore.", undefined);
  slot.lifecycle.unmount();
}, 15_000);

test("t shows and hides the chapters, c Comments, and i folds comments in code, a choice kept for every review", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  press("t");
  expect(slot.queryByRole("navigation", { name: "Chapters" })).toBeNull();
  press("t");
  expect(slot.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  press("c");
  expect(slot.getByRole("complementary", { name: "Comments and agent" })).toBeTruthy();
  expect(slot.getByRole("region", { name: "Comments" })).toBeTruthy();
  press("c");
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  // Unfolded where there's room, until you say otherwise.
  expect(getCommentsFolded()).toBeUndefined();
  press("i");
  expect(getCommentsFolded()).toBe(true);
  press("i");
  expect(getCommentsFolded()).toBe(false);
  slot.lifecycle.unmount();
}, 15_000);

test("⇧V marks the chapter's files viewed, and the toast's Undo puts each back as it was in one call, changed since you viewed it included", async () => {
  // The diff each file was viewed at: src/c.ts at today's, src/b.ts at an older one.
  const stored = new Map([["src/b.ts", "old"], ["src/c.ts", "now"]]);
  type View = { file: string; hash: string; viewedAt: number };
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getFileViews: vi.fn(() => ({ views: [...stored].map(([file, hash]) => ({ file, viewed: hash === "now", stale: hash !== "now" })) })),
    setFilesViewed: vi.fn(({ files, viewed = true, previous = [] }: { files: string[]; viewed?: boolean; previous?: View[] }) => {
      if (!viewed) {
        for (const file of files) { const view = previous.find((p) => p.file === file); if (view) stored.set(file, view.hash); else stored.delete(file); }
        return { ok: true };
      }
      const replaced = files.filter((file) => stored.has(file)).map((file) => ({ file, hash: stored.get(file)!, viewedAt: 1 }));
      files.forEach((file) => stored.set(file, "now"));
      return { ok: true, previous: replaced };
    }),
  } });
  await slot.findByText("aa");
  fireEvent.click(chapters(slot).getByText("Caching"));
  await waitFor(() => expect(currentChapter(slot)?.textContent).toContain("Caching"));
  const changed = () => within(slot.container.querySelector<HTMLElement>('[data-file="src/b.ts"]')!).queryByText("Changed since you viewed it");
  await waitFor(() => expect(changed()).toBeTruthy());
  press("V", { shiftKey: true });
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts"] });
  const box = slot.getByRole("checkbox", { name: "Viewed src/b.ts" }) as HTMLInputElement;
  await waitFor(() => expect(box.checked).toBe(true));
  expect(changed()).toBeNull();
  const [message, options] = vi.mocked(toast.success).mock.calls.at(-1)!;
  expect(message).toBe("Marked 1 file viewed");
  const undo = (options as { action: { label: string; onClick: () => void } }).action;
  expect(undo.label).toBe("Undo");
  act(() => undo.onClick());
  expect(box.checked).toBe(false);
  expect(changed()).toBeTruthy();
  // src/b.ts gets back the older diff it was viewed at; src/c.ts, viewed before, isn't touched.
  await waitFor(() => expect(rpc.setFilesViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", files: ["src/b.ts"], viewed: false, previous: [{ file: "src/b.ts", hash: "old", viewedAt: 1 }] }));
  expect(rpc.setFileViewed).not.toHaveBeenCalled();
  await waitFor(() => expect(stored).toEqual(new Map([["src/b.ts", "old"], ["src/c.ts", "now"]])));
  // And the views read back after it agree.
  await waitFor(() => expect(rpc.getFileViews.mock.invocationCallOrder.at(-1)).toBeGreaterThan(rpc.setFilesViewed.mock.invocationCallOrder.at(-1)!));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(changed()).toBeTruthy();
  expect(box.checked).toBe(false);
  // On the Overview there's no chapter to mark.
  press("p");
  press("p");
  press("V", { shiftKey: true });
  expect(rpc.setFilesViewed).toHaveBeenCalledTimes(2);
  slot.lifecycle.unmount();
}, 15_000);

test("j and k take the focus with them, to the file's toggle", async () => {
  const layout = fakeLayout();
  patchReviewState("pr-42", { activeId: "c2" });
  const { slot } = await renderWorkspace();
  await slot.findByText("bb");
  press("j");
  press("j");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Collapse src/c.ts");
  // The next key still works from there.
  press("k", {}, document.activeElement!);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Collapse src/b.ts");
  slot.lifecycle.unmount();
  layout.restore();
}, 15_000);

test("] takes the focus to where it lands", async () => {
  const layout = fakeLayout();
  const comments = [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "First", author: "reviewer" }];
  const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments } }) } });
  await slot.findByText("aa");
  await openDrafts(slot);
  await slot.findByRole("button", { name: /^Draft · not submitted · src\/a\.ts:1/ });
  press("]");
  // The code here draws no cards: it lands on the file.
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Collapse src/a.ts"), { timeout: 4000 });
  slot.lifecycle.unmount();
  layout.restore();
}, 15_000);

test("the chapters' Skip to code takes the focus to the code, whose keys then scroll it", async () => {
  const { slot } = await renderWorkspace();
  await slot.findByText("aa");
  fireEvent.click(chapters(slot).getByRole("button", { name: "Skip to code" }));
  expect(document.activeElement).toBe(scroller(slot));
  slot.lifecycle.unmount();
}, 15_000);
