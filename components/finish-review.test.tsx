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
import type { FeedbackView } from "../lib/feedback";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));
const { toast } = await import("sonner");
// jsdom has no scrollIntoView, which Show's reveal lands with.
Element.prototype.scrollIntoView ??= () => {};

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
  await slot.findByRole("main", { name: /^Review\b/ });
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
