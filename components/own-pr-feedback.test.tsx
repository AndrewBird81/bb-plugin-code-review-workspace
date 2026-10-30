// @vitest-environment jsdom
// Feedback on your own PR on its page: a teammate's Request changes with only a summary is an item in Comments, who
// wrote it said, with Send, which with no thread working on the PR offers a fresh thread or a fork of the one that wrote
// it; Send for all that wait; Not pushed yet, from the compare menu, its page; and Branch kept.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import { panelTabCalls, renderPanelTab } from "./panel-tabs.test-support";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });
Element.prototype.scrollIntoView ??= () => {};

const now = Date.now();
const SHA = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Guide", intent: "Retries uploads.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Retry", overview: "Retries.", diffs: [{ file: "src/a.ts" }] }] };
const dana = { id: "PRR_9", kind: "review", author: "dana", bot: false, state: "CHANGES_REQUESTED", body: "Can you add tests?", at: now - 3_600_000, url: "https://github.com/acme/web/pull/12#pullrequestreview-9", waiting: true };
const bob = { id: "IC_4", kind: "comment", author: "bob", bot: false, body: "Does this need a flag?", at: now - 7_200_000, url: null, waiting: true };
/** Your own PR acme/web#12, with no thread working on it, and Dana's and Bob's words waiting for you. */
const ownPr = {
  targetKey: "pr-12", kind: "pr", status: "ready", createdAt: 1, title: "Retry uploads", repo: "acme/web", number: 12, headSha: SHA, url: "https://github.com/acme/web/pull/12",
  author: "me", ownPr: true, projectId: "p1", prConversation: [dana, bob],
};

