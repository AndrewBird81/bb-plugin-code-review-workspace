// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

Element.prototype.scrollIntoView ??= () => {};
const restores: (() => void)[] = [];
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); restores.splice(0).forEach((restore) => restore()); });
// A pane as wide as a desktop's, where the chapters dock.
const windowWidth = window.innerWidth;
beforeEach(() => { window.innerWidth = 1440; });
afterEach(() => { window.innerWidth = windowWidth; });

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
    { id: "c2", title: "Housekeeping", overview: "Renames.", diffs: [{ file: "src/b.ts", summary: "Renamed." }, { file: "src/c.ts", summary: "Reindented." }] },
  ],
};

type View = { file: string; hash: string; viewedAt: number };
async function renderWorkspace(knobs = defaultKnobs) {
  patchReviewState("pr-42", { activeId: "c1" });
  // The file views as the server keeps them: what marking replaced comes back with it, for Undo to put back.
  const stored = new Map<string, string>();
  const app = await loadPluginApp(() => import("../app"));
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: vi.fn(() => ({ views: [...stored].map(([file]) => ({ file, viewed: true, stale: false })) })),
    setFileViewed: vi.fn(() => ({ ok: true })),
    setFilesViewed: vi.fn(({ files, viewed = true, previous = [] }: { files: string[]; viewed?: boolean; previous?: View[] }) => {
      if (!viewed) {
        for (const file of files) { const view = previous.find((p) => p.file === file); if (view) stored.set(file, view.hash); else stored.delete(file); }
        return { ok: true };
      }
      const replaced = files.filter((f) => stored.has(f)).map((f) => ({ file: f, hash: stored.get(f)!, viewedAt: 1 }));
      files.forEach((f) => stored.set(f, "now"));
      return { ok: true, previous: replaced };
    }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByText("aa");
  return { slot, rpc, stored };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const chapters = (slot: Slot) => within(slot.getByRole("navigation", { name: "Chapters" }));
const card = (slot: Slot, title: string) => chapters(slot).getByText(title).closest("button")!;
const currentChapter = (slot: Slot) => chapters(slot).getAllByRole("button").find((button) => button.getAttribute("aria-current") === "step");
const undoLast = () => {
  const [message, options] = vi.mocked(toast.success).mock.calls.at(-1)!;
  act(() => (options as { action: { label: string; onClick: () => void } }).action.onClick());
  return message;
};

test("chapter ② is marked viewed from its ✓ in the chapters without opening it, and Undo puts it back", async () => {
  const { slot, rpc, stored } = await renderWorkspace();
  expect(card(slot, "Housekeeping").textContent).not.toContain("viewed");
  fireEvent.click(chapters(slot).getByRole("button", { name: "Mark chapter 2 viewed" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"] });
  // Still reading chapter 1: nothing opened.
  expect(currentChapter(slot)?.textContent).toContain("Parsing");
  expect(slot.queryByText("bb")).toBeNull();
  await waitFor(() => expect(chapters(slot).getByText("2/3 files viewed")).toBeTruthy());
  expect(card(slot, "Housekeeping").textContent).toContain("2 of 2 viewed");
  // Done, it has no ✓ to offer.
  expect(chapters(slot).queryByRole("button", { name: "Mark chapter 2 viewed" })).toBeNull();
  expect(undoLast()).toBe("Marked 2 files viewed");
  expect(chapters(slot).getByText("0/3 files viewed")).toBeTruthy();
  await waitFor(() => expect(rpc.setFilesViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", files: ["src/b.ts", "src/c.ts"], viewed: false, previous: [] }));
  await waitFor(() => expect(stored.size).toBe(0));
  expect(chapters(slot).getByRole("button", { name: "Mark chapter 2 viewed" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("the open chapter's card marks it viewed, says Chapter viewed, and Undo brings the button back", async () => {
  const { slot, rpc } = await renderWorkspace();
  fireEvent.click(chapters(slot).getByRole("button", { name: "Mark chapter viewed" }));
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] });
  expect(await chapters(slot).findByText("Chapter viewed")).toBeTruthy();
  expect(undoLast()).toBe("Marked 1 file viewed");
  expect(chapters(slot).getByRole("button", { name: "Mark chapter viewed" })).toBeTruthy();
  expect(chapters(slot).getByText("0 of 1 viewed")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("Next unviewed in the chapters opens the next file not viewed yet, in any chapter", async () => {
  const { slot } = await renderWorkspace();
  fireEvent.click(chapters(slot).getByRole("button", { name: "Mark chapter viewed" }));
  fireEvent.click(chapters(slot).getByRole("button", { name: "Next unviewed" }));
  await slot.findByText("bb");
  expect(currentChapter(slot)?.textContent).toContain("Housekeeping");
  slot.lifecycle.unmount();
}, 15_000);

test("with Fold files you've viewed off, the Viewed checkbox, v and Mark chapter viewed each leave the code open", async () => {
  const { slot, rpc } = await renderWorkspace({ ...defaultKnobs, foldViewedFiles: false });
  const viewed = () => slot.getByRole("checkbox", { name: "Viewed src/a.ts" }) as HTMLInputElement;
  fireEvent.click(viewed());
  await waitFor(() => expect(viewed().checked).toBe(true));
  expect(slot.getByText("aa")).toBeTruthy();
  fireEvent.click(viewed());
  await waitFor(() => expect(viewed().checked).toBe(false));
  fireEvent.keyDown(document.body, { key: "v" });
  await waitFor(() => expect(viewed().checked).toBe(true));
  expect(rpc.setFileViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", file: "src/a.ts", viewed: true });
  expect(slot.getByText("aa")).toBeTruthy();
  fireEvent.click(viewed());
  await waitFor(() => expect(viewed().checked).toBe(false));
  fireEvent.click(chapters(slot).getByRole("button", { name: "Mark chapter viewed" }));
  expect(await chapters(slot).findByText("Chapter viewed")).toBeTruthy();
  expect(slot.getByText("aa")).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

test("on a phone the chapters sheet marks a chapter viewed and stays open, its controls 44px", async () => {
  fakeSize(390, 844);
  const { slot, rpc } = await renderWorkspace();
  fireEvent.click(within(slot.getByRole("group", { name: "Review commands" })).getByRole("button", { name: /^Chapters:/ }));
  const sheet = within(slot.getByRole("dialog", { name: "Chapters" }));
  const mark = sheet.getByRole("button", { name: "Mark chapter viewed" });
  expect(mark.className).toContain("pointer-coarse:h-11");
  for (const row of [sheet.getByRole("button", { name: /^Overview/ }), sheet.getByText("a.ts").closest("button")!]) expect(row.className).toContain("pointer-coarse:min-h-11");
  fireEvent.click(mark);
  expect(rpc.setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] });
  expect(slot.getByRole("dialog", { name: "Chapters" })).toBeTruthy();
  slot.lifecycle.unmount();
}, 15_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// bug bash RDG-5: marking files viewed one after another reads the views back after each mark, and a read that left
// before the next mark was made landed anyway: the next file showed unviewed again, and with Fold files you've viewed
// on, unfolded, until its own read arrived.
test("a views read that left before your next mark doesn't undo that mark on screen", async () => {
  patchReviewState("pr-42", { activeId: "c1" });
  const oneChapter = { ...guide, sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }, { file: "src/c.ts" }] }] };
  const server = new Set<string>();
  const reads: Array<ReturnType<typeof deferred<{ views: unknown[] }>>> = [];
  const marks: Array<ReturnType<typeof deferred<{ ok: true }>>> = [];
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(oneChapter), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    // The first read comes with the bundle; later ones wait until the test lets them answer, with the server's views then.
    getFileViews: () => {
      if (!reads.length) { reads.push(deferred()); return { views: [] }; }
      const read = deferred<{ views: unknown[] }>();
      reads.push(read);
      return read.promise;
    },
    setFileViewed: ({ file, viewed }: { file: string; viewed: boolean }) => {
      const mark = deferred<{ ok: true }>();
      marks.push(mark);
      return mark.promise.then((done) => { if (viewed) server.add(file); else server.delete(file); return done; });
    },
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  } as any });
  await slot.findByText("aa");
  const box = (path: string) => slot.getByRole("checkbox", { name: `Viewed ${path}` }) as HTMLInputElement;
  const views = () => ({ views: [...server].map((file) => ({ file, viewed: true, stale: false, viewedAt: 1 })) });

  // a.ts is marked, and its mark lands: its read goes out.
  fireEvent.click(box("src/a.ts"));
  marks[0].resolve({ ok: true });
  await waitFor(() => expect(reads.length).toBe(2));
  // b.ts is marked while that read is out; its own mark hasn't landed yet.
  fireEvent.click(box("src/b.ts"));
  expect(box("src/b.ts").checked).toBe(true);
  // The read made before b.ts's mark answers, with what the server had then.
  reads[1].resolve(views());
  await new Promise((done) => setTimeout(done, 20));
  expect(box("src/b.ts").checked).toBe(true);
  slot.lifecycle.unmount();
}, 15_000);
