// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { searchIndex, searchReview } from "../lib/review-search";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Like pierre, each file's rows are in a diffs-container's shadow root; its text shows outside for the tests.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: any) => createElement("div", null,
    createElement("diffs-container", {
      ref: (el: HTMLElement | null) => {
        if (!el || el.shadowRoot) return;
        el.attachShadow({ mode: "open" }).innerHTML = fileDiff.additionLines.map((_: string, i: number) => `<div data-line-type="change-addition" data-line="${i + 1}"></div>`).join("");
      },
    }),
    createElement("pre", null, fileDiff.additionLines.join("\n"))),
}));
customElements.define("diffs-container", class extends HTMLElement {});

const rects = Element.prototype.getClientRects;
const animate = (Element.prototype as Partial<Element>).animate;
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.getClientRects = rects;
  (Element.prototype as Partial<Element>).animate = animate;
});

const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = [
  file("src/a.ts", "@@ -1,2 +1,2 @@\n keep\n-const retries = 3;\n+const retries = 5;\n"),
  file("src/cache/b.ts", "@@ -1 +1,3 @@\n-evict()\n+evictOldest()\n+const ttl = retries * 2;\n+flush()\n"),
].join("");
const guide = {
  title: "Guide", intent: "Retries.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Retry `policy`", overview: "Raises the retries.", diffs: [{ file: "src/a.ts", summary: "Five retries." }] },
    { id: "c2", title: "Caching", overview: "Evicts the oldest.", diffs: [{ file: "src/cache/b.ts", summary: "Derives the TTL from retries." }] },
  ],
};

test("the index holds both sides of the diff, in the guide's order, and the guide's text", () => {
  const index = searchIndex(patch, [...guide.sections].reverse());
  const { hits, total } = searchReview(index, "RETRIES");
  expect(total).toBe(6);
  expect(hits.map((hit) => hit.kind === "line" ? `${hit.file}:${hit.line}:${hit.side}` : `${hit.kind}:${hit.chapterId}`)).toEqual([
    // The guide first, chapter by chapter: its title and overview, then its files' summaries.
    "summary:c2", "chapter:c1", "summary:c1",
    // Then the lines, in the guide's file order: the removed and the added line of a change both match.
    "src/cache/b.ts:2:RIGHT", "src/a.ts:2:LEFT", "src/a.ts:2:RIGHT",
  ]);
  expect(searchReview(index, "  ")).toEqual({ hits: [], total: 0 });
  expect(searchReview(index, "retries", 2)).toMatchObject({ total: 6, hits: [{}, {}] });
});

test("search ignores accents, and a hit's place is its place in the text", () => {
  const index = searchIndex(file("docs/café.md", "@@ -0,0 +1 @@\n+Le Café Crème\n"), [{ id: "c1", title: "Menu", overview: "", diffs: [{ file: "docs/café.md" }] }]);
  expect(searchReview(index, "creme")).toMatchObject({ total: 1, hits: [{ kind: "line", text: "Le Café Crème", at: 8 }] });
  expect(searchReview(index, "CAFÉ CR")).toMatchObject({ total: 1, hits: [{ at: 3 }] });
});

