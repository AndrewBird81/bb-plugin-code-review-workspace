// @vitest-environment jsdom
// A chapter marked viewed faster than it reads says so as it's marked, with Back to it, and on the chapter, with It's fine,
// until it's been open long enough: its time in view is saved as it shows (lib/chapter-reads.ts).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";
import { CHAPTER_SAVE_MS } from "../lib/chapter-reads";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: ({ fileDiff }: any) => <pre>{fileDiff.additionLines.join("\n")}</pre> }));

Element.prototype.scrollIntoView ??= () => {};
const windowWidth = window.innerWidth;
beforeEach(() => { window.innerWidth = 1440; });
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); window.innerWidth = windowWidth; showing("visible"); });

/** The page shown or hidden, as when you switch tabs. */
function showing(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const MINUTE = 60_000;
const added = (path: string, n: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+${path} row ${i}`).join("\n")}\n`;
// Auth's 100 lines of code take 12 minutes at 500 an hour.
const patch = added("src/setup.ts", 3) + added("src/auth.ts", 100) + added("src/ui.ts", 3);
const guide = {
  title: "Guide", intent: "Signs in.", unplacedFiles: [] as string[],
  sections: [
    { id: "c1", title: "Setup", overview: "Adds config.", risk: "low", diffs: [{ file: "src/setup.ts", summary: "Config." }] },
    { id: "c2", title: "Auth", overview: "Checks tokens.", risk: "high", focus: ["Check that an expired token is refused."], diffs: [{ file: "src/auth.ts", summary: "Tokens." }] },
    { id: "c3", title: "Screens", overview: "Shows it.", risk: "low", diffs: [{ file: "src/ui.ts", summary: "Button." }] },
  ],
};

/** The review open on Auth, Setup marked viewed a minute ago, with the server's marks and chapter times. */
async function renderWorkspace(marked: Record<string, number> = { "src/setup.ts": Date.now() - MINUTE }, knobs = defaultKnobs) {
  patchReviewState("pr-42", { activeId: "c2" });
  const marks = new Map(Object.entries(marked));
  const reads = new Map<string, { openMs: number; fineAt: number | null }>();
  const app = await loadPluginApp(() => import("../app"));
  const rpc = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Sign in", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: vi.fn(() => ({
      views: [...marks].map(([file, viewedAt]) => ({ file, viewed: true, stale: false, viewedAt })),
      chapters: [...reads].map(([chapterId, read]) => ({ chapterId, ...read })),
    })),
    setFileViewed: vi.fn(({ file, viewed }: { file: string; viewed: boolean }) => { if (viewed) marks.set(file, Date.now()); else marks.delete(file); return { ok: true }; }),
    setFilesViewed: vi.fn(({ files }: { files: string[] }) => { for (const file of files) marks.set(file, Date.now()); return { ok: true, previous: [] }; }),
    addChapterOpenTime: vi.fn(({ chapterId, ms }: { chapterId: string; ms: number }) => {
      const read = reads.get(chapterId) ?? { openMs: 0, fineAt: null };
      reads.set(chapterId, { ...read, openMs: read.openMs + ms });
      return { ok: true, openMs: read.openMs + ms };
    }),
    setChapterFine: vi.fn(({ chapterId }: { chapterId: string }) => {
      const fineAt = Date.now();
      reads.set(chapterId, { openMs: reads.get(chapterId)?.openMs ?? 0, fineAt });
      return { ok: true, fineAt };
    }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    markSeen: () => ({ ok: true }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: rpc as any });
  await slot.findByRole("heading", { name: "Auth" });
  return { slot, rpc };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const code = (slot: Slot) => slot.queryByText(/src\/auth\.ts row 0/);

