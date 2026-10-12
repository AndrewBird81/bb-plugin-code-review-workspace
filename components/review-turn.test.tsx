// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import type { FeedbackView } from "../lib/feedback";
import { TOUCH_CONTROL } from "./touch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Render the diff's annotations (where the comment box opens), not @pierre/diffs' internals.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">{lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const DAY = 86_400_000;
const now = Date.now();
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
const guide = {
  title: "Guide", intent: "Parses rows.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Parsing", overview: "", diffs: [{ file: "src/a.ts" }] }],
};
const turn = (over: Record<string, unknown>) => ({ group: "needs", reason: "re-requested", label: "Re-requested", action: "Review changes", signal: "re-requested:1", at: now, notify: true, blocking: false, updated: true, ...over });
const feedback: FeedbackView = {
  baseline: { sha: "old", at: now - 3 * DAY, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, suggestionInDraft: false,
  run: { headSha: "new", summary: "", suggestedVerdict: "APPROVE", suggestedBody: "Looks good now.", assessedAt: now, current: true },
  items: [{
    id: "T1", kind: "thread", title: "Handle the empty list", replyDraft: null, assessment: null,
    thread: { id: "T1", commentId: 1, reviewId: "R1", path: "src/a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "Handle the empty list.", createdAt: now - 3 * DAY, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null, url: null },
  }],
};

async function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, unknown> = {}, bundleGuide: unknown = guide) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", ...review }, guide: bundleGuide, patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getFeedback: vi.fn(() => ({ feedback })),
    markSeen: vi.fn(() => ({ ok: true })),
    snoozeReview: vi.fn(() => ({ ok: true })),
    startTrackedReview: vi.fn(() => ({ ok: true })),
    useSuggestedVerdict: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  return { slot, rpc: handlers };
}

type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
const panel = (slot: Slot) => within(slot.getByRole("complementary", { name: "Comments and agent" }));
/** Comments' chip: All, Needs you, Not submitted, or On GitHub. */
const chip = (slot: Slot, name: string) => panel(slot).getByRole("radio", { name: new RegExp(`^${name}, \\d+$`) });
const chosen = (slot: Slot, name: string) => waitFor(() => expect(chip(slot, name).getAttribute("aria-checked")).toBe("true"));

test("a review that came back to you is marked seen and opens on its Overview, with Comments on what needs you", async () => {
  const { slot, rpc } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) });
  await slot.findByRole("region", { name: "Comments" });
  expect(rpc.markSeen).toHaveBeenCalledTimes(1);
  expect(rpc.markSeen).toHaveBeenCalledWith({ targetKey: "pr-42" });
  expect(slot.getByRole("heading", { name: "Parse rows" })).toBeTruthy();
  await chosen(slot, "Needs you");
  slot.lifecycle.unmount();
});

