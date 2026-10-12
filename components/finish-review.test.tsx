// @vitest-environment jsdom
// Finish review: the summary, the verdict and the agent's suggestion, exactly what goes to GitHub with each doubt beside
// its fix, private notes when there are some, and Submit; then the receipt, with the next review that needs you.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import type { FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));
const { toast } = await import("sonner");

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const now = Date.now();
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] }] };
const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant." },
  { file: "src/a.ts", line: 1, side: "RIGHT", author: "agent", severity: "nit", body: "Spacing." },
];
const draftOf = (over: Record<string, unknown> = {}) => ({ targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(comments), ...over });
const run = { headSha: "new", summary: "", suggestedVerdict: "REQUEST_CHANGES" as const, suggestedBody: "One ask remains.", assessedAt: now, current: true };
const feedbackOf = (over: Partial<FeedbackView> = {}): FeedbackView => ({
  baseline: { sha: "old", at: now - 86_400_000, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, run: null, suggestionInDraft: false,
  items: [{
    id: "t1", kind: "thread", title: "Handle the empty list", replyDraft: null,
    assessment: { id: "t1", verdict: "not_addressed", evidence: "Still throws.", assessedAt: now },
    thread: { id: "t1", commentId: 1, reviewId: "R1", path: "src/a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Handle the empty list.", createdAt: now - 86_400_000, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null, url: null },
  }],
  ...over,
});
const waiting = (number: number, title: string, at: number, reason = "requested") => ({ targetKey: `pr-${number}`, kind: "pr", number, title, createdAt: at, signals: { requestedBy: "alice" }, turn: { group: "needs", reason, label: "Review requested", signal: null, at, notify: true, blocking: false, updated: false } });

async function renderWorkspace({ review = {}, rpc = {} }: { review?: Record<string, unknown>; rpc?: Record<string, unknown> } = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  // What the server says once a review was submitted.
  const sent: Record<string, unknown> = {};
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42, ...review, ...sent }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: draftOf(), stale: [] })),
    getReviewerNotes: vi.fn(() => ({ body: "", revision: 0 })),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: () => ({ threads: [] }),
    getFeedback: vi.fn(() => ({ feedback: feedbackOf() })),
    getReplyDrafts: () => ({ drafts: [{ threadId: "t1", body: "Still throws for me.", author: "reviewer", updatedAt: now }] }),
    setVerdict: vi.fn(({ verdict }: any) => ({ draft: draftOf({ verdict, verdictChosen: true }) })),
    submitReview: vi.fn(() => ({ ok: true, url: "https://github.com/acme/web/pull/42#pullrequestreview-9" })),
    useSuggestedVerdict: vi.fn(() => ({ ok: true })),
    listReviews: vi.fn(() => ({ reviews: [waiting(42, "Parse rows", now - 1000), waiting(110, "Trim the Docker image", now - 16 * 3_600_000), waiting(111, "Add tracing to checkout", now - 3_600_000)] })),
    startFixThread: vi.fn(() => ({ threadId: "t9", title: "Fix review comments" })),
    ...rpc,
  };
  const submitted = handlers.submitReview;
  handlers.submitReview = vi.fn(async (input: { verdict: string }) => {
    const result = await (submitted as (input: unknown) => unknown)(input);
    Object.assign(sent, { submittedVerdict: input.verdict, submittedAt: Date.now() });
    return result;
  }) as unknown as typeof handlers.submitReview;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
/** Finish review, with s. */
async function finish(slot: Slot) {
  fireEvent.keyDown(document.body, { key: "s" });
  await slot.findByRole("heading", { name: "Finish review" });
  const draft = await slot.findByRole("region", { name: "Review draft" });
  await within(draft).findByText("Draft saved");
  return within(draft);
}
const submit = (view: ReturnType<typeof within>) => view.getByRole("button", { name: /^Submit to GitHub/ });

