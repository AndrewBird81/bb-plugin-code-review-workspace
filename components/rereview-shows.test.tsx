// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import { getReviewState, patchReviewState } from "../lib/panel-state";
import { keep } from "../lib/remount";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre data-testid="filediff">{fileDiff.additionLines.join("\n")}</pre> }));
// Opening a file's chapter scrolls to it a frame later.
Element.prototype.scrollIntoView = () => {};

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); restores.splice(0).forEach((restore) => restore()); });

const file = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+${line}\n`;
const at = (lines: Record<string, string>) => Object.entries(lines).map(([path, line]) => file(`src/${path}.ts`, line)).join("");
const patch = at({ a: "aa", b: "bb", c: "cc", d: "dd", e: "ee" });
// Since your review, a.ts and e.ts changed: Caching has nothing new. Since the PR's commit c2bbbbb, only b.ts did.
const reviewed = at({ a: "a0", b: "bb", c: "cc", d: "dd", e: "e0" });
const atCommit = at({ a: "aa", b: "b1", c: "cc", d: "dd", e: "ee" });
const guide = {
  title: "Guide", intent: "Rows.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
    { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/c.ts" }, { file: "src/d.ts" }] },
    { id: "c3", title: "Logging", overview: "Logs rows.", diffs: [{ file: "src/e.ts" }] },
  ],
};
const comment = (file: string) => ({ file, line: 1, side: "RIGHT", body: `Why ${file}?`, author: "reviewer" });

/**
 * A re-review: you reviewed "old", the diff is at "new" (`now`, `then` at your review). Settings' re-review choice is
 * `shows`. With `building`, its guide is still being built, until `build()`.
 */
async function renderWorkspace({ rpc = {}, opened = true, shows = "since", now = patch, then = reviewed, building = false }: { rpc?: Record<string, unknown>; opened?: boolean; shows?: "since" | "all"; now?: string; then?: string; building?: boolean } = {}) {
  // Opened before, on its first chapter, unless `opened` is false: a first open shows the Overview.
  if (opened && !getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const pr = { headSha: "new", revision: "r1", built: !building };
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: pr.built ? "ready" : "generating", createdAt: 1, title: "Parse rows", headSha: pr.headSha, signals: { lastReviewSha: "old" }, submittedVerdict: "COMMENT" }, guide: pr.built ? structuredClone(guide) : null, patch: now, revision: pr.revision }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, rereviewShows: shows }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    setFilesViewed: vi.fn(() => ({ ok: true })),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [comment("src/a.ts"), comment("src/b.ts")] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
    getPrCommits: () => ({ commits: [{ sha: "c2bbbbb", headline: "Cache rows", committedAt: Date.now() - 86_400_000 }] }),
    getSinceReview: vi.fn(({ from }: { from?: string }): unknown => ({ baseline: { sha: from ?? "old", at: from ? null : 1, verdict: from ? null : "COMMENT" }, files: interdiff(from ? atCommit : then, now) })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  if (pr.built) await slot.findByRole("main", { name: "Review" });
  else await slot.findByRole("status", { name: "Building the guide" });
  /** The author pushes, and the review is rebuilt on the new head. */
  const push = async () => { Object.assign(pr, { headSha: "newer", revision: "r2" }); await slot.emitRealtime("review:pr-42", {}); };
  /** The guide is built. */
  const build = async () => { pr.built = true; await slot.emitRealtime("review:pr-42", {}); };
  return { slot, rpc: handlers, push, build };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
/** The chapter's files the diff shows. */
const shown = (slot: Slot) => Array.from(slot.getByRole("main").querySelectorAll<HTMLElement>("[data-file]")).map((el) => el.dataset.file);
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
/** The band's compare select, as it names what the diff shows. */
const select = (slot: Slot) => slot.getByRole("button", { name: /^Show changes: / }).getAttribute("aria-label");
/** One of the switch's two choices above the chapter's files. */
const choice = (slot: Slot, name: string | RegExp) => within(slot.getByRole("radiogroup", { name: "Changes shown" })).getByRole("radio", { name });
const checked = (slot: Slot, name: string | RegExp) => choice(slot, name).getAttribute("aria-checked") === "true";
const openDrafts = async (slot: Slot) => fireEvent.click(await slot.findByRole("button", { name: "Comments" }));

test("a re-review opens on what changed since your review, however you go in: Review changes, a chapter, Continue, or a comment", async () => {
  const { slot } = await renderWorkspace({ opened: false });
  // Review changes goes to the first chapter that changed.
  fireEvent.click(await slot.findByRole("button", { name: "Review changes: Parsing" }));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  expect(select(slot)).toBe("Show changes: Since your review");
  expect(checked(slot, "Since your review · 1 of 2 files")).toBe(true);
  fireEvent.click(chapters(slot).getByText("Logging"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/e.ts"]));
  fireEvent.click(within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Parse rows" }));
  fireEvent.click(await slot.findByRole("button", { name: "Continue: Logging" }));
  await waitFor(() => expect(shown(slot)).toEqual(["src/e.ts"]));
  // A comment on a file that changed shows there, still narrowed.
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: /^Draft · not submitted · src\/a\.ts:1/ }));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  expect(select(slot)).toBe("Show changes: Since your review");
  slot.lifecycle.unmount();
}, 15_000);

test("with Settings on All changes, a re-review opens on all of it: Review changes only goes to the first chapter that changed", async () => {
  const { slot } = await renderWorkspace({ opened: false, shows: "all" });
  fireEvent.click(await slot.findByRole("button", { name: "Review changes: Parsing" }));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(select(slot)).toBe("Show changes: All changes");
  // The switch is there to narrow it.
  expect(checked(slot, "All changes")).toBe(true);
  fireEvent.click(choice(slot, "Since your review · 1 of 2 files"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("only leaving the narrowing holds the review at All changes: opening a file under Settings' All changes leaves the review to Settings", async () => {
  let shows = "all";
  const { slot } = await renderWorkspace({ rpc: { getPreferences: () => ({ preferences: { ...defaultPreferences, rereviewShows: shows }, revision: 0 }) } });
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  fireEvent.click(chapters(slot).getByText("b.ts"));
  shows = "since";
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("the switch sits in the chapter's intro card, not in a block of its own over the files", async () => {
  const { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const intro = within(slot.getByRole("main")).getByRole("region", { name: "Parsing" });
  expect(within(intro).getByRole("radiogroup", { name: "Changes shown" })).toBeTruthy();
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(within(intro).getByRole("radio", { name: "All changes" }).getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
}, 15_000);

test("the switch is read where a narrow card draws it: after the title and the overview's toggle, before the overview", async () => {
  const { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const intro = within(slot.getByRole("main")).getByRole("region", { name: "Parsing" });
  const toggle = within(intro).getByRole("button", { name: "Hide chapter overview" });
  const group = within(intro).getByRole("radiogroup", { name: "Changes shown" });
  const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(toggle, group)).toBe(true);
  expect(follows(group, within(intro).getByText("Reads rows."))).toBe(true);
  // Nothing in the card is drawn out of its DOM order.
  expect(intro.querySelector("[class*='order-']")).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("beside the switch, the chapter's facts keep to one line, cut short at the end, and their title has them whole", async () => {
  const { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const intro = within(slot.getByRole("main")).getByRole("region", { name: "Parsing" });
  const facts = within(intro).getByText("Chapter 1 of 3").parentElement!;
  expect(facts.className).toContain("@min-[494px]/intro:group-has-[[role=radiogroup]]/intro:truncate");
  expect(intro.className).toContain("group/intro");
  expect(facts.title).toBe("Chapter 1 of 3 · 2 files · 4 lines · 0 of 2 viewed");
  slot.lifecycle.unmount();
}, 15_000);

test("the intro's columns are spaced by margins, so an empty switch slot costs the facts no width", async () => {
  const { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const intro = within(slot.getByRole("main")).getByRole("region", { name: "Parsing" });
  // A grid keeps its gaps around an empty track: none, and a margin before the toggle, and before the switch beside it.
  expect(intro.className).toContain("gap-x-0");
  expect(within(intro).getByRole("button", { name: "Hide chapter overview" }).className).toContain("ml-2");
  expect(within(intro).getByRole("radiogroup", { name: "Changes shown" }).parentElement!.parentElement!.className).toContain("@min-[494px]/intro:ml-2");
  slot.lifecycle.unmount();
}, 15_000);

test("in a card under 340px the switch's segments pad less, so BB's larger phone text fits a folded Duo's", async () => {
  const { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const group = within(slot.getByRole("main")).getByRole("radiogroup", { name: "Changes shown" });
  expect(group.parentElement!.parentElement!.className).toContain("@max-[340px]/intro:[&_[role=radio]]:px-1.5");
  // Its labels stay whole.
  expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Since your review · 1 of 2 files", "All changes"]);
  slot.lifecycle.unmount();
}, 15_000);

test("narrowed, the chapters list marks the first file the diff shows, not the chapter's first file it hides", async () => {
  // Since your review, b.ts changed and a.ts didn't.
  const { slot } = await renderWorkspace({ then: at({ a: "aa", b: "b0", c: "cc", d: "dd", e: "e0" }) });
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  const current = () => chapters(slot).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "true").map((button) => button.title);
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

// No layout in jsdom: the chapter's files sit below its intro, in order, 1000px each, as far up as the code is scrolled.
function fakeLayout() {
  const measure = Element.prototype.getBoundingClientRect;
  restores.push(() => { Element.prototype.getBoundingClientRect = measure; });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const i = Array.from(document.querySelectorAll("[data-file]")).indexOf(this);
    const scrolled = this.closest<HTMLElement>(".overflow-y-auto")?.scrollTop ?? 0;
    return i < 0 ? new DOMRect() : new DOMRect(0, 500 + i * 1000 - scrolled, 0, 1000);
  };
}
/** Since your review, b.ts changed and a.ts didn't: narrowed, chapter 1 shows b.ts alone. */
async function narrowedToB() {
  fakeLayout();
  const { slot } = await renderWorkspace({ then: at({ a: "aa", b: "b0", c: "cc", d: "dd", e: "e0" }) });
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  const current = () => chapters(slot).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "true").map((button) => button.title);
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  const code = slot.getByRole("main", { name: "Review" }).querySelector<HTMLElement>(":scope > .overflow-y-auto")!;
  /** Your own scroll to `top`. */
  const scroll = (top: number) => { code.scrollTop = top; fireEvent.wheel(code); fireEvent.scroll(code); };
  return { slot, current, scroll, code };
}
/** A choice in the band's compare select, which shows wherever you are in the code. */
async function pick(slot: Slot, name: string | RegExp) {
  fireEvent.click(slot.getByRole("button", { name: /^Show changes: / }));
  fireEvent.click(await slot.findByRole("menuitemradio", { name }));
}

test("flipped to All changes on a chapter's intro, j and k step from the file at the top, not the one narrowed to", async () => {
  const { slot, current } = await narrowedToB();
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  await waitFor(() => expect(current()).toEqual(["src/a.ts"]));
  fireEvent.keyDown(document.body, { key: "j" });
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  fireEvent.keyDown(document.body, { key: "k" });
  await waitFor(() => expect(current()).toEqual(["src/a.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("flipped to All changes partway into the file narrowed to, the code keeps your place: that file stays current, and k goes to the one above", async () => {
  const { slot, current, scroll, code } = await narrowedToB();
  scroll(800);
  await pick(slot, "All changes in this PR");
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  // b.ts's top stays 300px above the code's, a.ts's 1000px above it.
  expect(code.scrollTop).toBe(1800);
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  fireEvent.keyDown(document.body, { key: "k" });
  await waitFor(() => expect(current()).toEqual(["src/a.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("flipped to Since your review partway into a file it shows, the code keeps your place; on the intro it stays put", async () => {
  const { slot, current, scroll, code } = await narrowedToB();
  await pick(slot, "All changes in this PR");
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(code.scrollTop).toBe(0);
  scroll(1800);
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  await pick(slot, /^Since your review/);
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  // b.ts's top stays 300px above the code's, with a.ts gone from above it.
  expect(code.scrollTop).toBe(800);
  expect(current()).toEqual(["src/b.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

test("flipped to Since your review from partway into a file it hides, the next file it shows comes to the top, current", async () => {
  const { slot, current, scroll, code } = await narrowedToB();
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  scroll(800);
  await waitFor(() => expect(current()).toEqual(["src/a.ts"]));
  await pick(slot, /^Since your review/);
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  // b.ts's top at the code's.
  expect(code.scrollTop).toBe(500);
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  fireEvent.keyDown(document.body, { key: "k" });
  await waitFor(() => expect(current()).toEqual(["src/b.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("a file the narrowing hides, picked in the chapters list, is gone to once All changes shows it, and is current", async () => {
  const { slot, current, scroll, code } = await narrowedToB();
  scroll(800);
  fireEvent.click(chapters(slot).getByText("a.ts"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  // a.ts's top at the code's.
  await waitFor(() => expect(code.scrollTop).toBe(500));
  expect(current()).toEqual(["src/a.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

test("a diff that didn't change since your review, as after a rebase, opens on all of it", async () => {
  const { slot } = await renderWorkspace({ rpc: { getSinceReview: () => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(patch, patch) }) } });
  await waitFor(() => expect(checked(slot, "All changes")).toBe(true));
  expect(choice(slot, "Since your review · 0 of 2 files")).toBeTruthy();
  expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

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

/** A browser that can make an element full screen. */
function fakeFullscreen() {
  let element: Element | null = null;
  const change = (next: Element | null) => { element = next; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve(); };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: () => change(null) });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value(this: HTMLElement) { return change(this); } });
  restores.push(() => {
    for (const key of ["fullscreenEnabled", "exitFullscreen"]) delete (document as unknown as Record<string, unknown>)[key];
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });
}

test("the switch above a chapter's files flips between Since your review and All changes in one tap, beside the band's select, on a phone, held sideways, and in full screen", async () => {
  // A desktop's pane, the band's select there too.
  let { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(select(slot)).toBe("Show changes: All changes");
  // It keeps its count, and says what it would show.
  fireEvent.click(choice(slot, "Since your review · 1 of 2 files"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  expect(select(slot)).toBe("Show changes: Since your review");
  slot.lifecycle.unmount();
  localStorage.clear();
  for (const [width, height] of [[390, 844], [844, 390]]) {
    fakeScreen(width, height, false);
    ({ slot } = await renderWorkspace());
    await waitFor(() => expect(checked(slot, "Since your review · 1 of 2 files")).toBe(true));
    // 44px targets on touch, around 36px buttons.
    expect(choice(slot, "All changes").className).toContain("pointer-coarse:after:-inset-1");
    fireEvent.click(choice(slot, "All changes"));
    await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
    slot.lifecycle.unmount();
    localStorage.clear();
    restores.splice(0).forEach((restore) => restore());
  }
  fakeFullscreen();
  ({ slot } = await renderWorkspace());
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  await waitFor(() => expect(document.fullscreenElement).toBeTruthy());
  expect(document.fullscreenElement!.contains(slot.getByRole("radiogroup", { name: "Changes shown" }))).toBe(true);
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  slot.lifecycle.unmount();
}, 20_000);

test("a commit picked in the compare select names itself in the switch, and All changes there lets it go", async () => {
  const { slot, rpc } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(slot.getByRole("button", { name: /^Show changes: / }));
  fireEvent.click(await within(await slot.findByRole("menu", { name: "Show changes" })).findByText("Cache rows"));
  await waitFor(() => expect(checked(slot, "Since c2bbbbb · 1 of 2 files")).toBe(true));
  expect(shown(slot)).toEqual(["src/b.ts"]);
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(select(slot)).toBe("Show changes: All changes"));
  expect(rpc.getSinceReview).toHaveBeenLastCalledWith({ targetKey: "pr-42" });
  await waitFor(() => expect(choice(slot, "Since your review · 1 of 2 files")).toBeTruthy());
  slot.lifecycle.unmount();
}, 15_000);

test("your switch holds for the review across chapters and coming back, until a push: then Settings' choice, once the new comparison arrives", async () => {
  let { slot, rpc, push } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(choice(slot, "All changes"));
  fireEvent.click(chapters(slot).getByText("Caching"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/c.ts", "src/d.ts"]));
  // Coming back, as BB's remount at 768px does too.
  slot.lifecycle.unmount();
  ({ slot, rpc, push } = await renderWorkspace());
  await waitFor(() => expect(select(slot)).toBe("Show changes: All changes"));
  expect(shown(slot)).toEqual(["src/c.ts", "src/d.ts"]);
  let answer!: () => void;
  rpc.getSinceReview.mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }); }));
  await push();
  await waitFor(() => expect(rpc.getSinceReview).toHaveBeenCalledTimes(2));
  expect(shown(slot)).toEqual(["src/c.ts", "src/d.ts"]);
  answer();
  await waitFor(() => expect(select(slot)).toBe("Show changes: Since your review"));
  expect(shown(slot)).toEqual([]);
  slot.lifecycle.unmount();
}, 15_000);

test("a commit you picked is remembered too, until a push", async () => {
  let { slot, rpc, push } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(slot.getByRole("button", { name: /^Show changes: / }));
  fireEvent.click(await within(await slot.findByRole("menu", { name: "Show changes" })).findByText("Cache rows"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  slot.lifecycle.unmount();
  ({ slot, rpc, push } = await renderWorkspace());
  await waitFor(() => expect(checked(slot, "Since c2bbbbb · 1 of 2 files")).toBe(true));
  expect(rpc.getSinceReview).toHaveBeenCalledWith({ targetKey: "pr-42", from: "c2bbbbb" });
  await push();
  await waitFor(() => expect(select(slot)).toBe("Show changes: Since your review"));
  expect(shown(slot)).toEqual(["src/a.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

test("where you were in the chapter comes back once the comparison it was under arrives", async () => {
  patchReviewState("pr-42", { activeId: "c1", scrollTop: 300, compare: { head: "new", from: null, narrowed: false } });
  let answer!: () => void;
  const { slot } = await renderWorkspace({ rpc: {
    getSinceReview: () => new Promise((resolve) => { answer = () => resolve({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }); }),
  } });
  await slot.findAllByTestId("filediff");
  const code = slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(code.scrollTop).toBe(0);
  answer();
  await waitFor(() => expect(code.scrollTop).toBe(300));
  expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

test("a file the narrowing hides, opened from the chapters, a Find result, or a comment, shows all changes, and that holds", async () => {
  let { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(chapters(slot).getByText("b.ts"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(select(slot)).toBe("Show changes: All changes");
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace());
  await waitFor(() => expect(select(slot)).toBe("Show changes: All changes"));
  fireEvent.click(choice(slot, "Since your review · 1 of 2 files"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.change(slot.getByRole("searchbox", { name: "Find in review" }), { target: { value: "bb" } });
  const results = within(await slot.findByRole("list", { name: "Results" }));
  fireEvent.click(results.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "src/b.ts:1").closest("button")!);
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  fireEvent.click(choice(slot, "Since your review · 1 of 2 files"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: /^Draft · not submitted · src\/b\.ts:1/ }));
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  expect(select(slot)).toBe("Show changes: All changes");
  slot.lifecycle.unmount();
}, 20_000);

test("a chapter with nothing changed since your review says so plainly, All changes a tap above; its end goes on, still narrowed", async () => {
  const { slot, rpc } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const main = within(slot.getByRole("main"));
  fireEvent.click(main.getByRole("button", { name: "Next: Caching" }));
  expect(await main.findByText("Nothing changed in this chapter since your review.")).toBeTruthy();
  expect(checked(slot, "Since your review · 0 of 2 files")).toBe(true);
  fireEvent.click(choice(slot, "All changes"));
  await waitFor(() => expect(shown(slot)).toEqual(["src/c.ts", "src/d.ts"]));
  fireEvent.click(choice(slot, "Since your review · 0 of 2 files"));
  await main.findByText("Nothing changed in this chapter since your review.");
  fireEvent.click(main.getByRole("button", { name: "Mark viewed and continue" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/c.ts", "src/d.ts"] });
  await waitFor(() => expect(shown(slot)).toEqual(["src/e.ts"]));
  expect(checked(slot, "Since your review · 1 of 1 file")).toBe(true);
  slot.lifecycle.unmount();
}, 15_000);

/** The review opened where it was left, scrolled to 300 in Parsing, its comparison held until `answer()`. */
async function reopenedWaiting(rpc: Record<string, unknown> = {}) {
  patchReviewState("pr-42", { activeId: "c1", scrollTop: 300 });
  let answer!: () => void;
  const opened = await renderWorkspace({ rpc: {
    getSinceReview: () => new Promise((resolve) => { answer = () => resolve({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }); }),
    ...rpc,
  } });
  await opened.slot.findAllByTestId("filediff");
  const code = opened.slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  return { ...opened, code, answer: () => answer() };
}

test("while the comparison loads, another chapter, or your own scroll, drops going back to where you were", async () => {
  let { slot, code, answer } = await reopenedWaiting();
  fireEvent.click(chapters(slot).getByText("Logging"));
  await waitFor(() => expect(within(slot.getByRole("main")).getByRole("region", { name: "Logging" })).toBeTruthy());
  answer();
  await waitFor(() => expect(shown(slot)).toEqual(["src/e.ts"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(code.scrollTop).toBe(0);
  slot.lifecycle.unmount();
  ({ slot, code, answer } = await reopenedWaiting());
  fireEvent.wheel(code);
  answer();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(code.scrollTop).toBe(0);
  slot.lifecycle.unmount();
}, 15_000);

test("a guide built while the comparison loads waits for it too, and your own scroll meanwhile drops going back to where you were", async () => {
  patchReviewState("pr-42", { activeId: "c1", scrollTop: 300 });
  let answer: (() => void) | undefined;
  const { slot, build } = await renderWorkspace({ building: true, rpc: {
    getSinceReview: () => new Promise((resolve) => { answer = () => resolve({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }); }),
  } });
  await waitFor(() => expect(answer).toBeDefined());
  await build();
  await slot.findAllByTestId("filediff");
  const code = slot.getByRole("main").querySelector<HTMLElement>(".overflow-y-auto")!;
  fireEvent.wheel(code);
  answer!();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(code.scrollTop).toBe(0);
  slot.lifecycle.unmount();
}, 15_000);

test("as BB remounts the page, the line it carries stays the place while the comparison loads: what's at the top meanwhile isn't kept", async () => {
  let { slot } = await renderWorkspace();
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  const place = { file: "src/a.ts", index: "1,1", offset: 12 };
  keep("pr-42", { place });
  slot.lifecycle.unmount();
  const reopened = await reopenedWaiting();
  fireEvent.scroll(reopened.code);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(JSON.parse(sessionStorage.getItem("gr:remount")!)["pr-42"].place).toEqual(place);
  reopened.slot.lifecycle.unmount();
}, 15_000);

test("a comment on a line that didn't change since your review, in a file that did, shows all changes, so it lands on its line", async () => {
  const twoHunks = (first: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+${first}\n@@ -20 +20 @@\n-y\n+yy\n`;
  const now = twoHunks("aa") + at({ b: "bb", c: "cc", d: "dd", e: "ee" });
  const { slot } = await renderWorkspace({ now, then: twoHunks("a0") + at({ b: "bb", c: "cc", d: "dd", e: "e0" }), rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [{ ...comment("src/a.ts"), line: 20 }] } }),
  } });
  // Since your review, a.ts shows only its first hunk.
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  expect(slot.getByTestId("filediff").textContent).not.toContain("yy");
  await openDrafts(slot);
  fireEvent.click(await slot.findByRole("button", { name: /^Draft · not submitted · src\/a\.ts:20/ }));
  await waitFor(() => expect(select(slot)).toBe("Show changes: All changes"));
  expect(slot.getAllByTestId("filediff")[0].textContent).toContain("yy");
  slot.lifecycle.unmount();
}, 15_000);

