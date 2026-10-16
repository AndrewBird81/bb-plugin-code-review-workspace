// @vitest-environment jsdom
import { test, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
afterEach(() => { cleanup(); localStorage.clear(); });

// jsdom can't run pierre's diff element; these tests are about the Overview.
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const url = "https://github.com/acme/web/pull/42";
const DAY = 86_400_000;
const now = Date.now();
const guide = {
  title: "Guide", intent: "Serializes token refreshes.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Refresh", overview: "One in-flight refresh.", diffs: [{ file: "src/auth.ts", summary: "Lock" }] }],
};
const twoChapters = {
  ...guide,
  sections: [
    { id: "c1", title: "Refresh", overview: "One in-flight refresh.", risk: "low", diffs: [{ file: "src/auth.ts", summary: "Lock" }] },
    { id: "c2", title: "Retry", overview: "Retries once.", risk: "high", diffs: [{ file: "src/retry.ts", summary: "Retry" }, { file: "package-lock.json" }] },
  ],
};

function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, (input: any) => unknown> = {}, sent: object = guide) {
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    getChecks: () => ({ bucket: "none", checks: [] }),
    ...rpc,
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, ...review }, guide: structuredClone(sent), patch: "", revision: "r1" }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getSinceReview: () => ({ baseline: null, files: [] }),
    getFeedback: () => ({ feedback: { baseline: { sha: "old", at: 1, verdict: "REQUEST_CHANGES" }, head: "new", fetchedAt: 1, suggestionInDraft: false, run: null, items: [] } }),
    markSeen: () => ({ ok: true }),
    snoozeReview: () => ({ ok: true }),
  } as any,
  // Like BB, the host opens the link's URL itself; otherwise the link navigates, which jsdom doesn't implement.
  openUrl: () => true }));
}
type Slot = Awaited<ReturnType<typeof renderWorkspace>>;
const main = (slot: Slot) => within(slot.getByRole("main"));

test("a PR review's title on its Overview opens the pull request on GitHub, and in a chapter the band's goes back to the Overview", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url });
  const link = await slot.findByRole("link", { name: "Fix token refresh race" });
  expect(link.getAttribute("href")).toBe(url);
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });

  fireEvent.click(slot.getByRole("button", { name: "Start reading: Refresh" }));
  await waitFor(() => expect(slot.queryByRole("heading", { name: "Fix token refresh race" })).toBeNull());
  fireEvent.click(within(slot.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Fix token refresh race" }));
  expect(await slot.findByRole("heading", { name: "Fix token refresh race" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a local review's title stays plain text", async () => {
  const slot = await renderWorkspace({ kind: "ref", gitRef: "main...feature", title: "Local change" });
  await slot.findByRole("heading", { name: "Local change" });
  expect(slot.queryByRole("link", { name: "Local change" })).toBeNull();
  // Nothing to snooze: a local review isn't anyone's turn on GitHub.
  expect(slot.queryByRole("button", { name: "Snooze" })).toBeNull();
  slot.lifecycle.unmount();
});

test("the Overview shows the PR's stack, opens or starts its neighbours, and says when the PR below wasn't reviewed", async () => {
  const member = (number: number, extra: Record<string, unknown> = {}) => ({ targetKey: `pr-${number}`, number, title: `PR ${number}`, url: `https://github.com/acme/web/pull/${number}`, status: "ready", reviewed: false, ...extra });
  const parent = member(41, { status: "tracked" });
  const child = member(43, { targetKey: null, status: null });
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url,
    stack: { members: [parent, member(42), child], index: 1, parent, children: [child] } }, {
    startTrackedReview: () => ({ ok: true }),
    startReview: () => ({ ok: true, targetKey: "pr-43" }),
  });
  expect(await slot.findByText("Stack · 2 of 3")).toBeTruthy();
  expect(slot.getByText("You haven’t reviewed #41, which this builds on.")).toBeTruthy();
  const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  fireEvent.click(slot.getByRole("button", { name: "Stacked on #41" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "pr-41" } }));
  expect(calls("startTrackedReview")).toEqual([{ targetKey: "pr-41" }]);
  fireEvent.click(slot.getByRole("button", { name: "#43 builds on this" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "pr-43" } }));
  expect(calls("startReview")).toEqual([{ input: "https://github.com/acme/web/pull/43" }]);
  slot.lifecycle.unmount();
});