test("it lists what goes to GitHub: the comments and their severities, who wrote them, and the replies that post on their own", async () => {
  const { slot } = await renderWorkspace();
  const view = await finish(slot);
  expect(view.getByText("2 comments", { exact: false }).textContent).toBe("2 comments · 1 blocking · 1 nit");
  expect(view.getByText("1 written by the agent")).toBeTruthy();
  expect(view.getByText("1 reply draft not sent: replies post on their own")).toBeTruthy();
  expect(submit(view).textContent).toBe("Submit to GitHub · Comment");
  expect(view.getByText("Posts to acme/web#42 as @me.")).toBeTruthy();
  // Each row opens Comments on what it counts.
  fireEvent.click(view.getByRole("button", { name: "Show the comments to send" }));
  const list = within(await slot.findByRole("region", { name: "Comments" }));
  expect(list.getByRole("radio", { name: "Not submitted, 2" }).getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
}, 15_000);

test("what holds Submit back is listed with its fix: a comment on an older diff, and Request changes without a summary", async () => {
  const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: draftOf({ verdict: "REQUEST_CHANGES" }), stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }] }) } });
  const view = await finish(slot);
  expect(view.getByText("1 comment on an older diff: edit or remove it")).toBeTruthy();
  expect(view.getByText("Request changes needs a summary: say what has to change.")).toBeTruthy();
  expect(submit(view).hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Write it" }));
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Review summary"));
  fireEvent.click(view.getByRole("button", { name: "Show the comments on an older diff" }));
  const list = within(await slot.findByRole("region", { name: "Comments" }));
  expect(list.getByRole("radio", { name: "Needs you, 2" }).getAttribute("aria-checked")).toBe("true");
  expect(list.getByRole("article", { name: "Draft comment on src/a.ts:1" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("doubts sit above Submit beside their fixes, and Submit still asks once more", async () => {
  const { slot, rpc } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "REQUEST_CHANGES", body: "Fine." }), stale: [] }) } });
  const view = await finish(slot);
  expect(view.getByText("The agent suggested Request changes.")).toBeTruthy();
  expect(view.getByText("Approving with 1 blocking comment.")).toBeTruthy();
  fireEvent.click(submit(view));
  expect((await view.findByRole("alert")).textContent).toContain("Approve with 1 blocking comment? The agent suggested Request changes.");
  expect(rpc.submitReview).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  fireEvent.click(view.getByRole("button", { name: "Switch to Request changes" }));
  await waitFor(() => expect(rpc.setVerdict).toHaveBeenCalledWith({ targetKey: "pr-42", verdict: "REQUEST_CHANGES", revision: "r1" }));
  expect(view.queryByText("The agent suggested Request changes.")).toBeNull();
  slot.lifecycle.unmount();
});

test("Use as draft and Request what's left put the agent's verdict and summary in the draft, asking before replacing yours", async () => {
  let draft = draftOf();
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    getFeedback: () => ({ feedback: feedbackOf({ run }) }),
    useSuggestedVerdict: vi.fn(() => { draft = draftOf({ verdict: "REQUEST_CHANGES", body: "One ask remains.", bodyAuthor: "agent" }); return { ok: true }; }),
  } });
  const view = await finish(slot);
  expect(view.getByText("Agent suggests Request changes")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Use as draft" }));
  await waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-42", mode: "suggested", revision: "r1" }));
  expect(toast.success).toHaveBeenCalledWith("Draft updated — review it before submitting.");
  await within(await slot.findByRole("region", { name: "Review summary" })).findByText("One ask remains.");
  // Now the summary's yours: the agent's words replace it only once you say so.
  draft = draftOf({ body: "My summary." });
  await slot.emitRealtime("draft:pr-42", {});
  await view.findByText("My summary.");
  fireEvent.click(view.getByRole("button", { name: "Request what’s left" }));
  const ask = await slot.findByRole("dialog", { name: "Replace your summary?" });
  fireEvent.click(within(ask).getByRole("button", { name: "Keep mine" }));
  expect(rpc.useSuggestedVerdict).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: "Request what’s left" }));
  fireEvent.click(within(await slot.findByRole("dialog", { name: "Replace your summary?" })).getByRole("button", { name: "Replace summary" }));
  await waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenLastCalledWith({ targetKey: "pr-42", mode: "remaining", revision: "r1" }));
  slot.lifecycle.unmount();
});

