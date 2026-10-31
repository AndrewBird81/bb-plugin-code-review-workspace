// @vitest-environment jsdom
// Finish review: the summary, the verdict and the agent's suggestion, exactly what goes to GitHub with each doubt beside
// its fix, private notes when there are some, and Submit; then the receipt, with the next review that needs you.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { defaultKnobs } from "../lib/knobs";
import { commentsKey } from "../src/draft";
import { patchReviewState } from "../lib/panel-state";
import { panelTabCalls } from "./panel-tabs.test-support";
import type { FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));
const { toast } = await import("sonner");
// jsdom has no scrollIntoView, which Show's reveal lands with.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

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
  // BB's panel takes the tabs the page opens.
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any, experimental_panel: { openTab: () => true } });
  await slot.findByRole("main", { name: /^Review\b/ });
  await slot.findByTestId("filediff");
  return { app, slot, rpc: handlers };
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

test("a reply draft whose thread isn't listed, as when GitHub's threads didn't load, isn't counted as one to send", async () => {
  const { slot } = await renderWorkspace({ rpc: { getReplyDrafts: () => ({ drafts: [{ threadId: "gone", body: "Still throws for me.", author: "reviewer", updatedAt: now }] }) } });
  const view = await finish(slot);
  expect(view.queryByText(/reply drafts? not sent/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("it lists what goes to GitHub: the comments and their severities, who wrote them, and the replies that post on their own", async () => {
  const { slot } = await renderWorkspace();
  const view = await finish(slot);
  // Each count keeps its noun on its line.
  expect(view.getByText("2 comments").parentElement!.textContent).toBe("2 comments ·\u00a01 blocking ·\u00a01 nit");
  expect(view.getByText("1 blocking").parentElement!.className).toContain("whitespace-nowrap");
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

test("handing back to Comments, ‹ Comments and a Show link take the focus along: to the chosen chip, or the row they open", async () => {
  const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: draftOf(), stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }] }) } });
  let view = await finish(slot);
  const back = slot.getByRole("button", { name: "Comments" });
  back.focus();
  fireEvent.click(back);
  const list = within(await slot.findByRole("region", { name: "Comments" }));
  await waitFor(() => expect(document.activeElement).toBe(list.getByRole("radio", { checked: true })));
  view = await finish(slot);
  const show = view.getByRole("button", { name: "Show the comments on an older diff" });
  show.focus();
  fireEvent.click(show);
  await waitFor(() => expect(document.activeElement).toBe(list.getByRole("button", { name: /^Older diff · not submitted · src\/a\.ts:1/ })));
  slot.lifecycle.unmount();
}, 15_000);

test("what holds Submit back is listed with its fix: a comment on an older diff, and Request changes without a summary", async () => {
  const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: draftOf({ verdict: "REQUEST_CHANGES" }), stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }] }) } });
  const view = await finish(slot);
  // 72-hands-on #3: the words name Move to summary beside them.
  expect(view.getByText("1 comment on an older diff: edit or remove it, or move it to the summary")).toBeTruthy();
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

const olderDiff = [{ file: "src/a.ts", line: 1, side: "RIGHT" }];
/** The draft once the agent's nit on an older diff moved to the summary. */
const movedRpc = () => ({
  getDraft: vi.fn(() => ({ draft: draftOf(), stale: olderDiff })),
  moveToSummary: vi.fn(() => ({ draft: draftOf({ body: "- On `src/a.ts:1` (an earlier diff): **Nit:** Spacing.", comments: [comments[0]] }), stale: [] })),
  saveDraftComment: vi.fn(),
  saveSummary: vi.fn(),
});

test("Finish's row for a comment on an older diff moves it to the summary: a confirm shows its line, and there's no Undo", async () => {
  const rpc = movedRpc();
  const { slot } = await renderWorkspace({ rpc });
  const view = await finish(slot);
  fireEvent.click(view.getByRole("button", { name: "Move to summary" }));
  const confirm = within(await slot.findByRole("dialog", { name: "Move to summary" }));
  expect(confirm.getByText("Adds this line to your summary and removes the comment:")).toBeTruthy();
  expect(confirm.getByText("- On `src/a.ts:1` (an earlier diff): **Nit:** Spacing.")).toBeTruthy();
  fireEvent.click(confirm.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(rpc.moveToSummary).toHaveBeenCalledWith({ targetKey: "pr-42", revision: "r1", file: "src/a.ts", line: 1, side: "RIGHT" }));
  await waitFor(() => expect(view.queryByText(/on an older diff/)).toBeNull());
  // As Remove on an older diff: putting it back would bind it to the current diff unchecked.
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Moved to the summary"));
  expect(vi.mocked(toast.info).mock.calls.find(([text]) => text === "Moved to the summary")).toEqual(["Moved to the summary"]);
  expect([rpc.saveDraftComment, rpc.saveSummary].map((call) => call.mock.calls.length)).toEqual([0, 0]);
  slot.lifecycle.unmount();
}, 15_000);

test("an older-diff comment's card in Comments offers Move to summary too, and Cancel keeps it", async () => {
  const rpc = movedRpc();
  const { slot } = await renderWorkspace({ rpc });
  const view = await finish(slot);
  fireEvent.click(view.getByRole("button", { name: "Show the comments on an older diff" }));
  const card = within(await slot.findByRole("article", { name: "Draft comment on src/a.ts:1" }));
  fireEvent.click(card.getByRole("button", { name: "Move to summary" }));
  const confirm = within(await slot.findByRole("dialog", { name: "Move to summary" }));
  fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Move to summary" })).toBeNull());
  expect(rpc.moveToSummary).not.toHaveBeenCalled();
  // A comment on the current diff has none.
  fireEvent.click(slot.getByRole("radio", { name: /^All, / }));
  fireEvent.click(await slot.findByRole("button", { name: "Expand Draft comment on src/a.ts:2" }));
  expect(within(await slot.findByRole("article", { name: "Draft comment on src/a.ts:2" })).queryByRole("button", { name: "Move to summary" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("with Move to summary off, a comment on an older diff offers edit or remove only", async () => {
  const { slot } = await renderWorkspace({ rpc: { ...movedRpc(), getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, moveToSummary: false } }, revision: 0 }) } });
  const view = await finish(slot);
  expect(view.getByText("1 comment on an older diff: edit or remove it")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Move to summary" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show the comments on an older diff" }));
  const card = within(await slot.findByRole("article", { name: "Draft comment on src/a.ts:1" }));
  expect(card.getByRole("button", { name: "Remove comment on src/a.ts:1" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Move to summary" })).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("doubts sit above Submit beside their fixes, and Submit still asks once more", async () => {
  const { slot, rpc } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "REQUEST_CHANGES", body: "Fine." }), stale: [] }) } });
  const view = await finish(slot);
  // The agent's suggestion says it once, with its fix.
  const suggestion = within(view.getByRole("region", { name: "Agent’s suggestion" }));
  expect(suggestion.getByText("Agent suggests Request changes")).toBeTruthy();
  expect(view.queryByText("The agent suggested Request changes.")).toBeNull();
  expect(view.getByText("Approving with 1 blocking comment.")).toBeTruthy();
  // Submit names the mismatch too.
  expect(submit(view).textContent).toBe("Submit to GitHub · Approve · 1 blocking");
  fireEvent.click(submit(view));
  expect((await view.findByRole("alert")).textContent).toContain("Approve with 1 blocking comment? The agent suggested Request changes.");
  expect(rpc.submitReview).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  fireEvent.click(suggestion.getByRole("button", { name: "Switch to Request changes" }));
  await waitFor(() => expect(rpc.setVerdict).toHaveBeenCalledWith({ targetKey: "pr-42", verdict: "REQUEST_CHANGES", revision: "r1" }));
  await waitFor(() => expect(view.queryByRole("button", { name: "Switch to Request changes" })).toBeNull());
  slot.lifecycle.unmount();
});

