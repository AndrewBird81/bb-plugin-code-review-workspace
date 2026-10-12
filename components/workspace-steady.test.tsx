// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { interdiff } from "../src/interdiff";
import type { FeedbackView } from "../lib/feedback";
import type { Turn } from "../lib/turn";
import { getReviewState, patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Count pierre's draws, and render its annotations (where the comment box opens).
const draws = vi.hoisted(() => ({ count: 0 }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => {
    draws.count++;
    return <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>;
  },
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); draws.count = 0; });

const DAY = 86_400_000;
const now = Date.now();
const file = (path: string, hunks: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
const patch = file("src/a.ts", "@@ -1 +1,2 @@\n-old\n+new\n+more\n");
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }] }],
};
// Waiting on the author, so the review opens on the diff.
const turn = (over: Partial<Turn> = {}): Turn => ({ group: "waiting", reason: "waiting", label: "Changes requested", action: "Review changes", signal: null, at: now, notify: true, blocking: false, updated: true, eventAt: null, failed: false, ...over });
const thread = (id: string, path: string, url: string | null) => ({
  id, kind: "thread" as const, title: `Thread ${id}`, replyDraft: null, assessment: null,
  thread: { id, commentId: 1, reviewId: "R1", path, line: 2, originalLine: 2, startLine: null, side: "RIGHT" as const, subjectType: "LINE" as const, body: "Handle it.", createdAt: now - 3 * DAY, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open" as const, replyAt: null, url },
});
const feedback: FeedbackView = {
  baseline: { sha: "old", at: now - 3 * DAY, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, run: null, suggestionInDraft: false,
  items: [thread("T1", "src/gone.ts", "https://github.com/acme/web/pull/42#discussion_r1")],
};

async function renderWorkspace(review: () => Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  // Opened before, on its first chapter: a first open shows the Overview.
  if (!getReviewState("pr-42").activeId) patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    // A new guide object on every load, as the server sends.
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review() }, guide: structuredClone(guide), patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: vi.fn(() => ({ baseline: { sha: "old", at: 1, verdict: "COMMENT" }, files: interdiff(file("src/a.ts", "@@ -1 +1 @@\n-old\n+new\n"), patch) })),
    getFeedback: vi.fn(() => ({ feedback })),
    markSeen: vi.fn(() => ({ ok: true })),
    snoozeReview: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  return { slot, rpc: handlers };
}
const panel = (slot: Awaited<ReturnType<typeof renderWorkspace>>["slot"]) => within(slot.getByRole("complementary", { name: "Comments and agent" }));

test("a background reload with the same guide doesn't redraw the diff", async () => {
  const { slot, rpc } = await renderWorkspace(() => ({ submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, signals: { lastReviewSha: "new", ci: "pending" }, turn: turn() }));
  await slot.findByTestId("filediff");
  const before = draws.count;
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(rpc.getReviewBundle).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(draws.count).toBe(before);
  slot.lifecycle.unmount();
});

test("a background reload keeps the diff the server leaves out, and reads the checks again only when CI changes", async () => {
  let signals: Record<string, unknown> = { lastReviewSha: "new", ci: "pending" };
  const getChecks = vi.fn(() => ({ bucket: "pending", checks: [] }));
  const { slot, rpc } = await renderWorkspace(() => ({ submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, signals, turn: turn() }), {
    getReviewBundle: vi.fn(({ knownRevision }: { knownRevision?: string }) => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", signals, turn: turn() }, guide: structuredClone(guide), patch: knownRevision === "r1" ? null : patch, revision: "r1" })),
    getChecks,
  });
  await slot.findByTestId("filediff");
  await waitFor(() => expect(getChecks).toHaveBeenCalledTimes(1));
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect((rpc.getReviewBundle.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toEqual({ targetKey: "pr-42", knownRevision: "r1" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(slot.getByTestId("filediff")).toBeTruthy();
  expect(getChecks).toHaveBeenCalledTimes(1);
  signals = { ...signals, ci: "fail" };
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(getChecks).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

test("Since your review follows the review you just submitted here, before GitHub reports it", async () => {
  let review: Record<string, unknown> = { submittedVerdict: "REQUEST_CHANGES", submittedAt: now - 3 * DAY, submittedHeadSha: "old", signals: { lastReviewAt: now - 3 * DAY, lastReviewSha: "old" }, turn: turn() };
  const { slot, rpc } = await renderWorkspace(() => review);
  const toggle = await slot.findByRole("button", { name: "Since your review" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  // You submit on the new head; GitHub still reports the old review.
  review = { ...review, submittedAt: now, submittedHeadSha: "new" };
  await slot.emitRealtime("review:pr-42", {});
  await waitFor(() => expect(slot.queryByRole("button", { name: "Since your review" })).toBeNull());
  expect(rpc.getSinceReview).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test("a failed comparison with your last review says so", async () => {
  const { slot } = await renderWorkspace(() => ({ submittedVerdict: "COMMENT", submittedAt: now - DAY, submittedHeadSha: "old", turn: turn() }), {
    getSinceReview: () => ({ baseline: null, files: [], error: "gh: not found" }),
  });
  const status = await slot.findByText("Couldn’t compare with your last review");
  expect(status.getAttribute("title")).toBe("gh: not found");
  expect(slot.queryByRole("button", { name: "Since your review" })).toBeNull();
  slot.lifecycle.unmount();
});

test("Follow up on a file outside every chapter says so and offers GitHub, without opening a comment box", async () => {
  const { toast } = await import("sonner");
  const { slot } = await renderWorkspace(() => ({ submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, turn: turn({ group: "needs", reason: "handled", label: "Feedback handled", signal: "handled:1" }) }));
  // Your thread waits on its author: it's on GitHub, not in Needs you.
  const github = await panel(slot).findByRole("radio", { name: /^On GitHub,/ });
  fireEvent.click(github);
  fireEvent.click(await panel(slot).findByRole("button", { name: "Expand GitHub thread on src/gone.ts:2" }));
  fireEvent.click(panel(slot).getByRole("button", { name: "More on the thread on src/gone.ts:2" }));
  fireEvent.click(await slot.findByRole("button", { name: "Follow up" }));
  expect(toast.info).toHaveBeenCalledWith("src/gone.ts isn’t changed in this PR anymore.", expect.objectContaining({ action: expect.objectContaining({ label: "Open on GitHub" }) }));
  // The list stays as it was.
  expect(github.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(slot.getByRole("button", { name: "Start reading: Parsing" }));
  await slot.findByTestId("filediff");
  expect(slot.queryByRole("textbox", { name: "Draft comment" })).toBeNull();
  (vi.mocked(toast.info).mock.calls[0][1] as any).action.onClick();
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "https://github.com/acme/web/pull/42#discussion_r1" });
  slot.lifecycle.unmount();
});

test("a failed review offers no Snooze in the Overview, nor Not yet in the menu", async () => {
  patchReviewState("pr-42", { activeId: "overview" });
  const { slot } = await renderWorkspace(() => ({ status: "error", submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, turn: turn({ group: "needs", reason: "re-requested", label: "Failed", action: "Retry review", failed: true }) }));
  await slot.findByText("Failed");
  expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull();
  fireEvent.click(await slot.findByRole("button", { name: "Review actions" }));
  await slot.findByRole("button", { name: /Delete/ });
  expect(slot.queryByRole("button", { name: "Not yet" })).toBeNull();
  slot.lifecycle.unmount();
});