test("Mark viewed and continue on a chapter read quickly says so; Back to it goes back to it, its code open, where it says so until It's fine", async () => {
  const { slot, rpc } = await renderWorkspace();
  expect(code(slot)).toBeTruthy();
  expect(slot.queryByText(/^Read quickly/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Mark viewed and continue" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked 1 file viewed", expect.objectContaining({
    description: "Chapter 2 went quickly for high risk.", action: expect.objectContaining({ label: "Undo" }), cancel: expect.objectContaining({ label: "Back to it" }),
  })));
  await slot.findByRole("heading", { name: "Screens" });
  const [, options] = vi.mocked(toast.success).mock.calls.at(-1)!;
  act(() => (options as { cancel: { label: string; onClick: () => void } }).cancel.onClick());
  await slot.findByRole("heading", { name: "Auth" });
  // Viewed, and open to read again.
  await waitFor(() => expect(code(slot)).toBeTruthy());
  expect((slot.getByRole("checkbox", { name: "Viewed src/auth.ts" }) as HTMLInputElement).checked).toBe(true);
  const note = slot.getByText("Read quickly · 100 lines in 1 min");
  const fine = slot.getByRole("button", { name: "It’s fine" });
  expect(fine.getAttribute("aria-describedby")).toBe(note.id);
  fireEvent.click(fine);
  expect(slot.queryByText(/^Read quickly/)).toBeNull();
  await waitFor(() => expect(rpc.setChapterFine).toHaveBeenCalledWith({ targetKey: "pr-42", chapterId: "c2" }));
  // Read again from the server, it stays fine.
  const reads = rpc.getFileViews.mock.calls.length;
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(rpc.getFileViews.mock.calls.length).toBeGreaterThan(reads));
  expect(slot.queryByText(/^Read quickly/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter read slowly, or marked the review's first, says nothing as it's marked", async () => {
  const { slot } = await renderWorkspace({ "src/setup.ts": Date.now() - 20 * MINUTE });
  fireEvent.click(slot.getByRole("button", { name: "Mark viewed and continue" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked 1 file viewed", expect.anything()));
  expect(vi.mocked(toast.success).mock.calls.at(-1)![1]).toEqual({ description: undefined, action: expect.objectContaining({ label: "Undo" }) });
  slot.lifecycle.unmount();

  const first = await renderWorkspace({});
  fireEvent.click(first.slot.getByRole("button", { name: "Mark viewed and continue" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
  expect(vi.mocked(toast.success).mock.calls.at(-1)![1]).toEqual({ description: undefined, action: expect.objectContaining({ label: "Undo" }) });
  first.slot.lifecycle.unmount();
}, 15_000);

test("Viewed on a chapter's last file, read quickly, says so with Back to it; unchecking it says nothing", async () => {
  const { slot, rpc } = await renderWorkspace();
  const viewed = () => slot.getByRole("checkbox", { name: "Viewed src/auth.ts" });
  fireEvent.click(viewed());
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Chapter 2 went quickly for high risk.", { action: expect.objectContaining({ label: "Back to it" }) }));
  expect(slot.getByText("Read quickly · 100 lines in 1 min")).toBeTruthy();
  // Back to it, from the chapter itself, opens its folded file.
  await waitFor(() => expect(code(slot)).toBeNull());
  act(() => (vi.mocked(toast.info).mock.calls[0]![1] as { action: { label: string; onClick: () => void } }).action.onClick());
  await waitFor(() => expect(code(slot)).toBeTruthy());
  fireEvent.click(viewed());
  await waitFor(() => expect(rpc.setFileViewed).toHaveBeenLastCalledWith({ targetKey: "pr-42", file: "src/auth.ts", viewed: false }));
  await waitFor(() => expect(slot.queryByText(/^Read quickly/)).toBeNull());
  expect(toast.info).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
}, 15_000);

test("a chapter's time in view is saved each minute while it shows, not while the page is hidden, and once it's been open long enough its note goes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
  expect(document.visibilityState).toBe("visible");
  const { slot, rpc } = await renderWorkspace({ "src/setup.ts": Date.now() - MINUTE, "src/auth.ts": Date.now() });
  expect(slot.getByText("Read quickly · 100 lines in 1 min")).toBeTruthy();
  const minutes = async (n: number) => { for (let i = 0; i < n; i++) await act(async () => { vi.advanceTimersByTime(CHAPTER_SAVE_MS); }); };
  await minutes(1);
  await waitFor(() => expect(rpc.addChapterOpenTime).toHaveBeenCalledWith({ targetKey: "pr-42", chapterId: "c2", ms: expect.any(Number) }));
  // Hidden, it doesn't count.
  act(() => showing("hidden"));
  const saved = () => rpc.addChapterOpenTime.mock.calls.reduce((sum, [input]) => sum + input.ms, 0);
  await waitFor(() => expect(saved()).toBeGreaterThanOrEqual(MINUTE));
  const hidden = rpc.addChapterOpenTime.mock.calls.length;
  await minutes(5);
  expect(rpc.addChapterOpenTime).toHaveBeenCalledTimes(hidden);
  act(() => showing("visible"));
  await minutes(10);
  expect(slot.getByText(/^Read quickly · 100 lines in 1[01] min$/)).toBeTruthy();
  // Past twelve minutes in view, as long as its 100 lines take; the minute it returned to view in was part gone.
  await minutes(2);
  await waitFor(() => expect(slot.queryByText(/^Read quickly/)).toBeNull());
  expect(saved()).toBeGreaterThanOrEqual(12 * MINUTE);
  expect(saved()).toBeLessThan(14 * MINUTE);
  expect(new Set(rpc.addChapterOpenTime.mock.calls.map(([input]) => input.chapterId))).toEqual(new Set(["c2"]));
  slot.lifecycle.unmount();
}, 30_000);

test("with Check before you approve off, no chapter says it was read quickly, and no time is counted", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
  const { slot, rpc } = await renderWorkspace(undefined, { ...defaultKnobs, approveGuard: false });
  fireEvent.click(slot.getByRole("button", { name: "Mark viewed and continue" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked 1 file viewed", { description: undefined, action: expect.objectContaining({ label: "Undo" }) }));
  for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(CHAPTER_SAVE_MS); });
  expect(rpc.addChapterOpenTime).not.toHaveBeenCalled();
  expect(slot.queryByText(/^Read quickly/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);