test("approving with a high-risk file not viewed, or a chapter marked viewed too fast, says so and asks once more, never blocking", async () => {
  const lines = (file: string, n: number) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+row ${i}`).join("\n")}\n`;
  const risky = { ...guide, sections: [
    { id: "c1", title: "Parsing", overview: "Reads rows.", risk: "medium", diffs: [{ file: "src/b.ts" }, { file: "src/d.ts" }] },
    { id: "c2", title: "Auth", overview: "Checks tokens.", risk: "high", diffs: [{ file: "src/a.ts" }] },
    { id: "c3", title: "Docs", overview: "Says how.", risk: "low", diffs: [{ file: "src/c.ts" }] },
  ] };
  let draft = draftOf({ verdict: "APPROVE", verdictChosen: true, body: "Fine.", comments: [] });
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42 }, guide: risky, patch: lines("src/a.ts", 5) + lines("src/b.ts", 60) + lines("src/c.ts", 5) + lines("src/d.ts", 5), revision: "r1" }),
    // The docs, then Parsing's 60 lines a minute later.
    getFileViews: () => ({ views: [{ file: "src/c.ts", viewed: true, stale: false, viewedAt: now - 120_000 }, { file: "src/b.ts", viewed: true, stale: false, viewedAt: now - 60_000 }] }),
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    getFeedback: () => ({ feedback: feedbackOf({ items: [] }) }),
    submitReview: vi.fn(() => { draft = draftOf({ comments: [] }); return { ok: true }; }),
  } });
  const view = await finish(slot);
  expect(view.getByText("1 file in a high-risk chapter not viewed.")).toBeTruthy();
  expect(view.getByText("Chapter 1 (medium risk): 60 lines marked viewed in 1 min.")).toBeTruthy();
  fireEvent.click(submit(view));
  expect((await view.findByRole("alert")).textContent).toContain("Submit Approve? 1 file in a high-risk chapter not viewed. Chapter 1 (medium risk): 60 lines marked viewed in 1 min.");
  expect(rpc.submitReview).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  // Show opens the file, in its chapter.
  expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show" }));
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/a.ts"]')).toBeTruthy());
  fireEvent.click(submit(view));
  fireEvent.click(await view.findByRole("button", { name: "Submit anyway" }));
  await waitFor(() => expect(rpc.submitReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "APPROVE" })));
  slot.lifecycle.unmount();
});

test("only Approve asks about what you didn't view", async () => {
  const unread = { ...guide, sections: [{ ...guide.sections[0], risk: "high" }] };
  const { slot } = await renderWorkspace({ rpc: {
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", repo: "acme/web", number: 42 }, guide: unread, patch, revision: "r1" }),
    getDraft: () => ({ draft: draftOf({ verdict: "COMMENT", body: "Fine.", comments: [] }), stale: [] }),
  } });
  const view = await finish(slot);
  expect(view.queryByText(/not viewed/)).toBeNull();
  fireEvent.click(within(view.getByRole("group", { name: "Review verdict" })).getByRole("button", { name: /^Approve/ }));
  expect(await view.findByText("1 file in a high-risk chapter not viewed.")).toBeTruthy();
  slot.lifecycle.unmount();
});

/** Settings with Check before you approve off. */
const guardOff = () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, approveGuard: false } }, revision: 1 });
const unreadHighRisk = (review: Record<string, unknown> = {}) => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", repo: "acme/web", number: 42, ...review }, guide: { ...guide, sections: [{ ...guide.sections[0], risk: "high" }] }, patch, revision: "r1" });

test("with Check before you approve off, approving with a high-risk file not viewed says nothing and submits in one click", async () => {
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getPreferences: guardOff,
    getReviewBundle: () => unreadHighRisk(),
    getDraft: () => ({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true, body: "Fine.", comments: [] }), stale: [] }),
    getFeedback: () => ({ feedback: feedbackOf({ items: [] }) }),
  } });
  const view = await finish(slot);
  expect(view.queryByText(/not viewed/)).toBeNull();
  fireEvent.click(submit(view));
  await waitFor(() => expect(rpc.submitReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "APPROVE" })));
  expect(view.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount();
});

