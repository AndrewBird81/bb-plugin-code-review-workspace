// @vitest-environment jsdom
// Not pushed yet, the review's page after its chapters on a PR whose main thread works in a folder: what the folder has
// that the PR's head doesn't, in the review's diff, with Refresh; a new line takes a LOCAL comment there, a removed one
// the PR's head still has a comment in the PR's diff, and one outside it says where to comment instead.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, Toaster: () => null }));
// The diff's annotations, and a gutter "+" for each of a file's lines a test clicks, not pierre's internals.
const GUTTERS = [{ label: "+ new line 1", range: { start: 1, end: 1, side: "additions" } }, { label: "+ removed line 1", range: { start: 1, end: 1, side: "deletions" } }, { label: "+ removed line 5", range: { start: 5, end: 5, side: "deletions" } }];
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ options, lineAnnotations, renderAnnotation }: any) => <div data-testid="filediff">
    {lineAnnotations?.map((annotation: any, index: number) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}
    {GUTTERS.map(({ label, range }) => <button key={label} onClick={() => options.onGutterUtilityClick(range)}>{label}</button>)}
  </div>,
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });
Element.prototype.scrollIntoView ??= () => {};

const now = Date.now();
const SHA = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
// The PR changes src/a.ts's first line; the folder changes it again, and its fifth, which the PR doesn't.
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const folder = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-aa\n+ab\n@@ -5 +5 @@\n-e\n+f\n";
const guide = { title: "Guide", intent: "Retries uploads.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Retry", overview: "Retries.", diffs: [{ file: "src/a.ts" }] }] };
/** Your own PR acme/web#12, its main thread a fixer in a folder on MaxBook. */
const review = {
  targetKey: "pr-12", kind: "pr", status: "ready", createdAt: 1, title: "Retry uploads", repo: "acme/web", number: 12, headSha: SHA, url: "https://github.com/acme/web/pull/12",
  author: "me", ownPr: true, projectId: "p1", mainThread: { threadId: "fresh", environmentId: "env_fix", origin: "fresh", since: 1, branch: "bb/fixes-thr_x" },
};
const available = { state: "available", patch: folder, base: SHA, branch: "bb/fixes-thr_x", machine: "MaxBook", threadId: "fresh", hidden: [], notice: null };

async function renderReview(rpc: Record<string, unknown> = {}, activeId = "c1", comments: any[] = []) {
  patchReviewState(review.targetKey, { activeId });
  const app = await loadPluginApp(() => import("../app"));
  let stored = { targetKey: review.targetKey, verdict: "COMMENT", body: "", comments };
  const calls = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review, guide: structuredClone(guide), patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: structuredClone(stored), stale: [] }),
    saveDraftComment: vi.fn(async ({ comment }: any) => { stored = { ...stored, comments: [...stored.comments, comment] }; return { draft: structuredClone(stored), stale: [] }; }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getSourceThread: () => ({ thread: { threadId: "fresh", title: "Fixes for web#12", state: "open", machine: "MaxBook" } }),
    getReviewThreads: () => ({ threads: [] }),
    getFeedback: () => ({ feedback: { baseline: null, head: SHA, fetchedAt: now, suggestionInDraft: false, run: null, items: [] } }),
    getReplyDrafts: () => ({ drafts: [] }),
    getPrCommits: () => ({ commits: [] }),
    getNotPushed: vi.fn(async () => available),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
  const page = renderSlot(app.navPanels[0]!, { subPath: review.targetKey }, { rpc: calls as any, sidebarThreads: { threads: [] } as any, experimental_panel: { openTab: () => true } });
  await page.findAllByTestId("filediff");
  return { page, rpc: calls };
}
type Page = Awaited<ReturnType<typeof renderReview>>["page"];
const notPushed = async (page: Page) => within(await page.findByRole("region", { name: "Not pushed yet" }));

test("Not pushed yet is a page after the chapters: how many files on which machine, from which branch against which commit, their diff, and Refresh", async () => {
  const { page, rpc } = await renderReview();
  fireEvent.click(page.getByRole("button", { name: "Not pushed yet" }));
  const view = await notPushed(page);
  expect(await view.findByRole("heading", { name: "1 file on MaxBook isn’t on GitHub yet" })).toBeTruthy();
  expect(view.getByText(/^Branch/).textContent).toBe("Branch bb/fixes-thr_x · compared with 1f2e3d4");
  expect(view.getByRole("region", { name: "src/a.ts" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Not pushed yet" }).getAttribute("aria-current")).toBe("page");
  expect(rpc.getNotPushed).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(rpc.getNotPushed).toHaveBeenCalledTimes(2));
  page.lifecycle.unmount();
});

test("a new line on Not pushed yet takes a LOCAL comment, which shows there", async () => {
  const { page, rpc } = await renderReview({}, "not-pushed");
  const view = await notPushed(page);
  const file = within(await view.findByRole("region", { name: "src/a.ts" }));
  fireEvent.click(file.getByRole("button", { name: "+ new line 1" }));
  fireEvent.change(await file.findByRole("textbox", { name: "Draft comment" }), { target: { value: "Retry once more." } });
  fireEvent.click(file.getByRole("button", { name: "Add to draft" }));
  await waitFor(() => expect(rpc.saveDraftComment).toHaveBeenCalledWith(expect.objectContaining({ comment: expect.objectContaining({ file: "src/a.ts", line: 1, side: "LOCAL", body: "Retry once more." }) })));
  expect(within(await file.findByRole("article", { name: "Draft comment on src/a.ts:1" })).getByText("Retry once more.")).toBeTruthy();
  page.lifecycle.unmount();
});

test("a removed line the PR's diff has takes a comment there, at the PR's line; one it doesn't says to comment in All changes", async () => {
  const { page } = await renderReview({}, "not-pushed");
  const file = within(await (await notPushed(page)).findByRole("region", { name: "src/a.ts" }));
  fireEvent.click(file.getByRole("button", { name: "+ removed line 5" }));
  expect(toast.info).toHaveBeenCalledWith("That line isn’t in the PR’s diff. Comment on it in All changes.");
  expect(page.getByRole("region", { name: "Not pushed yet" })).toBeTruthy();
  fireEvent.click(file.getByRole("button", { name: "+ removed line 1" }));
  // The PR's diff, with the comment box at its new line 1.
  await waitFor(() => expect(page.queryByRole("region", { name: "Not pushed yet" })).toBeNull());
  expect(await page.findByRole("textbox", { name: "Draft comment" })).toBeTruthy();
  expect(page.getByText("Writing a comment on src/a.ts:1")).toBeTruthy();
  page.lifecycle.unmount();
});

test("a LOCAL comment chosen in Comments opens Not pushed yet at its line", async () => {
  const local = { id: "c-local", file: "src/a.ts", line: 1, side: "LOCAL", body: "Retry once more." };
  const { page } = await renderReview({}, "c1", [local]);
  fireEvent.click(await page.findByRole("button", { name: /^Comments/ }));
  const list = within(await page.findByRole("region", { name: "Comments" }));
  const [row] = await list.findAllByRole("button", { name: /^Draft · .*src\/a\.ts:1/ });
  expect(row.textContent).toContain("Not on GitHub yet");
  fireEvent.click(row);
  const view = await notPushed(page);
  const card = await within(await view.findByRole("region", { name: "src/a.ts" })).findByRole("article", { name: "Draft comment on src/a.ts:1" });
  expect(within(card).getByText("Retry once more.")).toBeTruthy();
  expect(page.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Not pushed yet");
  page.lifecycle.unmount();
});