test("a stack whose PR below you reviewed says nothing more", async () => {
  const parent = { targetKey: "pr-41", number: 41, title: "PR 41", url: null, status: "ready", reviewed: true };
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url,
    stack: { members: [parent, { ...parent, targetKey: "pr-42", number: 42 }], index: 1, parent, children: [] } });
  await slot.findByRole("button", { name: "Stacked on #41" });
  expect(slot.queryByText(/You haven’t reviewed/)).toBeNull();
  slot.lifecycle.unmount();
});

test("the Overview totals the changed lines worth reading, with a rough reading time", async () => {
  const patch = ["diff --git a/src/auth.ts b/src/auth.ts", "--- a/src/auth.ts", "+++ b/src/auth.ts", "@@ -1 +1,100 @@", "-old", ...Array.from({ length: 99 }, (_, i) => `+line ${i}`), "",
    "diff --git a/yarn.lock b/yarn.lock", "--- a/yarn.lock", "+++ b/yarn.lock", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, kind: "pr", title: "Fix token refresh race" }, guide, patch, revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
  } });
  const size = await slot.findByText("100 changed lines · about 15 min to read");
  expect(size.getAttribute("title")).toBe("Without lockfiles and generated files. Reading time at about 400 changed lines an hour.");
  slot.lifecycle.unmount();
});

test("the status line says whose turn it is, how your feedback fared and how the checks are, as words beside icons, not pills", async () => {
  const slot = await renderWorkspace({
    kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url, submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY, signals: { requestedBy: "alice", ci: "pass" },
    turn: { group: "needs", reason: "re-requested", label: "Re-requested", signal: "re-requested:1", at: now, notify: true, blocking: true, updated: true, eventAt: now, failed: false },
    progress: { done: 2, total: 2, source: "threads", nits: 1 },
  }, { getChecks: () => ({ bucket: "fail", checks: [{ name: "test", bucket: "fail", state: "FAILURE", link: "https://ci/1" }, { name: "lint", bucket: "pending", state: "PENDING" }, { name: "build", bucket: "pass", state: "SUCCESS" }] }) });
  // In the words All reviews uses (lib/status-line.ts), the checks as just read rather than as the last sync saw them.
  const status = within((await slot.findByText("Re-requested by @alice")).closest("p")!);
  expect(status.getByText("Blocks merge")).toBeTruthy();
  const checks = await status.findByText("Checks failing");
  expect(checks.closest("[title]")?.getAttribute("title")).toBe("test: fail\nlint: pending\nbuild: pass");
  for (const fact of ["Re-requested by @alice", "Blocks merge", "2/2 handled +1 nit", "Checks failing"]) expect(status.getByText(fact).closest("[class*='rounded-full']")).toBeNull();
  // The checks that need a look are listed, each linking to its run.
  const section = within(slot.getByRole("region", { name: "Checks" }));
  expect(section.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["testFailingView check", "lintPending"]);
  expect(section.getByRole("link", { name: "View check" }).getAttribute("href")).toBe("https://ci/1");
  // Your feedback's progress says what handled means, and opens it in Comments.
  const feedback = status.getByRole("button", { name: "2/2 handled +1 nit" });
  expect(feedback.getAttribute("title")).toBe("Resolved or answered. Show your feedback in Comments");
  fireEvent.click(feedback);
  const panel = within(await slot.findByRole("complementary", { name: "Comments and agent" }));
  await waitFor(() => expect(panel.getByRole("radio", { name: /^Needs you, \d+$/ }).getAttribute("aria-checked")).toBe("true"));
  slot.lifecycle.unmount();
});

test("passing checks are a fact in the status line, without a Checks section", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url }, { getChecks: () => ({ bucket: "pass", checks: [{ name: "build", bucket: "pass", state: "SUCCESS" }] }) });
  expect(await slot.findByText("Checks passing")).toBeTruthy();
  expect(slot.queryByRole("region", { name: "Checks" })).toBeNull();
  slot.lifecycle.unmount();
});