test("with Check before you approve off, every other doubt and row still shows", async () => {
  // The agent's summary was written for Comment, before the blocking comment was added.
  const agentSummary = (written: Record<string, unknown>) => draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "REQUEST_CHANGES", body: "Fine.", bodyAuthor: "agent", written });
  let draft = agentSummary({ verdict: "COMMENT", comments: "0:0" });
  let stale: unknown[] = [];
  const { slot } = await renderWorkspace({ rpc: {
    getPreferences: guardOff,
    getReviewBundle: () => unreadHighRisk(),
    getDraft: () => ({ draft, stale }),
    setVerdict: vi.fn(({ verdict }: any) => ({ draft: draftOf({ verdict, verdictChosen: true, body: "" }) })),
  } });
  const view = await finish(slot);
  expect(view.getByText("Agent suggests Request changes")).toBeTruthy();
  expect(view.getByText("Approving with 1 blocking comment.")).toBeTruthy();
  expect(view.queryByText(/not viewed/)).toBeNull();
  const ask = async () => {
    fireEvent.click(submit(view));
    const text = (await view.findByRole("alert")).textContent;
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    return text;
  };
  expect(await ask()).toContain("Approve with 1 blocking comment? The agent suggested Request changes. Your comments changed, and the summary was written for Comment.");
  draft = agentSummary({ verdict: "APPROVE", comments: "0:0" });
  await slot.emitRealtime("draft:pr-42", {});
  await waitFor(() => expect(view.queryByText("Approving with 1 blocking comment.")).toBeTruthy());
  await waitFor(async () => expect(await ask()).toContain("Your comments changed since the agent wrote the summary."));
  draft = agentSummary({ verdict: "COMMENT", comments: commentsKey(comments as Parameters<typeof commentsKey>[0]) });
  await slot.emitRealtime("draft:pr-42", {});
  await waitFor(async () => expect(await ask()).toContain("The summary was written for Comment."));
  stale = [{ file: "src/a.ts", line: 1, side: "RIGHT" }];
  await slot.emitRealtime("draft:pr-42", {});
  expect(await view.findByText("1 comment on an older diff: edit or remove it, or move it to the summary")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Switch to Request changes" }));
  expect(await view.findByText("Request changes needs a summary: say what has to change.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("images in the agent's summary and its suggested one show as links to them", async () => {
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: draftOf({ body: "Fine ![a](https://attacker.example/a.png)", bodyAuthor: "agent" }), stale: [] }),
    getFeedback: () => ({ feedback: feedbackOf({ run: { ...run, suggestedBody: "Asks ![b](https://attacker.example/b.png)" } }) }),
  } });
  const view = await finish(slot);
  const texts = view.getAllByTestId("bb-markdown").map((markdown: HTMLElement) => markdown.textContent);
  expect(texts).toEqual(expect.arrayContaining(["Fine [Image: a](https://attacker.example/a.png)", "Asks [Image: b](https://attacker.example/b.png)"]));
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

test("Submit says Submitting… while it posts to GitHub, and the draft's status still says Saving…", async () => {
  let post!: () => void;
  let draft = draftOf({ body: "Two asks." });
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    submitReview: vi.fn(() => new Promise((resolve) => { post = () => { draft = draftOf({ comments: [] }); resolve({ ok: true }); }; })),
  } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  await waitFor(() => expect(view.getByRole("button", { name: "Submitting…" })).toBeTruthy());
  expect(view.getAllByRole("status")[0].textContent).toBe("Saving…");
  post();
  await slot.findByRole("region", { name: "Submitted review" });
  slot.lifecycle.unmount();
});