function handlers(review: Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  return {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: review.targetKey, verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getSourceThread: () => ({ thread: null }),
    getReviewThreads: () => ({ threads: [] }),
    getFeedback: () => ({ feedback: { baseline: null, head: SHA, fetchedAt: now, suggestionInDraft: false, run: null, items: [] } }),
    refreshFeedback: () => ({ feedback: { baseline: null, head: SHA, fetchedAt: now, suggestionInDraft: false, run: null, items: [] } }),
    getReplyDrafts: () => ({ drafts: [] }),
    getPrCommits: () => ({ commits: [] }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
}

async function renderReview(review: Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  patchReviewState(review.targetKey as string, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const calls = handlers(review, rpc);
  // BB's panel takes the tabs the page opens.
  const page = renderSlot(app.navPanels[0]!, { subPath: review.targetKey as string }, { rpc: calls as any, sidebarThreads: { threads: [] } as any, experimental_panel: { openTab: () => true } });
  await page.findByTestId("filediff");
  return { app, page, rpc: calls };
}
type Page = Awaited<ReturnType<typeof renderReview>>["page"];
async function openComments(page: Page) {
  fireEvent.click(await page.findByRole("button", { name: /^Comments/ }));
  const list = within(await page.findByRole("region", { name: "Comments" }));
  await waitFor(() => expect(list.queryByText("Reading GitHub…")).toBeNull());
  return list;
}

test("a teammate's Request changes with only a summary waits in Needs you, once, saying whose it is, and Send offers a fresh thread or a fork", async () => {
  const sendNow = vi.fn(async (input: any) => input.thread === "fork"
    ? { ok: true, sent: { id: "c1", sendN: 1, threadId: "forked", title: "Fixes for web#12 · Retry uploads", delivery: "sent" } }
    : { ok: false, warning: "Retry uploads is archived. Send starts a fresh thread…", offers: ["fresh", "fork", "unarchive"], freshWhere: "in a new worktree at 1f2e3d4 on MaxBook", forkFrom: "Retry uploads",
      choice: { why: "archived", thread: "Retry uploads", machine: "MaxBook" } });
  const { page } = await renderReview(ownPr, { sendNow });
  const list = await openComments(page);
  expect(list.getByRole("heading", { name: "Needs you · 2" })).toBeTruthy();
  const row = list.getByRole("button", { name: "Needs your reply to @dana · the PR · Requested changes" });
  expect(row.textContent).toContain("Can you add tests?");
  fireEvent.click(list.getByRole("button", { name: "Expand GitHub review summary on the PR" }));
  const card = within(list.getByRole("article", { name: "GitHub review summary on the PR" }));
  expect(card.getByText("@dana")).toBeTruthy();
  expect(card.getByText("Requested changes")).toBeTruthy();
  // A summary has no reply box or Resolve of its own: the review agent drafts the reply.
  expect(card.queryByRole("button", { name: "Reply" })).toBeNull();
  expect(card.queryByRole("button", { name: /Resolve/ })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Send @dana’s review to a fresh thread" }));
  // A choice, not a warning: where it goes, each place said in a line, the fresh thread first and focused.
  const choice = await card.findByRole("group", { name: "Retry uploads is archived. Where should @dana’s review go?" });
  expect(card.queryByRole("alert")).toBeNull();
  const buttons = within(choice).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Start a fresh thread", "Fork the original instead", "Unarchive and send", "Cancel"]);
  await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
  const said = (name: string) => document.getElementById(within(choice).getByRole("button", { name }).getAttribute("aria-describedby")!)!.textContent;
  expect(said("Start a fresh thread")).toBe("A new thread on MaxBook, told about the PR and @dana’s review.");
  expect(said("Fork the original instead")).toBe("Keeps everything Retry uploads knew. Costs more: it copies the whole chat.");
  expect(said("Unarchive and send")).toBe("Picks up the old thread where it stopped.");
  // One Send at a time: the card's own gives way while the choice is open.
  expect(card.queryByRole("button", { name: /^Send @dana’s review/ })).toBeNull();
  fireEvent.click(within(choice).getByRole("button", { name: "Fork the original instead" }));
  await waitFor(() => expect(sendNow).toHaveBeenLastCalledWith({ targetKey: "pr-12", comment: { threadId: "PRR_9" }, force: true, thread: "fork" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent @dana’s review to Fixes for web#12 · Retry uploads.", expect.objectContaining({ action: expect.objectContaining({ label: "Watch" }) })));
  page.lifecycle.unmount();
});

test("Send in Needs you takes everything on GitHub waiting for you, and a sent one says where it went", async () => {
  const sendToSourceThread = vi.fn(async () => ({ ok: true, delivery: "queued", title: "Fixes for web#12", threadId: "fresh", sendN: 2 }));
  const sent = { ...ownPr, threadSends: { IC_4: { id: "c3", sendN: 1 } }, sends: [{ n: 1, at: now, threadId: "fresh", ids: ["c3"] }], sent: { at: now, threadId: "fresh", title: "Fixes for web#12", comments: [] }, mainThread: { threadId: "fresh", environmentId: "env_fix", origin: "fresh", since: 1 } };
  const { page } = await renderReview(sent, { sendToSourceThread, getSourceThread: () => ({ thread: { threadId: "fresh", title: "Fixes for web#12", state: "open", machine: "MaxBook" } }) });
  const list = await openComments(page);
  // Bob's went in Send 1; only Dana's is left to send.
  const bobs = list.getByRole("button", { name: /^Needs your reply to @bob · the PR · Comment on the PR · Sent to Fixes for web#12 · Send 1/ });
  expect(bobs.textContent).toContain("Sent to Fixes for web#12 · Send 1 · ");
  const send = await list.findByRole("button", { name: "Send @dana’s review to main thread" });
  expect(document.getElementById(send.getAttribute("aria-describedby")!)!.textContent).toBe("Fixes for web#12 · MaxBook");
  fireEvent.click(send);
  await waitFor(() => expect(sendToSourceThread).toHaveBeenCalledWith({ targetKey: "pr-12", comments: [], threads: ["PRR_9"] }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Queued for Fixes for web#12: it’s busy, and gets @dana’s review when its turn ends.", expect.objectContaining({ action: expect.objectContaining({ label: "Watch" }) })));
  page.lifecycle.unmount();
});

test("Not pushed yet, from the compare menu, opens its page after the chapters, not the Main thread tab, which has the chat alone", async () => {
  const getNotPushed = vi.fn(async () => ({ state: "available", patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n aa\n+retry()\n", base: SHA, branch: "bb/fixes-thr_x", machine: "MaxBook", threadId: "fresh", hidden: [{ path: ".env", reason: "secret" }], notice: null }));
  const fixer = { ...ownPr, mainThread: { threadId: "fresh", environmentId: "env_fix", origin: "fresh", since: 1, branch: "bb/fixes-thr_x" } };
  const { app, page, rpc } = await renderReview(fixer, { getNotPushed, getSourceThread: () => ({ thread: { threadId: "fresh", title: "Fixes for web#12", state: "open", machine: "MaxBook" } }) });
  fireEvent.click(await page.findByRole("button", { name: /^Show changes: / }));
  const menu = within(await page.findByRole("menu", { name: "Show changes" }));
  const item = await menu.findByRole("menuitem", { name: /^Not pushed yet/ });
  // A fixer's folder, not the review's own, whose machine the review knows.
  expect(item.textContent).toBe("Not pushed yetIn the main thread’s folder");
  fireEvent.click(item);
  const view = within(await page.findByRole("region", { name: "Not pushed yet" }));
  expect(await view.findByRole("heading", { name: "1 file on MaxBook isn’t on GitHub yet" })).toBeTruthy();
  expect(getNotPushed).toHaveBeenCalledWith({ targetKey: "pr-12" });
  expect(view.getByText("1 file that looks like a secret, or is binary or too large, isn’t shown.")).toBeTruthy();
  expect(view.getByRole("region", { name: "src/a.ts" })).toBeTruthy();
  expect(panelTabCalls(page)).toEqual([]);
  // The Main thread tab is the thread's chat, with no Not pushed yet of its own.
  const slot = renderPanelTab(app, "main", "pr-12", { rpc: rpc as any, sidebarThreads: { threads: [] } as any });
  const tab = within(await slot.findByRole("region", { name: "Main thread" }));
  await tab.findByText("Fixes for web#12");
  expect(tab.queryByRole("tab", { name: "Not pushed yet" })).toBeNull();
  expect(tab.queryByRole("tabpanel", { name: "Not pushed yet" })).toBeNull();
  slot.lifecycle.unmount();
  page.lifecycle.unmount();
});

test("with Send to thread off, Not pushed yet still opens from the compare menu, and there's no Main thread tab", async () => {
  const getNotPushed = vi.fn(async () => ({ state: "none", message: "Nothing waiting." }));
  const fixer = { ...ownPr, mainThread: { threadId: "fresh", environmentId: "env_fix", origin: "fresh", since: 1, branch: "bb/fixes-thr_x" } };
  const off = { getPreferences: () => ({ preferences: { ...defaultPreferences, knobs: { ...defaultPreferences.knobs, sendToThread: false } }, revision: 0 }) };
  const { app, page } = await renderReview(fixer, { getNotPushed, ...off });
  fireEvent.click(await page.findByRole("button", { name: /^Show changes: / }));
  fireEvent.click(await within(await page.findByRole("menu", { name: "Show changes" })).findByRole("menuitem", { name: /^Not pushed yet/ }));
  expect(within(await page.findByRole("region", { name: "Not pushed yet" })).getByText("Nothing waiting.")).toBeTruthy();
  expect(panelTabCalls(page)).toEqual([]);
  const tab = app.tabs.find((registration) => registration.id === "main")!;
  const probe = renderSlot({ component: () => <p>{String(tab.useVisible!({ subPath: "pr-12" } as never))}</p> }, {}, {});
  expect(probe.container.textContent).toBe("false");
  page.lifecycle.unmount();
});

test("a PR without a folder working on it has no Not pushed yet", async () => {
  const { page } = await renderReview(ownPr);
  // Nothing to compare with: the menu is in Diff options.
  expect(page.queryByRole("button", { name: /^Show changes: / })).toBeNull();
  fireEvent.click(await page.findByRole("button", { name: "Diff options" }));
  fireEvent.click(await page.findByRole("button", { name: "Compare with a commit…" }));
  const menu = within(await page.findByRole("menu", { name: "Show changes" }));
  expect(menu.queryByRole("menuitem", { name: /^Not pushed yet/ })).toBeNull();
  page.lifecycle.unmount();
});

test("Branch kept names a removed fixer's branch, with its delete command to copy, until Got it", async () => {
  const dismissKeptBranch = vi.fn(async () => ({ ok: true }));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { page } = await renderReview({ ...ownPr, keptBranches: [{ branch: "bb/fixes-thr_x", machine: "MaxBook", path: "/Users/me/src/web", at: now }] }, { dismissKeptBranch });
  const notice = await page.findByRole("status", { name: "Branch kept" });
  // Where it is, and what -D throws away.
  expect(notice.textContent).toContain("Branch kept: bb/fixes-thr_x on MaxBook. The fixer’s folder is gone, but its branch is still in ~/src/web. To delete it, run git branch -D bb/fixes-thr_x. This also deletes any commits on it that aren’t on GitHub.");
  fireEvent.click(within(notice).getByRole("button", { name: "Copy git branch -D bb/fixes-thr_x" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("git branch -D bb/fixes-thr_x"));
  fireEvent.click(within(notice).getByRole("button", { name: "Got it: bb/fixes-thr_x" }));
  await waitFor(() => expect(dismissKeptBranch).toHaveBeenCalledWith({ targetKey: "pr-12", branch: "bb/fixes-thr_x" }));
  page.lifecycle.unmount();
});

test("with no thread working on the PR, the choice says so in its own words; someone else's PR is said first, as a warning", async () => {
  const { render } = await import("@testing-library/react");
  const { SendWarning } = await import("./SendNow");
  const onChoose = vi.fn();
  const view = render(<SendWarning what="the comment" busy={false} onChoose={onChoose} onCancel={() => {}}
    warned={{ warning: "…", offers: ["fresh"], choice: { why: "none", thread: null, machine: null, note: "This is @per’s PR, not yours. Your review on GitHub stays as it is." } }} />);
  const choice = view.getByRole("group", { name: "No thread is working on this PR. Where should the comment go?" });
  expect(within(choice).getByText("This is @per’s PR, not yours. Your review on GitHub stays as it is.")).toBeTruthy();
  expect(within(choice).getByText("A new thread, told about the PR and the comment.")).toBeTruthy();
  fireEvent.click(within(choice).getByRole("button", { name: "Start a fresh thread" }));
  expect(onChoose).toHaveBeenCalledWith({ force: true, thread: "fresh" });
  view.rerender(<SendWarning what="3 comments" busy={false} onChoose={onChoose} onCancel={() => {}} warned={{ warning: "…", offers: ["fresh"], choice: { why: "none", thread: null, machine: "MaxBook" } }} />);
  expect(view.getByRole("group", { name: "No thread is working on this PR. Where should these 3 comments go?" })).toBeTruthy();
  expect(view.getByText("A new thread on MaxBook, told about the PR and these 3 comments.")).toBeTruthy();
});
