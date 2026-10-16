// @vitest-environment jsdom
// Comment keys: on the comment ] or [ landed on, e edits, x removes, 1–4 and 0 set its severity, and r replies to a
// GitHub thread (Settings → Reading → Comment keys, under Single-key shortcuts).
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";
import { SettingsContext } from "../lib/settings";
import { ShortcutsHelp } from "./ShortcutsHelp";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The lines pierre is asked to show something under, and what's shown there.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
    </div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });
Element.prototype.scrollIntoView ??= () => {};

const file = (path: string, lines: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines}`;
const patch = file("src/a.ts", "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n") + file("src/b.ts", "@@ -1 +1 @@\n-x\n+bb\n");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [
  { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
] };
// Yours on a.ts:2, and the agent's on b.ts:1.
const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant.", chapterId: "c1" },
  { file: "src/b.ts", line: 1, side: "RIGHT", author: "agent", severity: "nit", body: "Spacing.", chapterId: "c1" },
];
// alice's thread on b.ts:1.
const threads = () => [{ id: "t1", isResolved: false, isOutdated: false, path: "src/b.ts", line: 1, side: "RIGHT", subjectType: "LINE", comments: [{ id: "c1", databaseId: 111, author: "alice", body: "Why bb?", createdAt: Date.now() }] }];

async function renderReview({ knobs = defaultKnobs, rpc = {}, drafts = comments }: { knobs?: Knobs; rpc?: Record<string, unknown>; drafts?: unknown[] } = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  let draft = { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(drafts) as any[] };
  const same = (c: any, at: any) => c.file === at.file && c.line === at.line && c.side === at.side;
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42 }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    saveDraftComment: vi.fn(({ comment }: any) => {
      draft = { ...draft, comments: [...draft.comments.filter((c) => !same(c, comment)), comment] };
      return { draft, stale: [] };
    }),
    removeDraftComment: vi.fn((at: any) => {
      draft = { ...draft, comments: draft.comments.filter((c) => !same(c, at)) };
      return { draft, stale: [] };
    }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: threads() }),
    getFeedback: () => ({ feedback: { baseline: null, head: "new", fetchedAt: Date.now(), suggestionInDraft: false, run: null, items: [] } }),
    getReplyDrafts: () => ({ drafts: [] }),
    saveReplyDraft: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findByRole("article", { name: "Draft comment on src/a.ts:2" });
  await slot.findByRole("article", { name: "GitHub thread on src/b.ts:1" });
  return { slot, rpc: handlers };
}
const press = (key: string) => fireEvent.keyDown(document.body, { key });
const writes = (rpc: Awaited<ReturnType<typeof renderReview>>["rpc"]) => rpc.saveDraftComment.mock.calls.length + rpc.removeDraftComment.mock.calls.length;

test("keys do nothing until ] or [ lands on a comment", async () => {
  const { slot, rpc } = await renderReview();
  for (const key of ["e", "x", "2", "0", "r"]) press(key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes(rpc)).toBe(0);
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  expect(slot.queryByRole("textbox", { name: "Reply on src/b.ts:1" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("1–4 set the severity of the comment ] landed on, over the comment as shown, and 0 clears it", async () => {
  const { slot, rpc } = await renderReview();
  press("]");
  press("2");
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledTimes(1));
  expect(rpc.saveDraftComment.mock.calls[0][0]).toEqual({ targetKey: "pr-42", revision: "r1", replaces: "Upper case reads as a constant.",
    comment: { file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", severity: "should-fix", body: "Upper case reads as a constant." } });
  expect(toast.info).toHaveBeenCalledWith("Should fix");
  press("0");
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledTimes(2));
  expect(rpc.saveDraftComment.mock.calls[1][0].comment).toEqual({ file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", body: "Upper case reads as a constant." });
  expect(toast.info).toHaveBeenCalledWith("No severity");
  // Only the comment landed on changed.
  expect(rpc.saveDraftComment.mock.calls.every(([input]: any) => input.comment.file === "src/a.ts")).toBe(true);
  slot.lifecycle.unmount();
}, 15_000);

test("a severity key keeps a comment's Pre-existing mark", async () => {
  const { slot, rpc } = await renderReview({ drafts: [{ ...comments[0], introduced: false }, comments[1]] });
  press("]");
  press("1");
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledTimes(1));
  expect(rpc.saveDraftComment.mock.calls[0][0].comment).toEqual({ file: "src/a.ts", line: 2, side: "RIGHT", chapterId: "c1", severity: "blocking", introduced: false, body: "Upper case reads as a constant." });
  slot.lifecycle.unmount();
}, 15_000);

test("e opens the box of the comment ] landed on, with its text", async () => {
  const { slot } = await renderReview();
  press("]");
  press("e");
  const box = await slot.findByRole("textbox", { name: "Draft comment" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Upper case reads as a constant.");
  slot.lifecycle.unmount();
}, 15_000);

test("x removes the comment ] landed on, with Undo, which puts it back", async () => {
  const { slot, rpc } = await renderReview();
  press("]");
  press("x");
  await waitFor(() => expect(rpc.removeDraftComment).toHaveBeenCalledTimes(1));
  expect(rpc.removeDraftComment.mock.calls[0][0]).toEqual({ targetKey: "pr-42", file: "src/a.ts", line: 2, side: "RIGHT" });
  await waitFor(() => expect(slot.queryByRole("article", { name: "Draft comment on src/a.ts:2" })).toBeNull());
  const [text, options] = vi.mocked(toast.info).mock.calls.at(-1)! as [string, any];
  expect(text).toBe("Comment removed");
  expect(options.action.label).toBe("Undo");
  options.action.onClick();
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledTimes(1));
  expect(rpc.saveDraftComment.mock.calls[0][0].comment).toMatchObject({ file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant." });
  await slot.findByRole("article", { name: "Draft comment on src/a.ts:2" });
  // Gone, it's no longer the current comment: x again does nothing until ] lands on one.
  slot.lifecycle.unmount();
}, 15_000);

test("r opens the reply box of the GitHub thread ] landed on, and does nothing on a draft comment", async () => {
  const { slot, rpc } = await renderReview();
  press("]");
  press("r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.queryByRole("textbox", { name: "Reply on src/b.ts:1" })).toBeNull();
  expect(writes(rpc)).toBe(0);
  // The agent's draft on b.ts:1, then alice's thread there.
  press("]");
  press("]");
  press("r");
  const box = await slot.findByRole("textbox", { name: "Reply on src/b.ts:1" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  // A thread has no severity, and isn't yours to remove.
  press("1");
  press("x");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes(rpc)).toBe(0);
  slot.lifecycle.unmount();
}, 15_000);

// 72-hands-on #1: on a line with a draft and a thread, ] focused the draft's card while the keys acted on the thread.
test("] focuses the card of the comment it lands on, where a line has a draft and a GitHub thread", async () => {
  const rects = Element.prototype.getClientRects;
  // Drawn, as in a browser: the step lands on its card rather than on the file.
  Element.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  try {
    const { slot, rpc } = await renderReview();
    const focused = () => document.activeElement?.getAttribute("aria-label");
    press("]");
    await waitFor(() => expect(focused()).toBe("Draft comment on src/a.ts:2"));
    // The agent's draft on b.ts:1, then alice's thread there.
    press("]");
    await waitFor(() => expect(focused()).toBe("Draft comment on src/b.ts:1"));
    press("]");
    await waitFor(() => expect(focused()).toBe("GitHub thread on src/b.ts:1"));
    press("x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes(rpc)).toBe(0);
    press("[");
    await waitFor(() => expect(focused()).toBe("Draft comment on src/b.ts:1"));
    press("x");
    await waitFor(() => expect(rpc.removeDraftComment).toHaveBeenCalledWith(expect.objectContaining({ file: "src/b.ts", line: 1 })));
    slot.lifecycle.unmount();
  } finally { Element.prototype.getClientRects = rects; }
}, 15_000);

test("with Comment keys off, or Single-key shortcuts off, the keys do nothing", async () => {
  for (const knobs of [{ ...defaultKnobs, commentKeys: false }, { ...defaultKnobs, singleKeyShortcuts: false }]) {
    const { slot, rpc } = await renderReview({ knobs });
    // Once the settings apply.
    await new Promise((resolve) => setTimeout(resolve, 20));
    press("]");
    for (const key of ["2", "e", "x", "r"]) press(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes(rpc)).toBe(0);
    expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
    slot.lifecycle.unmount();
    cleanup();
  }
}, 15_000);

test("the shortcuts sheet lists the Comment group only while Comment keys is on", () => {
  const sheet = (commentKeys: boolean) => {
    const preferences = { ...defaultPreferences, knobs: { ...defaultKnobs, commentKeys } };
    render(<SettingsContext.Provider value={{ preferences, settled: Promise.resolve(preferences), fallback: preferences }}><ShortcutsHelp open onOpenChange={() => {}} /></SettingsContext.Provider>);
    const dialog = within(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
    const headings = dialog.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    cleanup();
    return headings;
  };
  expect(sheet(true)).toEqual(["Move", "Mark", "Panels", "View", "Comment", "In a comment box"]);
  expect(sheet(false)).toEqual(["Move", "Mark", "Panels", "View", "In a comment box"]);
});