// bug bash UX-1: Submit was disabled while it posted and the receipt took no focus, so the focus dropped to the page.
test("Submit keeps the focus while it posts, ignoring clicks, and the receipt takes it once the review is sent", async () => {
  let post!: () => void;
  let draft = draftOf({ body: "Two asks." });
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getDraft: vi.fn(() => ({ draft, stale: [] })),
    submitReview: vi.fn(() => new Promise((resolve) => { post = () => { draft = draftOf({ comments: [] }); resolve({ ok: true }); }; })),
  } });
  const view = await finish(slot);
  // Finish review opens on the summary, which takes the focus first.
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Review summary"));
  const button = submit(view);
  button.focus();
  fireEvent.click(button);
  const busy = await view.findByRole("button", { name: "Submitting…" });
  expect(busy).toBe(button);
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  expect(busy.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(busy);
  fireEvent.click(busy);
  expect(rpc.submitReview).toHaveBeenCalledTimes(1);
  post();
  const receipt = await slot.findByRole("region", { name: "Submitted review" });
  await waitFor(() => expect(document.activeElement).toBe(receipt));
  slot.lifecycle.unmount();
}, 15_000);

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
  // Its link is a line of text, with a 44px target on a touch screen.
  expect(last.getByRole("link", { name: "View on GitHub" }).className.split(" ")).toEqual(expect.arrayContaining(["relative", "pointer-coarse:after:h-11"]));
  expect(slot.getByRole("group", { name: "Review verdict" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("an earlier review sent moments ago says just now, not now ago", async () => {
  const { slot } = await renderWorkspace({ review: { submittedVerdict: "COMMENT", submittedAt: Date.now() - 10_000 }, rpc: { getDraft: () => ({ draft: draftOf({ comments: [] }), stale: [] }) } });
  fireEvent.keyDown(document.body, { key: "s" });
  const last = within(await slot.findByRole("region", { name: "Submitted review" }));
  expect(last.getByText("· your last review, just now")).toBeTruthy();
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

test("on your own PR, Finish counts only the comments that post: one sent to fix stays in BB, and Submit says so", async () => {
  const sentToFix = [{ ...comments[0], id: "c1", state: "sent", sendN: 1 }, comments[1]];
  const { slot, rpc } = await renderWorkspace({ review: { ownPr: true }, rpc: { getDraft: vi.fn(() => ({ draft: draftOf({ comments: structuredClone(sentToFix) }), stale: [] })) } });
  const view = await finish(slot);
  expect(view.getByText("1 comment").parentElement!.textContent).toBe("1 comment ·\u00a01 nit");
  expect(view.getByText("1 sent to fix won’t post to GitHub. Reopen it to post it.")).toBeTruthy();
  // The blocking one is with the main thread: nothing here blocks.
  expect(submit(view).textContent).toBe("Submit to GitHub · Comment");
  fireEvent.click(submit(view));
  await waitFor(() => expect(rpc.submitReview).toHaveBeenCalled());
  // What the page shows goes as it is, for the server's check; it posts only what's open.
  expect((rpc.submitReview as any).mock.calls[0][0].comments).toHaveLength(2);
  expect(await view.findByText("1 comment")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("comments not on GitHub yet are said in Finish to go with Send, not Submit, and aren't counted as posting or sent to fix", async () => {
  const local = (line: number) => ({ file: "src/a.ts", line, side: "LOCAL", body: "Only in the folder." });
  for (const [draft, said] of [
    [[...comments, local(3), local(4)], "2 comments aren’t on GitHub yet. They go with Send, not Submit."],
    [[comments[0], local(3)], "1 comment isn’t on GitHub yet. It goes with Send, not Submit."],
  ] as const) {
    const { slot } = await renderWorkspace({ review: { ownPr: true, feature: folderReview.feature }, rpc: { getDraft: vi.fn(() => ({ draft: draftOf({ comments: structuredClone(draft) }), stale: [] })) } });
    const view = await finish(slot);
    expect(view.getByText(said)).toBeTruthy();
    expect(view.queryByText(/sent to fix won’t post/)).toBeNull();
    slot.lifecycle.unmount();
    cleanup();
  }
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
  const main = within(slot.getByRole("main", { name: /^Review\b/ }));
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

test("beside its suggestion, Finish review says how many files the agent read and, folded, what it didn't check", async () => {
  const { slot } = await renderWorkspace({
    review: { agentReads: { head: "new", files: ["src/a.ts"] } },
    rpc: { getDraft: vi.fn(() => ({ draft: draftOf({ suggestedVerdict: "APPROVE", unchecked: ["Didn't run the tests", "`parse()` callers"] }), stale: [] })) },
  });
  const view = await finish(slot);
  const suggestion = within(view.getByRole("region", { name: "Agent’s suggestion" }));
  expect(suggestion.getByText("Agent suggests Approve")).toBeTruthy();
  expect(suggestion.getByText("Read 1 of 1 file")).toBeTruthy();
  const unchecked = suggestion.getByRole("button", { name: "What it didn’t check" });
  expect(unchecked.getAttribute("aria-expanded")).toBe("false");
  expect(suggestion.queryByText("Didn't run the tests")).toBeNull();
  fireEvent.click(unchecked);
  expect(suggestion.getByText("Didn't run the tests")).toBeTruthy();
  // It read every file, so approving asks nothing more of it.
  expect(view.queryByText(/The agent suggests Approve but read/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("an Approve suggestion from an agent that didn't read every file is a doubt, with Show, and Submit asks once more", async () => {
  const { slot, rpc } = await renderWorkspace({
    review: { agentReads: { head: "old", files: ["src/a.ts"] } },
    rpc: { getDraft: vi.fn(() => ({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "APPROVE", comments: [] }), stale: [] })) },
  });
  const view = await finish(slot);
  // Its reads were of an older head.
  expect(within(view.getByRole("region", { name: "Agent’s suggestion" })).getByText("Read 0 of 1 file")).toBeTruthy();
  const row = view.getByText("The agent suggests Approve but read 0 of 1 file").closest("li")!;
  expect(within(row).getByRole("button", { name: "Show" })).toBeTruthy();
  fireEvent.click(submit(view));
  const ask = await view.findByRole("alert");
  expect(ask.textContent).toContain("The agent suggests Approve but read 0 of 1 file.");
  expect(rpc.submitReview).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
}, 15_000);

test("another suggestion, however little the agent read, raises no doubt about it", async () => {
  const { slot } = await renderWorkspace({ rpc: { getDraft: vi.fn(() => ({ draft: draftOf({ suggestedVerdict: "COMMENT" }), stale: [] })) } });
  const view = await finish(slot);
  expect(within(view.getByRole("region", { name: "Agent’s suggestion" })).getByText("Read 0 of 1 file")).toBeTruthy();
  expect(view.queryByText(/The agent suggests Approve but read/)).toBeNull();
  slot.lifecycle.unmount();
}, 15_000);

test("with Show what the agent checked off, Finish review says nothing of what the agent read or didn't check, and asks nothing about it", async () => {
  const { slot, rpc } = await renderWorkspace({
    review: { agentReads: { head: "new", files: [] } },
    rpc: {
      getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, agentCoverage: false } }, revision: 0 }),
      getDraft: vi.fn(() => ({ draft: draftOf({ verdict: "APPROVE", verdictChosen: true, suggestedVerdict: "APPROVE", unchecked: ["Didn't run the tests"], comments: [] }), stale: [] })),
    },
  });
  const view = await finish(slot);
  expect(view.queryByText(/^Read \d+ of/)).toBeNull();
  expect(view.queryByRole("button", { name: "What it didn’t check" })).toBeNull();
  expect(view.queryByText(/The agent suggests Approve but read/)).toBeNull();
  fireEvent.click(submit(view));
  await waitFor(() => expect(rpc.submitReview).toHaveBeenCalled());
  slot.lifecycle.unmount();
}, 15_000);

// What the server holds Submit back for: in plain words, with what to do next.

test("new commits since you reviewed hold Submit with a warning in plain words, See the commits, and Submit anyway posts past exactly that warning", async () => {
  const submitReview = vi.fn()
    .mockResolvedValueOnce({ ok: false, warning: "2 new commits since you reviewed. Submitting now posts on the version you reviewed.", warnings: ["new-commits"], offers: ["anyway"], newCommits: { count: 2, url: "https://github.com/acme/web/compare/a...b" } })
    .mockResolvedValueOnce({ ok: true });
  const { slot, rpc } = await renderWorkspace({ rpc: { submitReview } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("Not submitted. 2 new commits since you reviewed. Submitting now posts on the version you reviewed. Your draft is kept.Submit anywaySee the 2 commitsCancel");
  expect(within(alert).getByRole("link", { name: "See the 2 commits" }).getAttribute("href")).toBe("https://github.com/acme/web/compare/a...b");
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
  fireEvent.click(within(alert).getByRole("button", { name: "Submit anyway" }));
  await slot.findByRole("region", { name: "Submitted review" });
  expect(rpc.submitReview).toHaveBeenLastCalledWith(expect.objectContaining({ force: ["new-commits"] }));
  slot.lifecycle.unmount();
});

test("GitHub allows only a Comment on your own PR: Submit as Comment submits it as one, in one step", async () => {
  const submitReview = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: "GitHub allows only a Comment review on your own PR.", offers: ["comment"] })
    .mockResolvedValueOnce({ ok: true });
  const { slot, rpc } = await renderWorkspace({ rpc: { submitReview, getDraft: vi.fn(() => ({ draft: draftOf({ verdict: "APPROVE", body: "Ready." }), stale: [] })) } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  fireEvent.click(view.getByRole("button", { name: "Submit anyway" }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Not submitted. GitHub allows only a Comment review on your own PR. Your draft is kept.");
  expect(within(alert).queryByRole("button", { name: "Submit anyway" })).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Submit as Comment" }));
  await slot.findByRole("region", { name: "Submitted review" });
  expect(rpc.submitReview).toHaveBeenLastCalledWith(expect.objectContaining({ asComment: true }));
  slot.lifecycle.unmount();
});

test("an unsent review of yours on GitHub offers to open it there, in the same voice; Cancel returns to Submit", async () => {
  const { slot } = await renderWorkspace({ rpc: { submitReview: vi.fn(() => ({ ok: false, error: "You have a pending review on this PR, started on github.com. Submit or discard it there, then submit again. Your draft has been kept.", offers: ["github"] })) } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Not submitted. You have a pending review on this PR, started on github.com. Submit or discard it there, then submit again. Your draft is kept.");
  expect(within(alert).getByRole("link", { name: "Open it on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42");
  fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(submit(view)));
  slot.lifecycle.unmount();
});

test("Agent activity lists what the review agent did on GitHub, newest first, a line each with its age and a link, folding from 5", async () => {
  // The ages count from `now`, however long the file took to get here.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const activity = [
    { at: now - 4 * 60_000, text: "Marked as a draft", asking: "direct" },
    { at: now - 3 * 60_000, text: "Posted reply on src/a.ts:12", asking: "direct", url: "https://github.com/acme/web/pull/42#discussion_r1" },
    { at: now - 2 * 60_000, text: "Added label bug", asking: "relayed", from: "thr_x", fromTitle: "Fix login race" },
    { at: now - 60_000, text: "Requested review from flocasts/live-dev", asking: "direct" },
    { at: now - 30_000, text: "Marked ready for review", asking: "direct" },
  ];
  const { slot } = await renderWorkspace({ review: { activity } });
  const view = await finish(slot);
  const part = view.getByRole("heading", { name: "Agent activity" }).parentElement!;
  const lines = () => within(part).getAllByRole("listitem").map((li) => li.textContent?.replace(/\u00a0/g, " "));
  expect(lines()).toEqual(["Marked ready for review · just now", "Requested review from flocasts/live-dev · 1m ago", "Added label bug · 2m ago · asked from Fix login race ↗"]);
  expect(within(part).getByRole("button", { name: "Fix login race ↗" })).toBeTruthy();
  fireEvent.click(within(part).getByRole("button", { name: "Show all 5" }));
  expect(lines().slice(-2)).toEqual(["Posted reply on src/a.ts:12 · 3m ago · View", "Marked as a draft · 4m ago"]);
  expect(within(part).getByRole("link", { name: "Posted reply on src/a.ts:12, on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42#discussion_r1");
  slot.lifecycle.unmount();
});

test("on an approval, the button past a warning says Approve anyway", async () => {
  const submitReview = vi.fn().mockResolvedValueOnce({ ok: false, warning: "The PR's base changed to main since you reviewed it.", warnings: ["base-changed"], offers: ["anyway"] });
  const { slot } = await renderWorkspace({ rpc: { submitReview, getDraft: vi.fn(() => ({ draft: draftOf({ verdict: "APPROVE", body: "Ready.", comments: [] }), stale: [] })) } });
  const view = await finish(slot);
  fireEvent.click(submit(view));
  const anyway = view.queryByRole("button", { name: "Submit anyway" });
  if (anyway) fireEvent.click(anyway);
  const alert = await view.findByRole("alert");
  await waitFor(() => expect(within(alert).getByRole("button", { name: "Approve anyway" })).toBeTruthy());
  slot.lifecycle.unmount();
});

/** A local review of feat/qa in acme/web, on MaxBook. */
const folderReview = { kind: "ref", gitRef: "feat/qa", place: { repo: "acme/web", machine: "MaxBook", path: "/Users/me/web" }, feature: { environmentId: "env1", hostId: "h", machine: "MaxBook", path: "/Users/me/web", branch: "feat/qa", baseRef: "main", repo: "acme/web" } };

test("a local review of a branch in a GitHub repo offers Open PR, which asks the review agent to draft it and opens its chat", async () => {
  const openPr = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ review: folderReview, rpc: { openPr } });
  const view = await finish(slot);
  expect(view.getByRole("heading", { name: "Open a PR" })).toBeTruthy();
  expect(view.getByText(/shows you its title and description before it opens/).textContent).toBe("The review agent drafts a PR from feat/qa in acme/web, and shows you its title and description before it opens.");
  fireEvent.click(view.getByRole("button", { name: "Open PR" }));
  await waitFor(() => expect(openPr).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  // Its chat, in BB's side panel.
  await waitFor(() => expect(panelTabCalls(slot)).toEqual(["openTab:agent"]));
  slot.lifecycle.unmount();
});

test("Open PR on a branch that isn't on GitHub yet says to push it first, as a muted note, not an error", async () => {
  const note = "`feat/qa` isn’t on GitHub yet. Push it first with **Push** above, then open the PR.";
  const { slot } = await renderWorkspace({ review: folderReview, rpc: { openPr: vi.fn(() => ({ ok: false, note })) } });
  const view = await finish(slot);
  fireEvent.click(view.getByRole("button", { name: "Open PR" }));
  const said = (await view.findByText((_, el) => el?.tagName === "P" && el.textContent === "feat/qa isn’t on GitHub yet. Push it first with Push above, then open the PR."));
  expect(within(said).getByText("Push").tagName).toBe("STRONG");
  expect(said.getAttribute("role")).toBe("status");
  expect(said.className).toContain("text-muted-foreground");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByRole("button", { name: "Open PR" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("Open PR that fails says why, as an alert", async () => {
  const error = "This folder’s repo is a fork; open its PR on GitHub.";
  const { slot } = await renderWorkspace({ review: folderReview, rpc: { openPr: vi.fn(() => ({ ok: false, error })) } });
  const view = await finish(slot);
  fireEvent.click(view.getByRole("button", { name: "Open PR" }));
  expect((await view.findByRole("alert")).textContent).toBe(error);
  slot.lifecycle.unmount();
});

test("Open PR on a branch with a PR already says so: the review is now that PR's", async () => {
  const note = "feat/qa has PR #7 on GitHub already, so none was opened. This review is now its review, with its comments.";
  const { slot } = await renderWorkspace({ review: folderReview, rpc: { openPr: vi.fn(() => ({ ok: true, note })) } });
  const view = await finish(slot);
  fireEvent.click(view.getByRole("button", { name: "Open PR" }));
  await waitFor(() => expect(toast.info).toHaveBeenCalledWith(note));
  slot.lifecycle.unmount();
});

test("no Open PR on a ref's review, a folder with no GitHub repo, or with the review agent drafting only", async () => {
  for (const [review, knobs] of [
    [{ kind: "ref", gitRef: "main...x" }, defaultKnobs],
    [{ ...folderReview, feature: { ...folderReview.feature, repo: null } }, defaultKnobs],
    [folderReview, { ...defaultKnobs, reviewAgentActs: false }],
  ] as const) {
    const { slot } = await renderWorkspace({ review, rpc: { getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }) } });
    const view = await finish(slot);
    expect(view.queryByRole("button", { name: "Open PR" })).toBeNull();
    slot.lifecycle.unmount();
    cleanup();
  }
});

test("a local review that becomes its PR's while open says so in the notice it stores, as its id changes, not one of the page's own", async () => {
  let review: Record<string, unknown> = folderReview;
  const dismissBecame = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ rpc: { dismissBecame, getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, title: "Parse rows", ...review }, guide: structuredClone(guide), patch, revision: "r1" }) } });
  const converted = { kind: "pr", repo: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", headSha: "c0ffee", feature: folderReview.feature };
  review = converted;
  await slot.emitRealtime("review:pr-42", {});
  await slot.findByText("web#7");
  expect(slot.queryByText(/This review is now/)).toBeNull();
  // Its stored notice, until Got it, which the server clears.
  review = { ...converted, became: { at: 1, number: 7, url: "https://github.com/acme/web/pull/7", from: "web:feat/qa", carried: 2, local: 0, outside: 0 } };
  await slot.emitRealtime("review:pr-42", {});
  const notice = await slot.findByRole("status", { name: "Now a PR" });
  expect(notice.textContent).toContain("Now PR #7’s review, web#7, with 2 comments carried over. It was web:feat/qa, which still opens it.");
  fireEvent.click(within(notice).getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(dismissBecame).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
});

/** A local review whose Push stands as `push`, read again on each reload, and the RPCs Push calls. */
async function renderPush(push: Record<string, unknown> | null, rpc: Record<string, unknown> = {}, review: Record<string, unknown> = folderReview) {
  const state = { push };
  const calls = {
    push: vi.fn((): any => ({ ok: true, delivery: "sent" })),
    dismissPush: vi.fn(() => { state.push = null; return { ok: true }; }),
    updateFeature: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const { app, slot, rpc: handlers } = await renderWorkspace({ rpc: { ...calls, getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, title: "Parse rows", ...review, push: state.push }, guide: structuredClone(guide), patch, revision: "r1" }) } });
  const view = await finish(slot);
  return { app, handlers, slot, view, state, calls, part: () => view.getByRole("heading", { name: "Push" }).closest("section")! as HTMLElement };
}
const HEAD = "abc1234def5678abc1234def5678abc1234def56";

test("Push on a local review says what it does, asks the main thread, and then waits on its commit, with Cancel", async () => {
  const { slot, view, state, calls, part } = await renderPush(null);
  expect(within(part()).getByText(/the review checks it/).textContent).toBe("The main thread commits what you reviewed, the review checks it, then it’s pushed to feat/qa. Never forced.");
  // The branch breaks only after its / or -, never mid-word.
  const branch = within(part()).getByText(/the review checks it/).querySelector(".font-mono")!;
  expect(branch.className).toContain("[overflow-wrap:anywhere]");
  expect(branch.innerHTML).toMatch(/feat\/<\/span><span><wbr>qa/);
  // It comes before Open a PR, which needs the branch on GitHub.
  const headings = view.getAllByRole("heading").map((h) => h.textContent);
  expect(headings.indexOf("Push")).toBeLessThan(headings.indexOf("Open a PR"));
  state.push = { state: "committing", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa" };
  fireEvent.click(within(part()).getByRole("button", { name: "Push" }));
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect((await within(part()).findByRole("status")).textContent).toBe("Waiting for the main thread to commit. The review checks the commit before anything is pushed.");
  fireEvent.click(within(part()).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(calls.dismissPush).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect(await within(part()).findByRole("button", { name: "Push" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a commit that isn't what you reviewed: Not pushed, which files, the secret named, then Update first, or Push anyway", async () => {
  const mismatch = { state: "mismatch", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD, warning: "2 files changed since you reviewed. **.env may hold secrets** and would go to GitHub. Ask the main thread to take it out of the commit, or Include it to review it.", files: [".env", "src/a.ts"], secrets: [".env"] };
  const { slot, state, calls, part } = await renderPush(mismatch);
  const alert = within(part()).getByRole("alert");
  expect(alert.textContent).toContain("Not pushed. 2 files changed since you reviewed. .env may hold secrets and would go to GitHub. Ask the main thread to take it out of the commit, or Include it to review it.");
  expect(within(alert).getByText(".env may hold secrets").tagName).toBe("STRONG");
  expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([".env · may hold secrets", "src/a.ts"]);
  // Update first leads; Push anyway still goes.
  expect(within(alert).getAllByRole("button").map((b) => b.textContent)).toEqual(["Update first", "Push anyway", "Cancel"]);
  expect(within(alert).getByRole("button", { name: "Push anyway" }).className).toContain("border");
  const { warning: _warning, files: _files, secrets: _secrets, ...rest } = mismatch;
  state.push = { ...rest, state: "pushing" };
  fireEvent.click(within(alert).getByRole("button", { name: "Push anyway" }));
  // On the commit shown.
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith({ targetKey: "pr-42", force: true, at: now, sha: HEAD }));
  expect((await within(part()).findByRole("status")).textContent).toBe("Pushing abc1234 to feat/qa. The review checks GitHub when the main thread finishes.");
  // Stop waiting, as when the thread is archived mid-push.
  fireEvent.click(within(part()).getByRole("button", { name: "Stop waiting" }));
  await waitFor(() => expect(calls.dismissPush).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
  cleanup();

  const again = await renderPush(mismatch);
  fireEvent.click(within(again.part()).getByRole("button", { name: "Update first" }));
  await waitFor(() => expect(again.calls.dismissPush).toHaveBeenCalled());
  expect(again.calls.updateFeature).toHaveBeenCalledWith({ targetKey: "pr-42" });
  expect(toast.success).toHaveBeenCalledWith("Updated. Review what changed, then Push.");
  expect(await within(again.part()).findByRole("button", { name: "Push" })).toBeTruthy();
  again.slot.lifecycle.unmount();
});

test("pushed says so; GitHub not at the commit, or a push no one asked for, is flagged in Finish and on the review, until Got it", async () => {
  const pushed = await renderPush({ state: "pushed", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD });
  expect(within(pushed.part()).getByRole("status").textContent).toMatch(/^Pushed abc1234 to feat\/qa · /);
  pushed.slot.lifecycle.unmount();
  cleanup();

  const differs = await renderPush({ state: "flagged", flag: "differs", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD, remote: "f00dbabef00d" });
  const text = "GitHub’s feat/qa is at f00dbab, not abc1234. The push may have failed: check the main thread.";
  // A status in Finish: the strip's notice is the alert, so it's said once.
  expect(within(differs.part()).getByRole("status").textContent).toContain(text);
  expect(within(differs.part()).queryByRole("alert")).toBeNull();
  for (const name of ["Push again", "Main thread", "Got it"]) expect(within(differs.part()).getByRole("button", { name })).toBeTruthy();
  const warned = differs.slot.getByRole("alert", { name: "Push not on GitHub" });
  for (const name of ["Push again", "Main thread", "Got it"]) expect(within(warned).getByRole("button", { name })).toBeTruthy();
  differs.slot.lifecycle.unmount();
  cleanup();

  const unrequested = await renderPush({ state: "flagged", flag: "unrequested", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", remote: "f00dbabef00d" });
  const said = "feat/qa has new commits on GitHub (now f00dbab) that didn’t come from Push. A teammate, CI or a thread may have pushed them.";
  expect(within(unrequested.part()).getByRole("status").textContent).toBe(`${said}UpdateGot it`);
  expect(within(unrequested.part()).queryByRole("button", { name: "Push again" })).toBeNull();
  // On the review too, as news rather than an alarm, with Update and Got it.
  const notice = unrequested.slot.getByRole("status", { name: "New commits on GitHub" });
  expect(notice.textContent).toContain(said);
  expect(unrequested.slot.queryByRole("alert", { name: "New commits on GitHub" })).toBeNull();
  expect(within(notice).getByRole("button", { name: "Update" })).toBeTruthy();
  fireEvent.click(within(notice).getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(unrequested.calls.dismissPush).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  await waitFor(() => expect(unrequested.slot.queryByRole("status", { name: "New commits on GitHub" })).toBeNull());
  unrequested.slot.lifecycle.unmount();
});

test("Push with nothing to push says so as a note; one that can't start says why as an alert", async () => {
  const note = "Nothing to push. GitHub already has `abc1234` on `feat/qa`.";
  const { slot, part } = await renderPush(null, { push: vi.fn(() => ({ ok: true, note })) });
  fireEvent.click(within(part()).getByRole("button", { name: "Push" }));
  const said = await within(part()).findByText((_, el) => el?.tagName === "P" && el.textContent === "Nothing to push. GitHub already has abc1234 on feat/qa.");
  expect(said.getAttribute("role")).toBe("status");
  expect(within(said).getByText("abc1234").closest(".font-mono")).toBeTruthy();
  slot.lifecycle.unmount();
  cleanup();

  const error = "This review has no main thread to commit and push. Choose one in Main thread.";
  const failing = await renderPush(null, { push: vi.fn(() => ({ ok: false, error })) });
  fireEvent.click(within(failing.part()).getByRole("button", { name: "Push" }));
  expect((await within(failing.part()).findByRole("alert")).textContent).toBe(error);
  failing.slot.lifecycle.unmount();
});

test("no Push on a PR's review, a folder with no GitHub repo or gone, or with Send to thread off", async () => {
  for (const [review, knobs] of [
    [{}, defaultKnobs],
    [{ ...folderReview, feature: { ...folderReview.feature, repo: null } }, defaultKnobs],
    [{ ...folderReview, feature: { ...folderReview.feature, folderGone: true } }, defaultKnobs],
    [folderReview, { ...defaultKnobs, sendToThread: false }],
  ] as const) {
    const { slot } = await renderWorkspace({ review, rpc: { getPreferences: () => ({ preferences: { ...defaultPreferences, knobs }, revision: 0 }) } });
    const view = await finish(slot);
    expect(view.queryByRole("heading", { name: "Push" })).toBeNull();
    slot.lifecycle.unmount();
    cleanup();
  }
});

test("a commit the check couldn't place offers no Push anyway; GitHub ahead of the folder offers Push anyway but no Update first", async () => {
  const unplaced = await renderPush({ state: "mismatch", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", warning: "The folder is at `f00dbab`, not `abc1234`, the commit reported.", files: [] });
  const alert = within(unplaced.part()).getByRole("alert");
  expect(alert.textContent).toContain("Not pushed. The folder is at f00dbab, not abc1234, the commit reported.");
  expect(within(alert).getAllByRole("button").map((b) => b.textContent)).toEqual(["Update first", "Cancel"]);
  unplaced.slot.lifecycle.unmount();
  cleanup();

  const behind = await renderPush({ state: "mismatch", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", behind: true, warning: "GitHub has commits on `feat/qa` that this folder doesn’t. Pull first, or Push anyway to try." });
  const warned = within(behind.part()).getByRole("alert");
  expect(within(warned).getAllByRole("button").map((b) => b.textContent)).toEqual(["Push anyway", "Cancel"]);
  fireEvent.click(within(warned).getByRole("button", { name: "Push anyway" }));
  // On the warning shown, by when it came.
  await waitFor(() => expect(behind.calls.push).toHaveBeenCalledWith({ targetKey: "pr-42", force: true, at: now }));
  behind.slot.lifecycle.unmount();
});

const COMPARE = "https://github.com/acme/web/compare/main...feat/qa?expand=1";
const plan = (over: Record<string, unknown> = {}) => ({ pushPlan: vi.fn(() => ({ openable: true, onGithub: false, pr: false, compare: COMPARE, ...over })) });

test("a local review's branch with no PR offers Push and open PR, with Push only; the separate Open PR stays only for a branch on GitHub; a PR has Push", async () => {
  const { slot, view, calls, part } = await renderPush(null, plan());
  await within(part()).findByRole("button", { name: "Push and open PR" });
  const buttons = within(part()).getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual(["Push and open PR", "Push only"]);
  // The primary button, and a quiet link beside it, underlined as Finish's links are.
  expect(buttons[0]!.className).not.toContain("border");
  expect(buttons[1]!.className.split(" ")).toContain("underline");
  expect(view.queryByRole("heading", { name: "Open a PR" })).toBeNull();
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith({ targetKey: "pr-42", thenOpenPr: true }));
  fireEvent.click(within(part()).getByRole("button", { name: "Push only" }));
  await waitFor(() => expect(calls.push).toHaveBeenLastCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
  cleanup();

  const pushedBefore = await renderPush(null, plan({ onGithub: true }));
  expect(await within(pushedBefore.part()).findByRole("button", { name: "Push and open PR" })).toBeTruthy();
  expect(pushedBefore.view.getByRole("heading", { name: "Open a PR" })).toBeTruthy();
  pushedBefore.slot.lifecycle.unmount();
  cleanup();

  const prPlan = plan({ onGithub: true, pr: true });
  const withPr = await renderPush(null, prPlan);
  await waitFor(() => expect(prPlan.pushPlan).toHaveBeenCalled());
  expect(within(withPr.part()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Push"]);
  expect(withPr.view.queryByRole("heading", { name: "Open a PR" })).toBeNull();
  withPr.slot.lifecycle.unmount();
});

test("Push and open PR says the review agent drafts the PR once it's pushed, then that it's drafting it, with its chat", async () => {
  const pushing = await renderPush({ state: "pushing", thenOpenPr: true, at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD }, plan());
  expect(within(pushing.part()).getByRole("status").textContent).toBe("Pushing abc1234 to feat/qa. Then the review agent drafts the PR.");
  pushing.slot.lifecycle.unmount();
  cleanup();

  const { slot, part } = await renderPush({ state: "pushed", thenOpenPr: "asked", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD }, plan({ onGithub: true }));
  const said = within(part()).getByRole("status");
  // Watch shows its chat beside the review, as Watch after a Send shows the main thread's.
  expect(said.textContent).toBe("Pushed abc1234. The review agent is drafting the PR; post it from its chat. · Watch");
  // Asked already: a Push of what comes next is just Push.
  await waitFor(() => expect(within(part()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Watch", "Push"]));
  fireEvent.click(within(said).getByRole("button", { name: "Watch" }));
  await waitFor(() => expect(panelTabCalls(slot)).toEqual(["openTab:agent"]));
  slot.lifecycle.unmount();
});

test("Push and open PR that couldn't ask the review agent once pushed says why, with Open PR to ask it again", async () => {
  const openPr = vi.fn(() => ({ ok: true }));
  const { view, slot, part } = await renderPush({ state: "pushed", thenOpenPr: "failed", openPrError: "MaxBook is offline.", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD }, { ...plan({ onGithub: true }), openPr });
  expect(within(part()).getByRole("alert").textContent).toBe("Couldn’t ask the review agent to draft the PR: MaxBook is offline. Open PR asks it again.");
  // Not Push and open PR again: Open PR, on its own.
  await waitFor(() => expect(within(part()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Push"]));
  const open = view.getByRole("heading", { name: "Open a PR" }).closest("section")!;
  fireEvent.click(within(open as HTMLElement).getByRole("button", { name: "Open PR" }));
  await waitFor(() => expect(openPr).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
});

test("Push and open PR that couldn't ask the review agent says so only while the branch has no PR, where Open PR is", async () => {
  const failed = { state: "pushed", thenOpenPr: "failed", openPrError: "MaxBook is offline.", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD };
  const opened = await renderPush(failed, plan({ onGithub: true, pr: true }));
  await waitFor(() => expect(within(opened.part()).getByRole("status").textContent).toContain("Pushed abc1234"));
  expect(within(opened.part()).queryByRole("alert")).toBeNull();
  opened.slot.lifecycle.unmount();
  const became = await renderPush(failed, plan({ onGithub: true }), { ...folderReview, kind: "pr", repo: "acme/web", number: 7, head: "feat/qa", ownPr: true, headFork: null, mainThread: { threadId: "coder", environmentId: "env1", origin: "adopted", since: 1 } });
  await waitFor(() => expect(within(became.part()).getByRole("status").textContent).toContain("Pushed abc1234"));
  expect(within(became.part()).queryByRole("alert")).toBeNull();
  became.slot.lifecycle.unmount();
});

test("with the review agent drafting only, Push is just Push, and once pushed links to GitHub to open the PR", async () => {
  const draftOnly = { getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultKnobs, reviewAgentActs: false } }, revision: 0 }) };
  const readyPlan = plan();
  const ready = await renderPush(null, { ...readyPlan, ...draftOnly });
  await waitFor(() => expect(readyPlan.pushPlan).toHaveBeenCalled());
  expect(within(ready.part()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Push"]);
  ready.slot.lifecycle.unmount();
  cleanup();

  const { slot, part } = await renderPush({ state: "pushed", at: now, threadId: "coder", repo: "acme/web", head: "feat/qa", sha: HEAD }, { ...plan({ onGithub: true }), ...draftOnly });
  const link = await within(part()).findByRole("link", { name: "New PR on GitHub" });
  expect(link.getAttribute("href")).toBe(COMPARE);
  expect(link.getAttribute("title")).toBe("Go to GitHub to open a PR");
  expect(within(part()).getByRole("status").textContent).toMatch(/^Pushed abc1234 to feat\/qa · .* · New PR on GitHub ↗$/);
  slot.lifecycle.unmount();
});

/** Your PR, acme/web#42 from feat/qa, with a fixer at work in its own folder. */
const fixerReview = { kind: "pr", repo: "acme/web", number: 42, head: "feat/qa", ownPr: true, mainThread: { threadId: "fixer", environmentId: "env_fix", origin: "fresh", since: 1, branch: "bb/fixes-thr_fix", fixer: { sha: "9e9e9e9", at: 1 } } };

test("on your PR with a fixer, Push says the fixer commits what Not pushed yet shows, and Update first opens Not pushed yet's page", async () => {
  const ready = await renderPush(null, {}, fixerReview);
  expect(within(ready.part()).getByText(/the review checks it/).textContent).toBe("The fixer commits what you reviewed in Not pushed yet, the review checks it, then it’s pushed to feat/qa. Never forced.");
  ready.slot.lifecycle.unmount();
  cleanup();

  const getNotPushed = vi.fn(async () => ({ state: "none", message: "Nothing waiting." }));
  const getSourceThread = vi.fn(() => ({ thread: { threadId: "fixer", title: "Fixes for web#42", state: "open", machine: "MaxBook" } }));
  const mismatch = { state: "mismatch", at: now, threadId: "fixer", repo: "acme/web", head: "feat/qa", sha: HEAD, warning: "1 file changed since you reviewed.", files: ["src/a.ts"] };
  const { slot, calls, part } = await renderPush(mismatch, { getNotPushed, getSourceThread }, fixerReview);
  fireEvent.click(within(part()).getByRole("button", { name: "Update first" }));
  await waitFor(() => expect(calls.dismissPush).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect(calls.updateFeature).not.toHaveBeenCalled();
  // The review shows its Not pushed yet page; BB's side panel stays as it was.
  expect(within(await slot.findByRole("region", { name: "Not pushed yet" })).getByText("Nothing waiting.")).toBeTruthy();
  expect(getNotPushed).toHaveBeenCalledWith({ targetKey: "pr-42" });
  expect(panelTabCalls(slot)).toEqual([]);
  slot.lifecycle.unmount();
});

test("on your PR with a fixer, new commits on GitHub that didn't come from Push name the fixer among who may have pushed them", async () => {
  const { slot, part } = await renderPush({ state: "flagged", flag: "unrequested", fixer: true, at: now, threadId: "fixer", repo: "acme/web", head: "feat/qa", remote: HEAD }, {}, fixerReview);
  const said = "feat/qa has new commits on GitHub (now abc1234) that didn’t come from Push. The fixer, a teammate or CI may have pushed them.";
  expect(within(part()).getByRole("status").textContent).toContain(said);
  expect(slot.getByRole("status", { name: "New commits on GitHub" }).textContent).toContain(said);
  slot.lifecycle.unmount();
});