test("Comments opened on what needs you keeps the one reader of GitHub going: opening it reads nothing again, and news still arrives", async () => {
  const { slot, rpc } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}), progress: { done: 0, total: 1, source: "threads" } });
  await chosen(slot, "Needs you");
  await waitFor(() => expect(rpc.getFeedback).toHaveBeenCalledTimes(1));
  fireEvent.click(panel(slot).getByRole("button", { name: "Close panel" }));
  fireEvent.click(slot.getByText("0/1 handled"));
  await chosen(slot, "Needs you");
  expect(rpc.getFeedback).toHaveBeenCalledTimes(1);
  await slot.emitRealtime("feedback:pr-42", {});
  await waitFor(() => expect(rpc.getFeedback).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

test("opened again in the same turn, a review goes back to where you were; back to you again, to its Overview", async () => {
  const review = { submittedVerdict: "REQUEST_CHANGES", turn: turn({}) };
  let { slot } = await renderWorkspace(review);
  fireEvent.click(await slot.findByRole("button", { name: "Start reading: Parsing" }));
  await slot.findByTestId("filediff");
  fireEvent.click(panel(slot).getByRole("button", { name: "Close panel" }));
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace(review));
  await slot.findByTestId("filediff");
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ ...review, turn: turn({ reason: "question", label: "Question for you", signal: "reply:2" }) }));
  await slot.findByRole("region", { name: "Comments" });
  await chosen(slot, "Needs you");
  expect(slot.getByRole("heading", { name: "Parse rows" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a review an older version left on Threads opens Comments there once, where it docks", async () => {
  patchReviewState("pr-42", { activeId: "c1", view: "threads" });
  const { slot } = await renderWorkspace({ submittedVerdict: "COMMENT", submittedAt: now - DAY, turn: turn({ group: "waiting", reason: "waiting", label: "Commented", signal: null }) }, {
    getReviewThreads: () => ({ threads: [] }),
  });
  await slot.findByTestId("filediff");
  await chosen(slot, "On GitHub");
  expect(JSON.parse(localStorage.getItem("gr:panelstate")!).perReview["pr-42"].view).toBeUndefined();
  slot.lifecycle.unmount();
});

test("a review you haven't given ignores the Feedback an older version left it on, and Comments still shows it when you pick it", async () => {
  patchReviewState("pr-42", { view: "feedback" });
  const { slot } = await renderWorkspace({ turn: turn({ reason: "requested", label: "Review requested", signal: "requested:1" }) });
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(slot.queryByRole("complementary", { name: "Comments and agent" })).toBeNull();
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  fireEvent.click(chip(slot, "Needs you"));
  expect(chip(slot, "Needs you").getAttribute("aria-checked")).toBe("true");
  // A 44px target on a coarse pointer.
  expect(chip(slot, "Needs you").className.split(" ")).toEqual(expect.arrayContaining(TOUCH_CONTROL.split(" ")));
  slot.lifecycle.unmount();
});

test("a review you haven't given still opens Comments on the Threads an older version left it on", async () => {
  patchReviewState("pr-42", { activeId: "c1", view: "threads" });
  const { slot } = await renderWorkspace({ turn: turn({ reason: "requested", label: "Review requested", signal: "requested:1" }) }, {
    getReviewThreads: () => ({ threads: [] }),
  });
  await slot.findByTestId("filediff");
  await chosen(slot, "On GitHub");
  slot.lifecycle.unmount();
});

test("a local review's Comments has only its draft", async () => {
  const { slot } = await renderWorkspace({ kind: "ref", gitRef: "main...x" });
  await slot.findByRole("heading", { name: "Parse rows" });
  fireEvent.click(await slot.findByRole("button", { name: "Comments" }));
  expect(panel(slot).getByRole("region", { name: "Comments" })).toBeTruthy();
  // No chips: nothing of it is on GitHub.
  expect(panel(slot).queryByRole("radio")).toBeNull();
  slot.lifecycle.unmount();
});

test("Follow up opens the comment box at the thread's line in the diff", async () => {
  const { slot } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) });
  await slot.findByRole("region", { name: "Submitted review", hidden: true });
  // Your thread waits on its author: it's on GitHub, not in Needs you.
  fireEvent.click(await panel(slot).findByRole("radio", { name: /^On GitHub,/ }));
  fireEvent.click(await panel(slot).findByRole("button", { name: "Expand GitHub thread on src/a.ts:2" }));
  fireEvent.click(panel(slot).getByRole("button", { name: "More on the thread on src/a.ts:2" }));
  fireEvent.click(await slot.findByRole("button", { name: "Follow up" }));
  const box = await within(await slot.findByTestId("filediff")).findByRole("textbox", { name: "Draft comment" });
  expect(box.closest("[data-draft-at]")?.getAttribute("data-draft-at")).toContain("src/a.ts");
  slot.lifecycle.unmount();
});

test("Use as draft opens the draft with the assistant's verdict and summary", async () => {
  let draft = { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] };
  const { slot, rpc } = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({}) }, {
    getDraft: vi.fn(() => ({ draft })),
    useSuggestedVerdict: vi.fn(() => { draft = { ...draft, verdict: "APPROVE", body: "Looks good now." }; return { ok: true }; }),
  });
  await slot.findByRole("region", { name: "Submitted review", hidden: true });
  // Finish review, from Comments' Finish bar.
  fireEvent.click(await panel(slot).findByRole("button", { name: "Finish review" }));
  fireEvent.click(await slot.findByRole("button", { name: "Use as draft" }));
  await waitFor(() => expect(rpc.useSuggestedVerdict).toHaveBeenCalledWith({ targetKey: "pr-42", mode: "suggested", revision: "r1" }));
  const summary = await slot.findByRole("region", { name: "Review summary" });
  await within(summary).findByText("Looks good now.");
  const verdicts = within(slot.getByRole("group", { name: "Review verdict" }));
  expect(verdicts.getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")).toBe("true");
  slot.lifecycle.unmount();
});

