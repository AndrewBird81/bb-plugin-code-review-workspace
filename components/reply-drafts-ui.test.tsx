// @vitest-environment jsdom
// Replies to GitHub threads: they post now (Send reply), and what you write waits on the server as the thread's reply
// draft, yours or the agent's, inside its card. Replies a 0.5 tab kept in sessionStorage move there once.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import type { FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>
  ),
}));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const now = Date.now();
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] }] };
const comment = (id: string, databaseId: number, author: string, body: string) => ({ id, databaseId, author, body, createdAt: now - 3_600_000 });
// Yours, which alice answered, and bob's.
const threads = [
  { id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 2, side: "RIGHT", comments: [comment("c1", 111, "me", "Why upper case?"), comment("c2", 112, "alice", "It's a constant.")] },
  { id: "t2", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, side: "RIGHT", comments: [comment("c3", 113, "bob", "Is three right?")] },
];
const feedback: FeedbackView = {
  baseline: { sha: "old", at: now - 86_400_000, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, run: null, suggestionInDraft: false,
  items: [{
    id: "t1", kind: "thread", title: "Why upper case?", assessment: null, replyDraft: null,
    thread: { id: "t1", commentId: 111, reviewId: "R1", path: "src/a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Why upper case?", createdAt: now - 86_400_000, isResolved: false, resolvedBy: null, isOutdated: false, replies: [{ author: "alice", bot: false, mine: false, body: "It's a constant.", createdAt: now - 3_600_000 }], status: "answered", replyAt: now, url: null },
  }],
};

async function renderWorkspace(rpc: Record<string, unknown> = {}, drafts: unknown[] = [{ threadId: "t1", body: "Thanks, will check.", author: "agent", updatedAt: now }]) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new" }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: vi.fn(() => ({ threads: structuredClone(threads) })),
    getFeedback: vi.fn(() => ({ feedback })),
    getReplyDrafts: vi.fn(() => ({ drafts })),
    replyToThread: vi.fn(() => ({ ok: true })),
    replyToFeedback: vi.fn(() => ({ ok: true, feedback })),
    saveReplyDraft: vi.fn(() => ({ ok: true })),
    discardReplyDraft: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const card = (slot: Slot, line: number) => slot.findByRole("article", { name: `GitHub thread on src/a.ts:${line}` });

test("the agent's drafted reply waits in its thread, not sent, and Send reply posts it now through your feedback", async () => {
  const { slot, rpc } = await renderWorkspace();
  const yours = await card(slot, 2);
  const draft = within(yours).getByRole("group", { name: "Agent reply draft · not sent on src/a.ts:2" });
  expect(within(draft).getByText("Thanks, will check.")).toBeTruthy();
  expect(within(draft).getByText("Posts now, not with your review")).toBeTruthy();
  fireEvent.click(within(draft).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(rpc.replyToFeedback).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1", body: "Thanks, will check." }));
  await waitFor(() => expect(within(yours).queryByRole("group", { name: /reply draft/ })).toBeNull());
  slot.lifecycle.unmount();
}, 15_000);

test("what you write in a reply waits on the server as the thread's draft when you leave the box", async () => {
  const { slot, rpc } = await renderWorkspace();
  const bobs = await card(slot, 3);
  fireEvent.click(within(bobs).getByRole("button", { name: "Reply" }));
  const box = within(bobs).getByRole("textbox", { name: "Reply on src/a.ts:3" });
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.change(box, { target: { value: "Yes, three." } });
  fireEvent.blur(box);
  await waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t2", body: "Yes, three." }));
  expect(within(bobs).getByRole("group", { name: "Reply draft · not sent on src/a.ts:3" })).toBeTruthy();
  // Someone else's thread: the reply answers its first comment, and clears the draft it was.
  fireEvent.click(within(bobs).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(rpc.replyToThread).toHaveBeenCalledWith({ targetKey: "pr-42", inReplyTo: 113, body: "Yes, three.", threadId: "t2" }));
  slot.lifecycle.unmount();
});

test("editing the agent's draft makes it yours; Discard drops it and gives the focus back to Reply", async () => {
  const { slot, rpc } = await renderWorkspace();
  const yours = await card(slot, 2);
  fireEvent.click(within(yours).getByRole("button", { name: "Edit" }));
  const box = within(yours).getByRole("textbox", { name: "Reply on src/a.ts:2" }) as HTMLTextAreaElement;
  expect(box.value).toBe("Thanks, will check.");
  fireEvent.change(box, { target: { value: "Thanks, checking now." } });
  expect(within(yours).getByRole("group", { name: "Reply draft · not sent on src/a.ts:2" })).toBeTruthy();
  fireEvent.click(within(yours).getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(rpc.discardReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1" }));
  await waitFor(() => expect(document.activeElement).toBe(within(yours).getByRole("button", { name: "Reply" })));
  expect(within(yours).queryByRole("textbox")).toBeNull();
  slot.lifecycle.unmount();
});

test("a reply that doesn't go keeps its text, as the thread's draft", async () => {
  const { slot, rpc } = await renderWorkspace({ replyToThread: vi.fn(() => ({ ok: false, error: "GitHub said no" })) });
  const bobs = await card(slot, 3);
  fireEvent.click(within(bobs).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(bobs).getByRole("textbox"), { target: { value: "Not yet." } });
  // Clicking Send blurs the box toward this card's Send, which skips the blur's save.
  fireEvent.blur(within(bobs).getByRole("textbox"), { relatedTarget: within(bobs).getByRole("button", { name: "Send reply" }) });
  expect(rpc.saveReplyDraft).not.toHaveBeenCalled();
  fireEvent.click(within(bobs).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("GitHub said no"));
  expect((within(bobs).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Not yet.");
  await waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t2", body: "Not yet." }));
  slot.lifecycle.unmount();
});

test("a reply being written outlives its card: the list's copy closes, and the text waits for it", async () => {
  const { slot, rpc } = await renderWorkspace();
  await card(slot, 3);
  fireEvent.click(await slot.findByRole("button", { name: /^Comments/ }));
  const list = within(slot.getByRole("region", { name: "Comments" }));
  fireEvent.click(await list.findByRole("button", { name: "Expand GitHub thread on src/a.ts:3" }));
  const expanded = list.getByRole("article", { name: "GitHub thread on src/a.ts:3" });
  fireEvent.click(within(expanded).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(expanded).getByRole("textbox"), { target: { value: "Half a thought" } });
  fireEvent.click(list.getByRole("button", { name: "Collapse GitHub thread on src/a.ts:3" }));
  await waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t2", body: "Half a thought" }));
  fireEvent.click(list.getByRole("button", { name: "Expand GitHub thread on src/a.ts:3" }));
  expect(within(list.getByRole("article", { name: "GitHub thread on src/a.ts:3" })).getByText("Half a thought")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("clicking another card's Send still saves this card's reply", async () => {
  const { slot, rpc } = await renderWorkspace();
  const yours = await card(slot, 2);
  const bobs = await card(slot, 3);
  fireEvent.click(within(bobs).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(bobs).getByRole("textbox"), { target: { value: "Why three?" } });
  fireEvent.blur(within(bobs).getByRole("textbox"), { relatedTarget: within(yours).getByRole("button", { name: "Send reply" }) });
  expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t2", body: "Why three?" });
  slot.lifecycle.unmount();
});

test("Send reply hands the focus back to Reply", async () => {
  const { slot } = await renderWorkspace();
  const bobs = await card(slot, 3);
  fireEvent.click(within(bobs).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(bobs).getByRole("textbox"), { target: { value: "Thanks." } });
  fireEvent.click(within(bobs).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(document.activeElement).toBe(within(bobs).getByRole("button", { name: "Reply" })));
  slot.lifecycle.unmount();
});

test("a reply a 0.5 tab was writing in Threads moves to the server once and leaves the tab, unless the server has one", async () => {
  sessionStorage.setItem("gr:thread-reply:pr-42:t2", "Half a thought from before");
  sessionStorage.setItem("gr:thread-reply:pr-42:t1", "Older than the agent's");
  sessionStorage.setItem("gr:thread-reply:pr-7:t9", "Another review's");
  const { slot, rpc } = await renderWorkspace();
  const bobs = await card(slot, 3);
  await waitFor(() => expect(rpc.saveReplyDraft).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t2", body: "Half a thought from before" }));
  expect(rpc.saveReplyDraft).toHaveBeenCalledTimes(1);
  expect(within(bobs).getByRole("group", { name: "Reply draft · not sent on src/a.ts:3" })).toBeTruthy();
  expect(within(await card(slot, 2)).getByText("Thanks, will check.")).toBeTruthy();
  expect(sessionStorage.getItem("gr:thread-reply:pr-42:t2")).toBeNull();
  expect(sessionStorage.getItem("gr:thread-reply:pr-42:t1")).toBeNull();
  expect(sessionStorage.getItem("gr:thread-reply:pr-7:t9")).toBe("Another review's");
  slot.lifecycle.unmount();
});