test("a suggestion already in the draft says so instead of offering it again", async () => {
  const { slot } = await renderWorkspace({ rpc: { getFeedback: () => ({ feedback: feedbackOf({ run, suggestionInDraft: true }) }) } });
  const view = await finish(slot);
  expect(view.getByText("In your draft")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Use as draft" })).toBeNull();
  expect(view.queryByText("One ask remains.")).toBeNull();
  slot.lifecycle.unmount();
});

test("the agent's summary shows with its suggestion, so you can read it while your own summary stays", async () => {
  let { slot } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft: draftOf({ body: "My summary." }), stale: [] })),
    getFeedback: () => ({ feedback: feedbackOf({ run: { ...run, summary: "Mostly there." } }) }),
  } });
  let suggestion = within((await finish(slot)).getByRole("region", { name: "Agent’s suggestion" }));
  expect(suggestion.getByText("Agent suggests Request changes")).toBeTruthy();
  expect(suggestion.getByText("One ask remains.")).toBeTruthy();
  expect(suggestion.getByRole("button", { name: "Use as draft" })).toBeTruthy();
  slot.lifecycle.unmount();
  // Without a suggested summary: the agent's word on where the PR stands.
  ({ slot } = await renderWorkspace({ rpc: { getFeedback: () => ({ feedback: feedbackOf({ run: { ...run, suggestedVerdict: null, suggestedBody: "", summary: "Mostly there." } }) }) } }));
  suggestion = within((await finish(slot)).getByRole("region", { name: "Agent’s suggestion" }));
  expect(suggestion.getByText("Mostly there.")).toBeTruthy();
  expect(suggestion.getByRole("button", { name: "Request what’s left" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("after Submit, the receipt says what went where, and offers the next review that needs you", async () => {
  let draft = draftOf({ body: "Two asks." });
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    submitReview: vi.fn(() => { draft = draftOf({ comments: [] }); return { ok: true, url: "https://github.com/acme/web/pull/42#pullrequestreview-9" }; }),
  } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  const receipt = within(await slot.findByRole("region", { name: "Submitted review" }));
  // The panel says it's done, as Comments' foot does.
  expect(slot.getByRole("heading", { name: "Review submitted" })).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "Finish review" })).toBeNull();
  expect(receipt.getByText("Commented")).toBeTruthy();
  expect(receipt.getByText(/^Posted to acme\/web#42 as @me · now/)).toBeTruthy();
  expect(receipt.getByText("2 comments")).toBeTruthy();
  expect(receipt.getByRole("link", { name: "View on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42#pullrequestreview-9");
  // Not this review: the next in the inbox's Needs review order, the one waiting longest.
  const next = within(await slot.findByRole("region", { name: "Next review" }));
  expect(next.getByText("Trim the Docker image")).toBeTruthy();
  // In All reviews' words (lib/status-line.ts).
  expect(next.getByText("Requested by @alice · #110 · 16h")).toBeTruthy();
  fireEvent.click(next.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", path: "review", options: { subPath: "pr-110" } })));
  expect(rpc.listReviews).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test("with nothing else waiting, the receipt says so, and All reviews goes back to the list", async () => {
  let draft = draftOf({ body: "Done." });
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    submitReview: vi.fn(() => { draft = draftOf({ comments: [] }); return { ok: true }; }),
    listReviews: () => ({ reviews: [waiting(42, "Parse rows", now)] }),
  } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  const next = within(await slot.findByRole("region", { name: "Next review" }));
  expect(next.getByText("Nothing else needs you right now.")).toBeTruthy();
  fireEvent.click(next.getByRole("button", { name: "All reviews" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", path: "review" })));
  slot.lifecycle.unmount();
});

test("an earlier review is a line above the next one's draft, so Finish stays open for it", async () => {
  const { slot } = await renderWorkspace({ review: { submittedVerdict: "REQUEST_CHANGES", submittedAt: now - 2 * 86_400_000 }, rpc: { getDraft: () => ({ draft: draftOf({ comments: [] }), stale: [] }) } });
  fireEvent.keyDown(document.body, { key: "s" });
  const last = within(await slot.findByRole("region", { name: "Submitted review" }));
  expect(last.getByText("Changes requested")).toBeTruthy();
  expect(last.getByText("· your last review, 2d ago")).toBeTruthy();
  expect(slot.getByRole("group", { name: "Review verdict" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a local review hands its comments to a new thread instead of Submit", async () => {
  const { slot, rpc } = await renderWorkspace({ review: { kind: "ref", gitRef: "main...x" } });
  const view = await finish(slot);
  expect(view.queryByRole("button", { name: /^Submit to GitHub/ })).toBeNull();
  expect(view.queryByRole("group", { name: "Review verdict" })).toBeNull();
  expect(view.getByText("Local review. Comments and notes stay in this BB installation.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Fix in a new thread" }));
  fireEvent.click(view.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(rpc.startFixThread).toHaveBeenCalled());
  slot.lifecycle.unmount();
});

test("a local review's private notes stay in BB under the one heading, with the rest that stays", async () => {
  const { slot } = await renderWorkspace({ review: { kind: "ref", gitRef: "main...x" }, rpc: { getReviewerNotes: () => ({ body: "Check the TTL.", revision: 1 }) } });
  const view = await finish(slot);
  expect(await view.findByText("Private notes")).toBeTruthy();
  expect(view.getAllByRole("heading", { name: "Stays in BB" })).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("on your own PR it offers Comment only, and Fix in a new thread beside Submit", async () => {
  const { slot } = await renderWorkspace({ review: { ownPr: true } });
  const view = await finish(slot);
  expect(within(view.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: /^Approve/ }).hasAttribute("disabled")).toBe(true);
  expect(view.getByText("This is your PR, so GitHub allows only a Comment review.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Fix in a new thread" })).toBeTruthy();
  expect(submit(view)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a closed PR keeps its unsubmitted draft to read, with nothing to submit", async () => {
  const { slot } = await renderWorkspace({ review: { prState: "CLOSED", archivedAt: 1 } });
  fireEvent.keyDown(document.body, { key: "s" });
  const archived = within(await slot.findByRole("region", { name: "Archived review" }));
  expect(archived.getByText("Closed · Archived")).toBeTruthy();
  fireEvent.click(archived.getByText("Unsubmitted draft"));
  expect(archived.getByText("src/a.ts:2 — Upper case reads as a constant.")).toBeTruthy();
  expect(slot.queryByRole("button", { name: /^Submit to GitHub/ })).toBeNull();
  // Nothing to finish: the panel calls it the archived review.
  expect(slot.getByRole("heading", { name: "Archived review" })).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "Finish review" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a closed PR's last chapter ends at its archived review, not at finishing it", async () => {
  const setFilesViewed = vi.fn(() => ({ ok: true, previous: [] }));
  const { slot } = await renderWorkspace({ review: { prState: "MERGED", archivedAt: 1 }, rpc: { setFilesViewed } });
  const main = within(slot.getByRole("main", { name: "Review" }));
  expect(main.queryByRole("button", { name: /Finish review|Mark viewed and finish/ })).toBeNull();
  // Marking it viewed stays on the chapter; the archived review is the button beside it.
  fireEvent.click(main.getByRole("button", { name: "Mark viewed" }));
  await waitFor(() => expect(setFilesViewed).toHaveBeenCalledWith({ targetKey: "pr-42", files: ["src/a.ts"] }));
  expect(slot.queryByRole("region", { name: "Archived review" })).toBeNull();
  fireEvent.click(main.getByRole("button", { name: "Archived review" }));
  expect(within(await slot.findByRole("region", { name: "Archived review" })).getByText("Merged · Archived")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a closed PR's Comments offers its archived review by touch, where the Finish bar was", async () => {
  const { slot } = await renderWorkspace({ review: { prState: "MERGED", archivedAt: 1 } });
  fireEvent.click(await slot.findByRole("button", { name: /^Comments/ }));
  const list = await slot.findByRole("region", { name: "Comments" });
  expect(within(list.parentElement!).queryByRole("button", { name: /^Finish review/ })).toBeNull();
  const archived = within(list.parentElement!).getByText("Merged · Archived").closest("div")!;
  fireEvent.click(within(archived).getByRole("button", { name: "Open the archived review" }));
  expect(within(await slot.findByRole("region", { name: "Archived review" })).getByText("Merged · Archived")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("private notes stay in BB, and show only when you have some", async () => {
  let { slot } = await renderWorkspace();
  let view = await finish(slot);
  expect(view.queryByText("Private notes")).toBeNull();
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ rpc: { getReviewerNotes: () => ({ body: "Check the TTL.", revision: 1 }) } }));
  view = await finish(slot);
  expect(await view.findByText("Stays in BB")).toBeTruthy();
  fireEvent.click(view.getByText("Private notes"));
  expect(((await view.findByRole("textbox", { name: "Private notes" })) as HTMLTextAreaElement).value).toBe("Check the TTL.");
  slot.lifecycle.unmount();
});