test("the Overview's sections come in order, then its chapters, each opening its chapter, with Medium and High risk said and Low left out", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url }, { getChecks: () => ({ bucket: "fail", checks: [{ name: "test", bucket: "fail", state: "FAILURE" }] }) }, {
    ...twoChapters,
    sinceReview: "The lock is released on error now.",
    hotspots: [{ file: "src/auth.ts", line: 3, why: "The lock outlives a failed refresh." }],
    requirements: [{ text: "One refresh at a time", status: "covered", evidence: "A lock.", file: "src/auth.ts", line: 3 }],
  });
  await slot.findByRole("region", { name: "Checks" });
  const regions = main(slot).getAllByRole("region").map((region) => region.getAttribute("aria-labelledby") && document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent);
  expect(regions).toEqual(["Since your review", "What and why", "Start here", "Requirements\u00a0· 1 of 1 covered", "Checks", "Chapters"]);
  const chapters = within(main(slot).getByRole("region", { name: "Chapters" }));
  const [refresh, retry] = chapters.getAllByRole("button");
  expect(refresh.textContent).not.toContain("risk");
  expect(retry.textContent).toContain("High risk");
  expect(retry.textContent).toContain("1 skippable");
  fireEvent.click(retry);
  await waitFor(() => expect(main(slot).getByRole("region", { name: "Retry" })).toBeTruthy());
  slot.lifecycle.unmount();
});

test("the way in goes to chapter 1, and once you've read a chapter, back on the Overview it continues there", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url }, {}, twoChapters);
  fireEvent.click(await slot.findByRole("button", { name: "Start reading: Refresh" }));
  await main(slot).findByRole("region", { name: "Refresh" });
  fireEvent.keyDown(document.body, { key: "n" });
  await main(slot).findByRole("region", { name: "Retry" });
  // p twice: chapter 1, then the Overview before it.
  fireEvent.keyDown(document.body, { key: "p" });
  fireEvent.keyDown(document.body, { key: "p" });
  fireEvent.click(await slot.findByRole("button", { name: "Continue: Refresh" }));
  await main(slot).findByRole("region", { name: "Refresh" });
  slot.lifecycle.unmount();
});

test("every fact the 0.5.2 header showed is on the Overview", async () => {
  patchReviewState("pr-42", { activeId: "overview" });
  const parent = { targetKey: "pr-41", number: 41, title: "PR 41", url: null, status: "ready", reviewed: false };
  const slot = await renderWorkspace({
    kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url, author: "octo", base: "main", head: "fix-race",
    submittedVerdict: "REQUEST_CHANGES", submittedAt: now - DAY,
    turn: { group: "needs", reason: "re-requested", label: "Re-requested", signal: "re-requested:1", at: now, notify: true, blocking: true, updated: true, eventAt: now, failed: false },
    progress: { done: 1, total: 3, source: "assistant" },
    signals: { lastReviewSha: "old", rounds: [{ state: "CHANGES_REQUESTED", at: now - DAY, sha: "old" }] },
    stack: { members: [parent, { ...parent, targetKey: "pr-42", number: 42 }], index: 1, parent, children: [] },
  }, { getChecks: () => ({ bucket: "pass", checks: [{ name: "build", bucket: "pass", state: "SUCCESS" }] }) }, {
    ...guide,
    sinceReview: "The lock is released on error now.",
    hotspots: [{ file: "src/auth.ts", line: 3, why: "The lock outlives a failed refresh." }],
    requirements: [{ text: "One refresh at a time", status: "partial", evidence: "Only in the client." }],
  });
  const overview = within(await slot.findByRole("main", { name: "Review" }));
  expect((await overview.findByRole("link", { name: "Fix token refresh race" })).getAttribute("href")).toBe(url);
  for (const fact of ["@octo", "acme/web", "#42", "main", "fix-race", "Re-requested", "Blocks merge", "1/3 addressed", "Checks passing", "Stack · 2 of 2", "Serializes token refreshes.", "The lock is released on error now.", "The lock outlives a failed refresh.", "One refresh at a time", "Only in the client."]) {
    expect(overview.getByText(fact)).toBeTruthy();
  }
  expect(overview.getByRole("list", { name: "Your reviews" }).textContent).toBe("Changes requested 1d ago");
  expect(overview.getByText("You haven’t reviewed #41, which this builds on.")).toBeTruthy();
  expect(overview.getByRole("button", { name: "Snooze" })).toBeTruthy();
  slot.lifecycle.unmount();
});
