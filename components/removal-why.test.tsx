// @vitest-environment jsdom
// Why? on "Comment removed": for an agent's draft comment, while Settings → Review agent asks why, a popover with four
// one-tap reasons and an optional note (DraftProvider and RemovalWhy).
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs, type Knobs } from "../lib/knobs";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }] };
// Yours on a.ts:2, and the agent's on b.ts:1.
const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", body: "Upper case reads as a constant." },
  { file: "src/b.ts", line: 1, side: "RIGHT", author: "agent", severity: "nit", body: "Spacing." },
];

async function renderReview(knobs: Knobs = defaultKnobs) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  let draft = { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(comments) as any[] };
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft, stale: [] }),
    removeDraftComment: vi.fn((at: any) => {
      draft = { ...draft, comments: draft.comments.filter((c) => !(c.file === at.file && c.line === at.line && c.side === at.side)) };
      return { draft, stale: [] };
    }),
    setRemovalReason: vi.fn(() => ({ ok: true })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: [] }),
    getFeedback: () => ({ feedback: { baseline: null, head: "new", fetchedAt: Date.now(), suggestionInDraft: false, run: null, items: [] } }),
    getReplyDrafts: () => ({ drafts: [] }),
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: /^Review\b/ });
  // Once the settings apply.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderReview>>["slot"];
/** Remove the comment at `where` from its card in the code, and the toast that says so. */
async function remove(slot: Slot, rpc: Awaited<ReturnType<typeof renderReview>>["rpc"], where: string) {
  fireEvent.click(within(await slot.findByRole("article", { name: `Draft comment on ${where}` })).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(rpc.removeDraftComment).toHaveBeenCalled());
  await waitFor(() => expect(toast.info).toHaveBeenCalled());
  return vi.mocked(toast.info).mock.calls.at(-1) as [string, any];
}

test("removing the agent's comment offers Why? beside Undo; yours offers Undo only", async () => {
  const { slot, rpc } = await renderReview();
  const [mine, mineOptions] = await remove(slot, rpc, "src/a.ts:2");
  expect([mine, mineOptions.action.label, mineOptions.cancel]).toEqual(["Comment removed", "Undo", undefined]);
  const [agents, options] = await remove(slot, rpc, "src/b.ts:1");
  expect([agents, options.action.label, options.cancel.label]).toEqual(["Comment removed", "Undo", "Why?"]);
  slot.lifecycle.unmount();
}, 15_000);

test("Why? opens four reasons: one tap saves it, and Save adds your note and closes", async () => {
  const { slot, rpc } = await renderReview();
  const [, options] = await remove(slot, rpc, "src/b.ts:1");
  const button = document.createElement("button");
  options.cancel.onClick({ currentTarget: button });
  const popover = within(await slot.findByRole("dialog", { name: "Why did you remove it?" }));
  expect(within(popover.getByRole("group", { name: "Reason" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Wrong", "Intended", "Already known", "Not worth it"]);
  expect((popover.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(popover.getByRole("button", { name: "Already known" }));
  await waitFor(() => expect(rpc.setRemovalReason).toHaveBeenCalledWith({ targetKey: "pr-42", file: "src/b.ts", line: 1, side: "RIGHT", reason: "known" }));
  expect(popover.getByRole("button", { name: "Already known" }).getAttribute("aria-pressed")).toBe("true");
  const note = popover.getByRole("textbox", { name: "Your note, optional" }) as HTMLInputElement;
  expect(note.maxLength).toBe(200);
  fireEvent.change(note, { target: { value: " Tracked in JIRA-1. " } });
  fireEvent.click(popover.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc.setRemovalReason).toHaveBeenLastCalledWith({ targetKey: "pr-42", file: "src/b.ts", line: 1, side: "RIGHT", reason: "known", note: "Tracked in JIRA-1." }));
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Why did you remove it?" })).toBeNull());
  slot.lifecycle.unmount();
}, 15_000);

test("with Ask why off, removing the agent's comment offers Undo only", async () => {
  const { slot, rpc } = await renderReview({ ...defaultKnobs, removalReasons: false });
  const [text, options] = await remove(slot, rpc, "src/b.ts:1");
  expect([text, options.action.label, options.cancel]).toEqual(["Comment removed", "Undo", undefined]);
  slot.lifecycle.unmount();
}, 15_000);