test("a commit picked never shows with the comparison it replaces, not even for a render", async () => {
  let answer!: () => void;
  const { slot } = await renderWorkspace({ rpc: {
    getSinceReview: vi.fn(({ from }: { from?: string }) => from
      ? new Promise((resolve) => { answer = () => resolve({ baseline: { sha: from, at: null, verdict: null }, files: interdiff(atCommit, patch) }); })
      : { baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(reviewed, patch) }),
  } });
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  fireEvent.click(slot.getByRole("button", { name: /^Show changes: / }));
  const pick = await within(await slot.findByRole("menu", { name: "Show changes" })).findByText("Cache rows");
  // Every text the code's column showed meanwhile.
  const texts: string[] = [];
  const note = (records: MutationRecord[]) => records.forEach((record) => texts.push(record.target.textContent ?? "", ...Array.from(record.addedNodes, (node) => node.textContent ?? "")));
  const seen = new MutationObserver(note);
  seen.observe(slot.getByRole("main"), { subtree: true, childList: true, characterData: true });
  fireEvent.click(pick);
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  note(seen.takeRecords());
  seen.disconnect();
  // Until its own comparison arrives, nothing says "Since c2bbbbb": the files your review's comparison picked never
  // show under the commit's name.
  expect(texts.some((text) => text.includes("Since c2bbbbb"))).toBe(false);
  answer();
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("a comparison that failed stops saying so once it arrives: a commit picked, then your review again", async () => {
  let failing = true;
  const { slot } = await renderWorkspace({ rpc: {
    getSinceReview: vi.fn(({ from }: { from?: string }) => {
      if (!from && failing) { failing = false; return { baseline: null, files: [], error: "timed out" }; }
      return { baseline: { sha: from ?? "old", at: from ? null : 1, verdict: from ? null : "COMMENT" }, files: interdiff(from ? atCommit : reviewed, patch) };
    }),
  } });
  await waitFor(() => expect(select(slot)).toBe("Show changes: All changes. Couldn’t compare with your last review: timed out"));
  const pick = async (name: string) => {
    fireEvent.click(slot.getByRole("button", { name: /^Show changes: / }));
    fireEvent.click(await within(await slot.findByRole("menu", { name: "Show changes" })).findByText(name));
  };
  await pick("Cache rows");
  await waitFor(() => expect(shown(slot)).toEqual(["src/b.ts"]));
  await pick("Since your review");
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  expect(select(slot)).toBe("Show changes: Since your review");
  slot.lifecycle.unmount();
}, 15_000);

test("a line from Find under Settings' All changes leaves the review to Settings: nothing was narrowed to let go", async () => {
  let shows = "all";
  const { slot } = await renderWorkspace({ rpc: { getPreferences: () => ({ preferences: { ...defaultPreferences, rereviewShows: shows }, revision: 0 }) } });
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts", "src/b.ts"]));
  fireEvent.change(slot.getByRole("searchbox", { name: "Find in review" }), { target: { value: "aa" } });
  const results = within(await slot.findByRole("list", { name: "Results" }));
  fireEvent.click(results.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "src/a.ts:1").closest("button")!);
  shows = "since";
  await slot.emitRealtime("preferences", {});
  await waitFor(() => expect(shown(slot)).toEqual(["src/a.ts"]));
  slot.lifecycle.unmount();
}, 15_000);

test("without Settings to read, a re-review opens on Settings' default, and back where you were", async () => {
  const { slot, code, answer } = await reopenedWaiting({ getPreferences: () => { throw new Error("offline"); } });
  answer();
  await waitFor(() => expect(code.scrollTop).toBe(300));
  expect(shown(slot)).toEqual(["src/a.ts"]);
  slot.lifecycle.unmount();
}, 15_000);

test("the diff narrowing by itself as the comparison arrives says so to screen readers", async () => {
  const { slot, answer } = await reopenedWaiting();
  const status = slot.getAllByRole("status").find((el) => el.classList.contains("sr-only"))!;
  expect(status.textContent).toBe("");
  answer();
  await waitFor(() => expect(status.textContent).toBe("Showing changes since your review · 1 of 2 files"));
  slot.lifecycle.unmount();
}, 15_000);