test("searching a 30,000-line patch stays fast", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `+const value${i} = compute(${i}); // line ${i}`).join("\n");
  const big = Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`, `@@ -0,0 +1,100 @@\n${lines}\n`)).join("");
  const sections = [{ id: "all", title: "All", overview: "", diffs: Array.from({ length: 300 }, (_, i) => ({ file: `src/f${i}.ts` })) }];
  const started = performance.now();
  const index = searchIndex(big, sections);
  const built = performance.now();
  const result = searchReview(index, "compute(42)");
  for (const query of ["value9", "line 99", "nothing like this"]) searchReview(index, query);
  const searched = performance.now();
  expect(index.lines).toHaveLength(30_000);
  expect(result.total).toBe(300);
  expect(result.hits).toHaveLength(100);
  // Measured about 10 ms to build and 1 ms per search on a laptop; generous for a loaded machine.
  expect(built - started).toBeLessThan(500);
  expect((searched - built) / 4).toBeLessThan(100);
});

async function renderWorkspace() {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Retry more", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findByText(/const retries = 5;/);
  return slot;
}

test("/ focuses Find in review; a result opens its chapter and lands on its line", async () => {
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  const flashed = vi.fn();
  (Element.prototype as Partial<Element>).animate = function (this: Element) { flashed(this); return {} as Animation; };
  Element.prototype.scrollBy = vi.fn();
  const slot = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "/" });
  const box = slot.getByRole("searchbox", { name: "Find in review" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.change(box, { target: { value: "ttl" } });
  const results = within(await slot.findByRole("list", { name: "Results" }));
  expect(slot.getByText("2 results")).toBeTruthy();
  // The line is in the other chapter, which isn't drawn.
  const hit = results.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "src/cache/b.ts:2");
  // The match is marked in its file's summary.
  const summary = results.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Derives the TTL from retries.");
  expect(summary.querySelector("mark")?.textContent).toBe("TTL");
  fireEvent.click(hit.closest("button")!);
  await slot.findByText(/evictOldest/);
  const row = slot.container.querySelector<HTMLElement>('[data-file="src/cache/b.ts"] diffs-container')!.shadowRoot!.querySelector('[data-line="2"]');
  await waitFor(() => expect(flashed).toHaveBeenCalledWith(row));
  slot.lifecycle.unmount();
}, 15_000);

test("Find in review works from the keyboard: Enter opens the first result, arrows move through them, Esc clears", async () => {
  const slot = await renderWorkspace();
  const box = slot.getByRole("searchbox", { name: "Find in review" });
  fireEvent.change(box, { target: { value: "caching" } });
  await slot.findByRole("list", { name: "Results" });
  // The chapter's title: Enter opens the chapter.
  fireEvent.keyDown(box, { key: "Enter" });
  await slot.findByText(/evictOldest/);
  fireEvent.change(box, { target: { value: "retries" } });
  const results = within(await slot.findByRole("list", { name: "Results" })).getAllByRole("button");
  // Results take the chapters' place.
  expect(slot.queryByRole("navigation", { name: "Chapters" })).toBeNull();
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(document.activeElement).toBe(results[0]);
  fireEvent.keyDown(results[0], { key: "ArrowDown" });
  expect(document.activeElement).toBe(results[1]);
  fireEvent.keyDown(results[1], { key: "ArrowUp" });
  fireEvent.keyDown(results[0], { key: "ArrowUp" });
  expect(document.activeElement).toBe(box);
  fireEvent.keyDown(box, { key: "Escape" });
  expect((box as HTMLInputElement).value).toBe("");
  // Without a query, the chapters are back.
  expect(slot.getByRole("navigation", { name: "Chapters" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("Enter or Esc that ends an IME conversion in Find in review does nothing else, Safari's included", async () => {
  const slot = await renderWorkspace();
  const box = slot.getByRole("searchbox", { name: "Find in review" });
  fireEvent.change(box, { target: { value: "caching" } });
  await slot.findByRole("list", { name: "Results" });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
  fireEvent.keyDown(box, { key: "Escape", keyCode: 229 });
  expect((box as HTMLInputElement).value).toBe("caching");
  expect(slot.queryByText(/evictOldest/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("the shortcut help lists / and f", async () => {
  const slot = await renderWorkspace();
  fireEvent.keyDown(document.body, { key: "?" });
  const help = within(await slot.findByRole("dialog", { name: "Keyboard shortcuts" }));
  expect(help.getByText("Find in review")).toBeTruthy();
  expect(help.getByText("All files, with the cursor in their filter")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("f with a Find in review query clears it, so All files shows with the cursor in its filter", async () => {
  const slot = await renderWorkspace();
  const box = slot.getByRole("searchbox", { name: "Find in review" });
  fireEvent.change(box, { target: { value: "ttl" } });
  await slot.findByRole("list", { name: "Results" });
  fireEvent.keyDown(document.body, { key: "f" });
  const filter = await slot.findByRole("searchbox", { name: "Filter files" });
  await waitFor(() => expect(document.activeElement).toBe(filter));
  expect((box as HTMLInputElement).value).toBe("");
  expect(slot.queryByRole("list", { name: "Results" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("on a coarse pointer Find in review's box and its results are 44px targets, the box's label taking taps around it", async () => {
  const slot = await renderWorkspace();
  const box = slot.getByRole("searchbox", { name: "Find in review" });
  const label = box.closest("label")!;
  expect(label.className).toContain("pointer-coarse:py-1");
  expect(box.className).toContain("pointer-coarse:h-9");
  fireEvent.change(box, { target: { value: "retries" } });
  const results = within(await slot.findByRole("list", { name: "Results" })).getAllByRole("button");
  for (const result of results) expect(result.className).toContain("pointer-coarse:min-h-11");
  slot.lifecycle.unmount();
}, 15_000);
