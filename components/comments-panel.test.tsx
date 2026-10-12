// @vitest-environment jsdom
// Comments: one list beside the code for everything said about the review (spec §4), with the same items as cards at
// their lines. It took over Feedback, Threads, and the comment list of Draft review.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState, setHideNits } from "../lib/panel-state";
import type { FeedbackItem, FeedbackView } from "../lib/feedback";
import { TOUCH_CONTROL } from "./touch";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The lines pierre is asked to show something under, and what's shown there.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ lineAnnotations, renderAnnotation }: any) => (
    <div data-testid="filediff">
      {lineAnnotations?.map((annotation: any, index: number) => <div key={index} data-annotation={`${annotation.side}:${annotation.lineNumber}`}>{renderAnnotation?.(annotation)}</div>)}
    </div>
  ),
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });
// jsdom has no scrollIntoView. A reveal waits for the code to draw, then lands on the file with it: under a loaded
// machine that can happen after a test's own checks, as an uncaught error.
Element.prototype.scrollIntoView ??= () => {};

const now = Date.now();
const HOUR = 3_600_000;
const file = (path: string, lines: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines}`;
const patch = file("src/a.ts", "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n") + file("src/b.ts", "@@ -1 +1 @@\n-x\n+bb\n");
const guide = { title: "Guide", intent: "Parses rows.", unplacedFiles: [] as string[], sections: [
  { id: "c1", title: "Parsing", overview: "Reads rows.", diffs: [{ file: "src/a.ts" }] },
  { id: "c2", title: "Caching", overview: "Keeps rows.", diffs: [{ file: "src/b.ts" }] },
] };
const said = (id: string, databaseId: number, author: string, body: string, hours: number) => ({ id, databaseId, author, body, createdAt: now - hours * HOUR });
// Everyone's threads: yours with alice's answer, bob's resolved one on an old line, dave's on code since changed, carol's on a file.
const threads = () => [
  { id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 2, side: "RIGHT", subjectType: "LINE", comments: [said("c1", 111, "me", "**Blocking:** Why upper case?", 48), said("c2", 112, "alice", "It's a constant.", 5)] },
  { id: "t2", isResolved: true, isOutdated: false, path: "src/a.ts", line: 2, side: "LEFT", subjectType: "LINE", resolvedBy: "bob", comments: [said("c3", 113, "bob", "Old line note.", 30)] },
  { id: "t3", isResolved: false, isOutdated: true, path: "src/a.ts", line: null, side: "RIGHT", subjectType: "LINE", originalLine: 9, comments: [said("c4", 114, "dave", "This moved.", 20)] },
  { id: "t4", isResolved: false, isOutdated: false, path: "src/b.ts", line: null, side: "RIGHT", subjectType: "FILE", comments: [said("c5", 115, "carol", "Document this file.", 10)] },
];
// Your feedback on t1: alice answered, and the agent's check says it's partly done, with a reply it drafted.
const mine = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: "t1", kind: "thread", title: "Why upper case?", label: "Blocking", replyDraft: { body: "Thanks, I'll look again.", author: "agent", updatedAt: now },
  assessment: { id: "t1", verdict: "partial", evidence: "Renamed in one place of two.", file: "src/a.ts", line: 2, assessedAt: now - 2 * HOUR },
  thread: { id: "t1", commentId: 111, reviewId: "R1", path: "src/a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE", body: "**Blocking:** Why upper case?", createdAt: now - 48 * HOUR, isResolved: false, resolvedBy: null, isOutdated: false, replies: [{ author: "alice", bot: false, mine: false, body: "It's a constant.", createdAt: now - 5 * HOUR }], status: "answered", replyAt: now - 5 * HOUR, url: null },
  ...over,
});
const feedbackOf = (items: FeedbackItem[] = [mine()], run: FeedbackView["run"] = { headSha: "abcdef1234", summary: "", suggestedVerdict: "REQUEST_CHANGES", suggestedBody: "", assessedAt: now - 2 * HOUR, current: false }): FeedbackView => ({
  baseline: { sha: "old", at: now - 48 * HOUR, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: now, suggestionInDraft: false, run, items,
});
// The draft: yours on a.ts:2, one on an older diff at a.ts:1, and the agent's nit on b.ts:1; a question for the agent.
const comments = [
  { file: "src/a.ts", line: 2, side: "RIGHT", severity: "blocking", body: "Upper case reads as a constant." },
  { file: "src/a.ts", line: 1, side: "RIGHT", body: "Drafted before the last push." },
  { file: "src/b.ts", line: 1, side: "RIGHT", author: "agent", severity: "nit", body: "Spacing." },
];
const discussions = [{ file: "src/b.ts", line: 1, side: "LEFT", waiting: false, entries: [{ author: "reviewer", kind: "message", body: "Is x still used?", createdAt: now - HOUR }] }];

async function renderWorkspace({ review = {}, rpc = {} }: { review?: Record<string, unknown>; rpc?: Record<string, unknown> } = {}) {
  patchReviewState("pr-42", { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", kind: "pr", status: "ready", createdAt: 1, title: "Parse rows", headSha: "new", url: "https://github.com/acme/web/pull/42", repo: "acme/web", number: 42, ...review }, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: vi.fn(() => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(comments) }, stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }], discussions })),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    markSeen: () => ({ ok: true }),
    getReviewThreads: vi.fn(() => ({ threads: threads() })),
    getFeedback: vi.fn(() => ({ feedback: feedbackOf() })),
    getReplyDrafts: vi.fn(() => ({ drafts: [{ threadId: "t1", body: "Thanks, I'll look again.", author: "agent", updatedAt: now }] })),
    refreshFeedback: vi.fn(() => ({ feedback: feedbackOf() })),
    checkFeedback: vi.fn(() => ({ ok: true })),
    replyToThread: vi.fn(() => ({ ok: true })),
    replyToFeedback: vi.fn(() => ({ ok: true, feedback: feedbackOf([mine({ replyDraft: null, thread: { ...mine().thread!, status: "open" } })]) })),
    resolveThread: vi.fn(() => ({ ok: true })),
    unresolveThread: vi.fn(() => ({ ok: true })),
    saveReplyDraft: vi.fn(() => ({ ok: true })),
    discardReplyDraft: vi.fn(() => ({ ok: true })),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: handlers as any });
  await slot.findByRole("main", { name: "Review" });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>["slot"];
/** Comments, from the band's button where BB's title bar didn't take it, read from GitHub. A panel left open opens so again. */
async function openComments(slot: Slot) {
  const button = await slot.findByRole("button", { name: /^Comments/ });
  if (!slot.queryByRole("region", { name: "Comments" })) fireEvent.click(button);
  const list = within(slot.getByRole("region", { name: "Comments" }));
  await waitFor(() => expect(list.queryByText("Reading GitHub…")).toBeNull());
  return list;
}
const chip = (list: ReturnType<typeof within>, name: string) => list.getByRole("radio", { name: new RegExp(`^${name}, \\d+$`) });
const headings = (list: ReturnType<typeof within>) => list.getAllByRole("heading", { level: 3 }).map((heading: HTMLElement) => heading.textContent);
const rows = (list: ReturnType<typeof within>) => list.getAllByRole("button")
  .filter((button: HTMLElement) => button.closest("[data-comment-row]") && !/^(Expand|Collapse) /.test(button.getAttribute("aria-label") ?? ""))
  .map((button: HTMLElement) => button.getAttribute("aria-label"));
const code = (slot: Slot, path: string) => within(slot.container.querySelector<HTMLElement>(`[data-file="${path}"]`)!);

test("one list: chips count what they show, the groups come in order, and each item shows once", async () => {
  const { slot } = await renderWorkspace();
  const list = await openComments(slot);
  // Not submitted counts every draft comment, as Submit does; the one on an older diff shows in Needs you.
  expect(list.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["All, 8", "Needs you, 2", "Not submitted, 3", "On GitHub, 3"]);
  expect(chip(list, "All").getAttribute("aria-checked")).toBe("true");
  expect(headings(list)).toEqual(["Needs you · 2", "Not submitted · only in BB · 3", "On GitHub · 3", "Private · with the agent · 1"]);
  expect(list.getByText("1 blocking · 1 nit")).toBeTruthy();
  expect(list.getByText("+1 on an older diff, in Needs you")).toBeTruthy();
  expect(list.getByText("Yours: 1 of 1 handled")).toBeTruthy();
  expect(rows(list)).toEqual([
    "Older diff · not submitted · src/a.ts:1",
    "You · Author replied · src/a.ts:2 · Blocking · agent's check: Partial · Agent reply draft · not sent",
    "Draft · not submitted · src/a.ts:2 · Blocking",
    "Agent draft · not submitted · src/b.ts:1 · Nit",
    "@carol · Open · File comment · src/b.ts",
    "Private · with the agent · src/b.ts:1 (old line)",
  ]);
  // Resolved and outdated threads fold under On GitHub.
  expect(list.getByRole("button", { name: "1 resolved · 1 outdated" }).getAttribute("aria-expanded")).toBe("false");
  // The same count as Submit's, in the Finish bar and the title bar.
  expect(slot.getByText("3 to send", { exact: false })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Submit review: Comment, 3 comments" })).toBeTruthy();
  // The title bar's Comments says how many need you.
  expect(slot.getByRole("button", { name: "Comments, 2 need you" })).toBeTruthy();
  // A file's row counts what the list has at it: a.ts's two drafts, and its threads not resolved, the outdated one too.
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"] [data-file-header]')!).getByText("2 not submitted · 2 on GitHub")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a chip shows its group alone: Needs you by urgency, and Not submitted every draft comment in reading order", async () => {
  const { slot } = await renderWorkspace();
  const list = await openComments(slot);
  // A radio group: one Tab stop, and the arrows move the choice.
  expect(list.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);
  fireEvent.keyDown(chip(list, "All"), { key: "ArrowRight" });
  expect(chip(list, "Needs you").getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(chip(list, "Needs you"), { key: "ArrowLeft" });
  expect(chip(list, "All").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(chip(list, "Needs you"));
  expect(headings(list)).toEqual(["Needs you · 2"]);
  expect(rows(list)).toEqual(["Older diff · not submitted · src/a.ts:1", "You · Author replied · src/a.ts:2 · Blocking · agent's check: Partial · Agent reply draft · not sent"]);
  fireEvent.click(chip(list, "Not submitted"));
  expect(rows(list)).toEqual(["Older diff · not submitted · src/a.ts:1", "Draft · not submitted · src/a.ts:2 · Blocking", "Agent draft · not submitted · src/b.ts:1 · Nit"]);
  fireEvent.click(chip(list, "On GitHub"));
  fireEvent.click(list.getByRole("button", { name: "1 resolved · 1 outdated" }));
  expect(rows(list)).toEqual([
    "@carol · Open · File comment · src/b.ts",
    "@bob · Resolved · src/a.ts:2 (old line)",
    "@dave · Open · Outdated · src/a.ts:9",
  ]);
  slot.lifecycle.unmount();
});

test("a row shows its item in the code, switching chapters, and its chevron opens it in place as the full card", async () => {
  const { slot } = await renderWorkspace();
  const list = await openComments(slot);
  fireEvent.click(list.getByRole("button", { name: "Agent draft · not submitted · src/b.ts:1 · Nit" }));
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy());
  expect(await code(slot, "src/b.ts").findByRole("article", { name: "Draft comment on src/b.ts:1" })).toBeTruthy();
  // The list stays beside the code.
  expect(slot.getByRole("region", { name: "Comments" })).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Expand GitHub thread on src/a.ts:2" }));
  const card = list.getByRole("article", { name: "GitHub thread on src/a.ts:2" });
  expect(within(card).getByText("It's a constant.")).toBeTruthy();
  expect(within(card).getByText("Renamed in one place of two.")).toBeTruthy();
  expect(within(card).getByRole("group", { name: "Agent reply draft · not sent on src/a.ts:2" })).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Collapse GitHub thread on src/a.ts:2" }));
  expect(list.queryByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a row and a pill show what waits with an item: a thread's reply draft, and a draft's messages with the agent", async () => {
  const talk = [{ file: "src/a.ts", line: 2, side: "RIGHT", waiting: false, entries: [
    { author: "reviewer", kind: "message", body: "Is this right?", createdAt: now - HOUR },
    { author: "agent", kind: "message", body: "Yes.", createdAt: now - HOUR },
  ] }];
  const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: structuredClone(comments) }, stale: [], discussions: talk }) } });
  const list = await openComments(slot);
  const row = (id: string) => within(slot.container.querySelector<HTMLElement>(`[data-comment-row="${id}"]`)!);
  expect(row("t1").getByText("Agent reply draft · not sent")).toBeTruthy();
  expect(row("draft:src/a.ts:2:RIGHT").getByTitle("2 messages with the agent")).toBeTruthy();
  expect(list.getByRole("button", { name: /^Draft · not submitted · src\/a\.ts:2 · Blocking · 2 messages with the agent$/ })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "i" });
  const pill = within(await code(slot, "src/a.ts").findByRole("group", { name: "GitHub thread on src/a.ts:2, folded" }));
  // After its state, and on a phone ahead of its first line: CSS shows one of the two.
  expect(pill.getAllByText("Agent reply draft · not sent")).toHaveLength(2);
  slot.lifecycle.unmount();
});

test("GitHub threads show at their lines with every message; a resolved one folds; outdated and file comments wait in the file's fold", async () => {
  const { slot } = await renderWorkspace();
  const open = await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  expect(open.closest("[data-annotation]")!.getAttribute("data-annotation")).toBe("additions:2");
  // Where it is, in words as well as GitHub's mark, as every draft card says "not submitted".
  expect(within(open).getByText("On GitHub")).toBeTruthy();
  expect(within(open).getByText("It's a constant.")).toBeTruthy();
  expect(within(open).getByText("@alice")).toBeTruthy();
  expect(within(open).getByText("Author replied")).toBeTruthy();
  expect(within(open).getByText("Partial")).toBeTruthy();
  const resolved = code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2 (old line)" });
  expect(within(resolved).getByText("Resolved")).toBeTruthy();
  // Folded to who resolved it and its first line, without its actions.
  expect(within(resolved).getByText(/^Resolved by @bob/)).toBeTruthy();
  expect(within(resolved).queryByRole("button", { name: "Reply" })).toBeNull();
  fireEvent.click(within(resolved).getByRole("button", { name: "Show" }));
  expect(within(resolved).getByRole("button", { name: "Reply" })).toBeTruthy();
  expect(within(resolved).getByRole("button", { name: "Unresolve" })).toBeTruthy();
  const fold = code(slot, "src/a.ts").getByRole("button", { name: "Outdated (1)" });
  expect(code(slot, "src/a.ts").queryByText("This moved.")).toBeNull();
  fireEvent.click(fold);
  expect(code(slot, "src/a.ts").getByText("This moved.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Next: Caching/ }));
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy());
  fireEvent.click(await code(slot, "src/b.ts").findByRole("button", { name: "File comments (1)" }));
  expect(code(slot, "src/b.ts").getByText("Document this file.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a card shows the latest two replies and a long message's start until asked; Show the fix and ⋯ Open on GitHub go there", async () => {
  const long = `**Blocking:** ${"Why upper case here, when nothing else is? ".repeat(8)}`;
  const { slot } = await renderWorkspace({ rpc: {
    getReviewThreads: () => ({ threads: [{ ...threads()[0], comments: [said("c1", 111, "me", long, 48), said("c2", 112, "alice", "It's a constant.", 5), said("c6", 116, "me", "Is it?", 4), said("c7", 117, "alice", "Yes, see the fix.", 3)] }, ...threads().slice(1)] }),
    getFeedback: () => ({ feedback: feedbackOf([mine({ assessment: { ...mine().assessment!, file: "src/b.ts", line: 1 } })]) }),
  } });
  const card = within(await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" }));
  const touch = expect.arrayContaining(TOUCH_CONTROL.split(" "));
  expect(card.queryByText("It's a constant.")).toBeNull();
  const earlier = card.getByRole("button", { name: "Show 1 earlier reply" });
  expect(earlier.className.split(" ")).toEqual(touch);
  fireEvent.click(earlier);
  expect(card.getByText("It's a constant.")).toBeTruthy();
  const more = card.getByRole("button", { name: "More" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(more.className.split(" ")).toEqual(touch);
  fireEvent.click(more);
  expect(card.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(card.getByRole("button", { name: "More on the thread on src/a.ts:2" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Open on GitHub" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "https://github.com/acme/web/pull/42#discussion_r111" });
  // The agent's check found the fix in another chapter.
  fireEvent.click(card.getByRole("button", { name: /^Show the fix/ }));
  await waitFor(() => expect(slot.container.querySelector('[data-file="src/b.ts"]')).toBeTruthy());
  slot.lifecycle.unmount();
});

test("a thread card hidden in the code keeps one plain line: who resolved it, its replies, and who said what first", async () => {
  const { slot } = await renderWorkspace();
  const line = (card: HTMLElement) => card.querySelector("p.truncate")?.textContent;
  const yours = await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  fireEvent.click(within(yours).getByRole("button", { name: "Hide" }));
  expect(line(yours)).toBe("1 reply · You: Blocking: Why upper case?");
  expect(line(code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2 (old line)" }))).toBe("Resolved by @bob · @bob: Old line note.");
  fireEvent.click(code(slot, "src/a.ts").getByRole("button", { name: "Outdated (1)" }));
  const daves = code(slot, "src/a.ts").getAllByRole("article").find((card) => within(card).queryByText("This moved."))!;
  fireEvent.click(within(daves).getByRole("button", { name: "Hide" }));
  expect(line(daves)).toBe("@dave: This moved.");
  slot.lifecycle.unmount();
});

test("leaving a review forgets the comment last gone to, so reopening it doesn't open its fold again", async () => {
  let { slot } = await renderWorkspace();
  const list = await openComments(slot);
  fireEvent.click(list.getByRole("button", { name: "1 resolved · 1 outdated" }));
  fireEvent.click(list.getByRole("button", { name: /^@dave · / }));
  await waitFor(() => expect(code(slot, "src/a.ts").getByText("This moved.")).toBeTruthy());
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace());
  await openComments(slot);
  expect(code(slot, "src/a.ts").getByRole("button", { name: "Outdated (1)" }).getAttribute("aria-expanded")).toBe("false");
  slot.lifecycle.unmount();
});

test("Reply posts now: on your thread through your feedback, on someone else's as a reply; both read again after", async () => {
  const { slot, rpc } = await renderWorkspace();
  const card = await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  // Your thread has the agent's drafted reply.
  fireEvent.click(within(card).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(rpc.replyToFeedback).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1", body: "Thanks, I'll look again." }));
  await waitFor(() => expect(rpc.getReviewThreads).toHaveBeenCalledTimes(2));
  fireEvent.click(within(code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2 (old line)" })).getByRole("button", { name: "Show" }));
  const bobs = code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2 (old line)" });
  fireEvent.click(within(bobs).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(bobs).getByRole("textbox", { name: "Reply on src/a.ts:2 (old line)" }), { target: { value: "Agreed." } });
  fireEvent.click(within(bobs).getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(rpc.replyToThread).toHaveBeenCalledWith({ targetKey: "pr-42", inReplyTo: 113, body: "Agreed.", threadId: "t2" }));
  await waitFor(() => expect(rpc.getReviewThreads).toHaveBeenCalledTimes(3));
  slot.lifecycle.unmount();
});

test("a resolve in the code shows in the list at once, and one in the list in the code: they read the same threads", async () => {
  let resolved = false;
  const { slot, rpc } = await renderWorkspace({ rpc: {
    getReviewThreads: vi.fn(() => ({ threads: threads().map((thread) => thread.id === "t1" ? { ...thread, isResolved: resolved } : thread) })),
    resolveThread: vi.fn(() => { resolved = true; return { ok: true }; }),
    unresolveThread: vi.fn(() => { resolved = false; return { ok: true }; }),
  } });
  const list = await openComments(slot);
  fireEvent.click(within(code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2" })).getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(rpc.resolveThread).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1" }));
  // Yours: your feedback is read from GitHub again too.
  await waitFor(() => expect(rpc.refreshFeedback).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  await list.findByRole("button", { name: "2 resolved · 1 outdated" });
  fireEvent.click(list.getByRole("button", { name: "2 resolved · 1 outdated" }));
  fireEvent.click(list.getByRole("button", { name: /^Expand GitHub thread on src\/a\.ts:2$/ }));
  fireEvent.click(within(list.getByRole("article", { name: "GitHub thread on src/a.ts:2" })).getByRole("button", { name: "Unresolve" }));
  await waitFor(() => expect(rpc.unresolveThread).toHaveBeenCalledWith({ targetKey: "pr-42", threadId: "t1" }));
  await waitFor(() => expect(within(code(slot, "src/a.ts").getByRole("article", { name: "GitHub thread on src/a.ts:2" })).queryByText("Resolved")).toBeNull());
  slot.lifecycle.unmount();
});

test("the check strip says what the agent checked, when, and how much is addressed; Check again and ↻ ask again", async () => {
  const { slot, rpc } = await renderWorkspace();
  const list = await openComments(slot);
  const strip = list.getByRole("status", { name: "" });
  expect(strip.textContent).toContain("Agent’s check·abcdef1·2h0 of 1 addressed");
  // How much is addressed starts its own line, with no dot left at the end of the first.
  expect(within(strip).getByText("0 of 1 addressed").parentElement!.className).toContain("basis-full");
  expect(within(strip).getByText("older commit")).toBeTruthy();
  fireEvent.click(within(strip).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(rpc.checkFeedback).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  fireEvent.click(slot.getByRole("button", { name: "Refresh comments" }));
  await waitFor(() => expect(rpc.refreshFeedback).toHaveBeenCalledWith({ targetKey: "pr-42" }));
  expect(rpc.getReviewThreads).toHaveBeenCalledTimes(2);
  // The server says your threads changed: read again.
  await slot.emitRealtime("feedback:pr-42", {});
  await waitFor(() => expect(rpc.getFeedback).toHaveBeenCalledTimes(2));
  slot.lifecycle.unmount();
});

test("when GitHub can't be read the list says so, apart from having no threads, and still shows what it has", async () => {
  let { slot } = await renderWorkspace({ rpc: { getReviewThreads: () => ({ threads: [], error: "HTTP 502: Bad Gateway" }) } });
  let list = await openComments(slot);
  expect(list.getByText("Couldn’t load review threads.")).toBeTruthy();
  expect(list.getByText("HTTP 502: Bad Gateway")).toBeTruthy();
  // Your thread, as your feedback last read it.
  expect(list.getByRole("button", { name: /^You · Author replied · src\/a\.ts:2/ })).toBeTruthy();
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ rpc: { getReviewThreads: () => ({ threads: threads().slice(0, 1), error: "gh timed out after 120s" }) } }));
  list = await openComments(slot);
  expect(list.getByText("Couldn’t load every thread: gh timed out after 120s")).toBeTruthy();
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ rpc: { getReviewThreads: () => ({ threads: [] }), getFeedback: () => ({ feedback: feedbackOf([], null) }), getReplyDrafts: () => ({ drafts: [] }) } }));
  list = await openComments(slot);
  fireEvent.click(chip(list, "On GitHub"));
  expect(list.getByText("Nothing on GitHub yet.")).toBeTruthy();
  expect(list.queryByText(/Couldn’t load/)).toBeNull();
  slot.lifecycle.unmount();
});

test("⋯ Comment options: hide nits, show resolved threads, add a comment by line, and the PR on GitHub", async () => {
  const { slot } = await renderWorkspace();
  const list = await openComments(slot);
  const options = async () => { fireEvent.click(slot.getByRole("button", { name: "Comment options" })); return within(await slot.findByRole("dialog")); };
  let menu = await options();
  fireEvent.click(menu.getByRole("switch", { name: "Hide nits" }));
  await waitFor(() => expect(list.queryByRole("button", { name: /src\/b\.ts:1 · Nit/ })).toBeNull());
  expect(list.getByText("1 blocking · 1 nit · 1 hidden")).toBeTruthy();
  fireEvent.click(menu.getByRole("switch", { name: "Show resolved threads" }));
  expect(list.getByRole("button", { name: "@bob · Resolved · src/a.ts:2 (old line)" })).toBeTruthy();
  fireEvent.click(menu.getByRole("button", { name: "Open PR on GitHub" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "https://github.com/acme/web/pull/42" });
  menu = await options();
  fireEvent.click(menu.getByRole("button", { name: "Add comment by line…" }));
  const form = within(list.getByRole("region", { name: "New comment" }));
  expect((form.getByRole("combobox", { name: "Comment file" }) as HTMLSelectElement).value).toBe("src/a.ts");
  expect(form.getByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  // The box's controls are 44px on any touch screen, an iPad's included.
  const touch = expect.arrayContaining(TOUCH_CONTROL.split(" "));
  for (const control of [form.getByRole("combobox", { name: "Severity" }), form.getByRole("button", { name: "Cancel" }), form.getByRole("button", { name: "Ask agent" }), form.getByRole("button", { name: "Add to draft" })]) {
    expect(control.className.split(" ")).toEqual(touch);
  }
  slot.lifecycle.unmount();
});

test("Hide nits never hides a nit that needs you, and Not submitted keeps its heading saying how many it hides", async () => {
  const draftOf = (nits: Array<Record<string, unknown>>, stale: Array<Record<string, unknown>> = []) => () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: nits }, stale, discussions: [] });
  let { slot } = await renderWorkspace({ rpc: { getDraft: draftOf([
    { file: "src/a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Name it." },
    { file: "src/b.ts", line: 1, side: "RIGHT", author: "agent", severity: "nit", body: "Spacing." },
  ]) } });
  let list = await openComments(slot);
  fireEvent.click(slot.getByRole("button", { name: "Comment options" }));
  fireEvent.click(within(await slot.findByRole("dialog")).getByRole("switch", { name: "Hide nits" }));
  await waitFor(() => expect(list.queryByRole("button", { name: /src\/b\.ts:1/ })).toBeNull());
  expect(headings(list)).toContainEqual(expect.stringMatching(/^Not submitted/));
  expect(list.getByText("2 nits · 2 hidden")).toBeTruthy();
  fireEvent.click(chip(list, "Not submitted"));
  expect(list.queryByText("No comments to submit yet.")).toBeNull();
  expect(list.getByText("2 nits · 2 hidden")).toBeTruthy();
  slot.lifecycle.unmount();
  // A nit on an older diff holds Submit, so it stays: in Needs you, and in the code.
  ({ slot } = await renderWorkspace({ rpc: {
    getDraft: draftOf([{ file: "src/a.ts", line: 1, side: "RIGHT", severity: "nit", body: "Drafted before the last push." }], [{ file: "src/a.ts", line: 1, side: "RIGHT" }]),
    getFeedback: () => ({ feedback: feedbackOf([]) }),
    getReplyDrafts: () => ({ drafts: [] }),
  } }));
  list = await openComments(slot);
  expect(chip(list, "Needs you").getAttribute("aria-label")).toBe("Needs you, 1");
  fireEvent.click(chip(list, "Needs you"));
  expect(list.queryByText("Nothing needs you.")).toBeNull();
  expect(rows(list)).toEqual([expect.stringMatching(/^Older diff · not submitted · src\/a\.ts:1/)]);
  expect(code(slot, "src/a.ts").getByText("Drafted before the last push.")).toBeTruthy();
  expect(list.queryByText(/hidden/)).toBeNull();
  slot.lifecycle.unmount();
});

test("with Hide nits on, a nit on an older diff counts wherever comments are counted: the file's row, All files and the chapter's end", async () => {
  setHideNits(true);
  const { slot } = await renderWorkspace({ rpc: {
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [
      { file: "src/a.ts", line: 1, side: "RIGHT", severity: "nit", body: "Drafted before the last push." },
      { file: "src/a.ts", line: 2, side: "RIGHT", severity: "nit", body: "Name it." },
    ] }, stale: [{ file: "src/a.ts", line: 1, side: "RIGHT" }], discussions: [] }),
    getReviewThreads: () => ({ threads: [] }),
    getFeedback: () => ({ feedback: feedbackOf([]) }),
    getReplyDrafts: () => ({ drafts: [] }),
  } });
  // The older diff's nit holds Submit, so it shows and counts; the other nit is hidden and doesn't.
  await code(slot, "src/a.ts").findByText("Drafted before the last push.");
  expect(code(slot, "src/a.ts").queryByText("Name it.")).toBeNull();
  expect(within(slot.container.querySelector<HTMLElement>('[data-file="src/a.ts"] [data-file-header]')!).getByText("1 not submitted")).toBeTruthy();
  expect(within(slot.getByRole("main")).getByText("1 comment")).toBeTruthy();
  const nav = within(slot.getByRole("navigation", { name: "Chapters" }).parentElement!);
  fireEvent.click(nav.getByRole("button", { name: "All files" }));
  expect(within((await slot.findByRole("list", { name: "All files" })).querySelector<HTMLElement>('[title="src/a.ts"]')!.closest("li")!).getByText("1 draft comment")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("on a touch screen, which has no + beside a line, the empty list says to tap a line", async () => {
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList);
  try {
    const { slot } = await renderWorkspace({ rpc: { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }), getReviewThreads: () => ({ threads: [] }), getFeedback: () => ({ feedback: feedbackOf([], null) }), getReplyDrafts: () => ({ drafts: [] }) } });
    const list = await openComments(slot);
    expect(list.getByText("No comments yet. Tap a line to comment.")).toBeTruthy();
    slot.lifecycle.unmount();
  } finally {
    matchMedia.mockRestore();
  }
});

test("empty states: no comments yet; nothing needs you, with Show all; a local review's comments stay in BB", async () => {
  const none = { getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] }, stale: [] }), getReviewThreads: () => ({ threads: [] }), getFeedback: () => ({ feedback: feedbackOf([], null) }), getReplyDrafts: () => ({ drafts: [] }) };
  let { slot } = await renderWorkspace({ rpc: none });
  let list = await openComments(slot);
  expect(list.getByText("No comments yet. Select a line, or tap + beside one, to comment.")).toBeTruthy();
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ rpc: { getFeedback: () => ({ feedback: feedbackOf([], null) }), getReplyDrafts: () => ({ drafts: [] }), getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: comments.slice(0, 1) }, stale: [] }) } }));
  list = await openComments(slot);
  fireEvent.click(chip(list, "Needs you"));
  expect(list.getByText("Nothing needs you.")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Show all" }));
  expect(chip(list, "All").getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
  ({ slot } = await renderWorkspace({ review: { kind: "ref" }, rpc: none }));
  list = await openComments(slot);
  expect(list.getByText("Comments on a local review stay in BB.")).toBeTruthy();
  expect(list.queryByRole("radio")).toBeNull();
  slot.lifecycle.unmount();
});

test("the Finish bar says the verdict and how many go, and opens Finish review", async () => {
  const { slot } = await renderWorkspace();
  await openComments(slot);
  const bar = slot.getByRole("button", { name: "Finish review" }).parentElement!;
  expect(bar.textContent).toContain("Comment · 3 to send");
  fireEvent.click(slot.getByRole("button", { name: "Finish review" }));
  await slot.findByRole("heading", { name: "Finish review" });
  // A merged PR has nothing to finish.
  slot.lifecycle.unmount();
  const merged = await renderWorkspace({ review: { prState: "MERGED", archivedAt: 1 } });
  await openComments(merged.slot);
  expect(merged.slot.queryByRole("button", { name: "Finish review" })).toBeNull();
  merged.slot.lifecycle.unmount();
});

test("while you write in the code, the list says where, and Show in diff goes back there", async () => {
  const { slot } = await renderWorkspace();
  const list = await openComments(slot);
  fireEvent.click(within(code(slot, "src/a.ts").getByRole("article", { name: "Draft comment on src/a.ts:2" })).getByRole("button", { name: "Edit" }));
  expect(list.getByText("Writing a comment on src/a.ts:2")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Show in diff" }));
  expect(code(slot, "src/a.ts").getByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("an ask from your review summary has no place in the code: its row opens it in place", async () => {
  const ask: FeedbackItem = { id: "summary:1", kind: "summary", title: "Make the TTL configurable", thread: null, replyDraft: null, assessment: { id: "summary:1", verdict: "disputed", evidence: "The author says a constant is enough.", assessedAt: now } };
  const { slot } = await renderWorkspace({ rpc: { getFeedback: () => ({ feedback: feedbackOf([mine(), ask]) }) } });
  const list = await openComments(slot);
  fireEvent.click(list.getByRole("button", { name: "From your review summary · the PR · agent's check: Author disagrees" }));
  expect(within(list.getByRole("article", { name: "Make the TTL configurable" })).getByText("The author says a constant is enough.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("GitHub threads in code off hides them there; showing one from the list turns them on again", async () => {
  const { slot } = await renderWorkspace();
  await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" });
  // Diff options' switch, from the band.
  const threadsInCode = async () => {
    fireEvent.click(within(slot.getByRole("main")).getByRole("button", { name: "Diff options" }));
    return slot.findByRole("switch", { name: "GitHub threads in code" });
  };
  fireEvent.click(await threadsInCode());
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(code(slot, "src/a.ts").queryByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeNull());
  const list = await openComments(slot);
  fireEvent.click(list.getByRole("button", { name: /^You · Author replied · src\/a\.ts:2/ }));
  expect(await code(slot, "src/a.ts").findByRole("article", { name: "GitHub thread on src/a.ts:2" })).toBeTruthy();
  expect((await threadsInCode()).getAttribute("aria-checked")).toBe("true");
  slot.lifecycle.unmount();
});