test("the Overview shows your review rounds, progress, Blocks merge, and snoozes until the author responds", async () => {
  const { slot, rpc } = await renderWorkspace({
    submittedVerdict: "REQUEST_CHANGES",
    submittedAt: now - DAY,
    turn: turn({ blocking: true }),
    progress: { done: 2, total: 5, source: "assistant" },
    signals: { lastReviewSha: "old", rounds: [
      { state: "CHANGES_REQUESTED", at: now - 3 * DAY, sha: "a" },
      { state: "COMMENTED", at: now - DAY, sha: "b" },
    ] },
  });
  const rounds = await slot.findByRole("list", { name: "Your reviews" });
  expect(rounds.textContent).toBe("Changes requested 3d ago→Commented 1d ago");
  expect(slot.getByText("Blocks merge")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Snooze" }));
  // The same Snooze choices as the review's ⋯, waiting for the author first.
  const choices = within(await slot.findByRole("group", { name: "Snooze" }));
  const responds = choices.getByRole("button", { name: "Until the author responds" });
  expect(choices.getAllByRole("button")[0]).toBe(responds);
  // A 44px row on a touch screen.
  expect(responds.className).toContain("pointer-coarse:h-11");
  fireEvent.click(responds);
  await waitFor(() => expect(rpc.snoozeReview).toHaveBeenCalledWith({ targetKey: "pr-42", snoozed: true }));
  // Your feedback's progress opens Comments on what needs you.
  fireEvent.click(panel(slot).getByRole("button", { name: "Close panel" }));
  fireEvent.click(slot.getByText("2/5 addressed"));
  await chosen(slot, "Needs you");
  slot.lifecycle.unmount();
});

test("a snoozed review offers Back to Needs review, and an unreviewed one can't wait for the author", async () => {
  const snoozed = await renderWorkspace({ submittedVerdict: "REQUEST_CHANGES", turn: turn({ group: "waiting", reason: "snoozed", label: "Not yet" }) });
  // "Not yet" is gone from the words: the chapters' Overview row says Snoozed, the status line why.
  const row = within(await snoozed.slot.findByRole("navigation", { name: "Chapters" })).getByRole("button", { name: /^Overview/ });
  expect(row.textContent).toBe("Overview · Snoozed");
  expect(snoozed.slot.getByText("Snoozed until the author responds")).toBeTruthy();
  fireEvent.click(await snoozed.slot.findByRole("button", { name: "Back to Needs review" }));
  await waitFor(() => expect(snoozed.rpc.snoozeReview).toHaveBeenCalledWith({ targetKey: "pr-42", snoozed: false }));
  snoozed.slot.lifecycle.unmount();

  const fresh = await renderWorkspace({ turn: turn({ reason: "requested", label: "Review requested" }) });
  fireEvent.click(await fresh.slot.findByRole("button", { name: "Snooze" }));
  // Tomorrow is always offered (Monday isn't on a Sunday).
  await fresh.slot.findByRole("button", { name: /^Tomorrow/ });
  expect(fresh.slot.queryByRole("button", { name: "Until the author responds" })).toBeNull();
  fresh.slot.lifecycle.unmount();
});

test("a new request can be snoozed until a time from the review's Overview", async () => {
  const { snoozeTimes } = await import("../lib/turn");
  const { slot, rpc } = await renderWorkspace({ turn: turn({ reason: "requested", label: "Review requested" }) });
  fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
  const tomorrow = snoozeTimes().tomorrow;
  // Tomorrow is always offered; on a Sunday it's Monday too.
  fireEvent.click(await slot.findByRole("button", { name: /^Tomorrow/ }));
  await waitFor(() => expect(rpc.snoozeReview).toHaveBeenCalledWith({ targetKey: "pr-42", snoozed: true, until: tomorrow }));
  slot.lifecycle.unmount();
});

test("a tracked review offers Build the guide instead of the guide", async () => {
  const { slot, rpc } = await renderWorkspace({
    status: "tracked", repo: "acme/web", number: 42, author: "octo", url: "https://github.com/acme/web/pull/42",
    turn: turn({ reason: "requested", label: "Review requested" }), signals: { requestedBy: "alice" },
  }, {}, null);
  await slot.findByRole("heading", { name: "Parse rows" });
  expect(slot.getByText("Requested by @alice")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/web/pull/42");
  fireEvent.click(slot.getByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(rpc.startTrackedReview).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  slot.lifecycle.unmount();
});

test("a tracked request stacked on a PR you haven't reviewed says so", async () => {
  const parent = { targetKey: "pr-41", number: 41, title: "Add the queue", url: null, status: "ready", reviewed: false };
  const { slot } = await renderWorkspace({
    status: "tracked", repo: "acme/web", number: 42, turn: turn({ reason: "requested", label: "Review requested" }),
    stack: { members: [parent, { ...parent, targetKey: "pr-42", number: 42 }], index: 1, parent, children: [] },
  }, {}, null);
  expect(await slot.findByText("You haven’t reviewed #41, which this builds on.")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Stacked on #41" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a tracked review that can't start says why", async () => {
  const { toast } = await import("sonner");
  const { slot } = await renderWorkspace({ status: "tracked", turn: turn({ reason: "new", label: "Tracked" }) }, {
    startTrackedReview: () => ({ ok: false, error: "No coding agent is set up." }),
  }, null);
  fireEvent.click(await slot.findByRole("button", { name: "Build the guide" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No coding agent is set up."));
  slot.lifecycle.unmount();
});

test("Submit review says what the draft would submit, and opens Finish review at the summary", async () => {
  const draft = { targetKey: "pr-42", verdict: "REQUEST_CHANGES", body: "Two asks.", comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", body: "Handle it." }] };
  const { slot } = await renderWorkspace({}, { getDraft: vi.fn(() => ({ draft })) });
  // In the band, where BB's title bar didn't take it.
  const open = await slot.findByRole("button", { name: "Submit review: Request changes, 1 comment" });
  expect(open.textContent).toBe("Submit· 1");
  expect(open.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(open);
  await slot.findByRole("heading", { name: "Finish review" });
  expect(open.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Review summary"));
  slot.lifecycle.unmount();
});

test("a merged review offers no Submit review", async () => {
  const { slot } = await renderWorkspace({ prState: "MERGED", archivedAt: 1 });
  await slot.findByRole("region", { name: "Archived review", hidden: true });
  await slot.findByRole("button", { name: "Comments" });
  expect(slot.queryByRole("button", { name: /^Submit review/ })).toBeNull();
  slot.lifecycle.unmount();
});
