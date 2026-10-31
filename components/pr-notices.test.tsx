// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { defaultPreferences } from "../src/preferences";
import { patchReviewState } from "../lib/panel-state";
import type { FeatureCheck } from "../src/feature-review";
import { becameText } from "./shell/PrNotices";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => <div data-testid="filediff" /> }));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

const KEY = "br-1";
const URL = "https://github.com/acme/api/pull/4512";
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+aa\n";
const guide = { title: "Snooze flaky checks", intent: "Snoozes checks.", unplacedFiles: [] as string[], sections: [{ id: "c1", title: "Snooze", overview: "", diffs: [{ file: "src/a.ts" }] }] };
const feature = { environmentId: "env1", hostId: "host_max", machine: "MaxBook", path: "/Users/me/src/api", branch: "bb/snooze-checks-thr_ab12", baseRef: "main", repo: "acme/api" };
const local = { targetKey: KEY, kind: "ref", gitRef: feature.branch, status: "ready", createdAt: 1, title: "Snooze flaky checks", feature, mainThread: { threadId: "main", environmentId: "env1", origin: "adopted", since: 1 } };
const converted = { ...local, kind: "pr", repo: "acme/api", number: 4512, url: URL, gitRef: "main...feat/snooze", ownPr: true };
const nothing: FeatureCheck = { state: "current", alsoActive: [], hidden: [], flagged: [] };
const became = { at: 1, number: 4512, url: URL, from: "api:snooze-checks", carried: 6, local: 2, outside: 1 };

async function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, unknown> = {}) {
  patchReviewState(KEY, { activeId: "c1" });
  const app = await loadPluginApp(() => import("../app"));
  const handlers = {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: vi.fn(() => ({ review, guide: structuredClone(guide), patch, revision: "r1" })),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/api", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    checkFeature: () => nothing,
    getDraft: () => ({ draft: { targetKey: KEY, verdict: "COMMENT", body: "", comments: [] }, stale: [] }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
    getGhAccounts: () => ({ active: "me", accounts: [{ login: "me", active: true }] }),
    getSourceThread: () => ({ thread: null }),
    getFeedback: () => ({ baseline: { sha: null, at: null, verdict: null }, head: null, items: [], run: null, suggestionInDraft: false, fetchedAt: null }),
    markSeen: () => ({ ok: true }),
    ...rpc,
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: KEY }, { rpc: handlers as any });
  await slot.findByTestId("filediff");
  return { slot, rpc: handlers };
}
const notice = (text: string) => document.querySelector<HTMLElement>(`[aria-label="${text}"]`) ?? Array.from(document.querySelectorAll<HTMLElement>("[aria-live=polite] > [role]")).find((row) => row.textContent?.includes(text))!;

test("Now PR #n's review names its id, says only what came along, where the comments the PR's diff doesn't have are, the id it had, and after a merge what moved and the verdict it didn't keep", () => {
  const text = (...args: Parameters<typeof becameText>) => {
    const shown = render(<p>{becameText(...args)}</p>);
    const said = shown.container.textContent;
    shown.unmount();
    return said;
  };
  const PR = "the PR’s own review";
  expect(text({ ...became, carried: 0, local: 0, outside: 0 }, "api#4512", PR)).toBe("Now PR #4512’s review, api#4512. It was api:snooze-checks, which still opens it.");
  expect(text({ ...became, carried: 1, local: 0, outside: 0 }, "api#4512", PR)).toBe("Now PR #4512’s review, api#4512, with 1 comment carried over. It was api:snooze-checks, which still opens it.");
  expect(text({ ...became, needsYou: 1, merged: { comments: 3, summary: true, sends: 1 } }, "api#4512", PR))
    .toBe("Now PR #4512’s review, api#4512, with 6 comments carried over, 2 not on GitHub yet. 1 is on a line the PR doesn’t have, under Needs you. It was api:snooze-checks, which still opens it. Merged with the PR’s own review: 3 comments, the summary and 1 Send moved here.");
  expect(text({ ...became, carried: 3, local: 0, outside: 3, needsYou: 1 }, "api#4512", PR))
    .toBe("Now PR #4512’s review, api#4512, with 3 comments carried over. 3 are on lines the PR doesn’t have: 1 under Needs you, the rest with your Sends. It was api:snooze-checks, which still opens it.");
  expect(text({ ...became, carried: 2, local: 0, outside: 2, needsYou: 0, merged: { comments: 0, summary: false, sends: 0, verdict: "REQUEST_CHANGES" } }, "api#4512", "another folder’s review, api:snooze-checks"))
    .toBe("Now PR #4512’s review, api#4512, with 2 comments carried over. 2 are on lines the PR doesn’t have, with your Sends. It was api:snooze-checks, which still opens it. Merged with another folder’s review, api:snooze-checks. Its verdict, Request changes, wasn’t kept.");
});

test("a review that became its PR's says so from what it stored: PR #4512 ↗, after a merge Earlier agent chat ↗ beside it, and Got it last; Needs you opens Comments there", async () => {
  const dismissBecame = vi.fn(() => ({ ok: true }));
  const { slot } = await renderWorkspace({ ...converted, became: { ...became, needsYou: 1, merged: { comments: 3, summary: true, sends: 1 } }, mergedFrom: [{ key: "pr-x", at: 2, id: "api#4512", agentThreadId: "agent-p" }] }, { dismissBecame });
  const now = await slot.findByRole("status", { name: "Now a PR" });
  expect(now.textContent).toContain("Now PR #4512’s review, api#4512, with 6 comments carried over, 2 not on GitHub yet. 1 is on a line the PR doesn’t have, under Needs you. It was api:snooze-checks, which still opens it. Merged with the PR’s own review: 3 comments, the summary and 1 Send moved here.");
  const github = within(now).getByRole("link", { name: "PR #4512" });
  expect(github.textContent).toBe("PR #4512 ↗");
  expect(github.getAttribute("href")).toBe(URL);
  expect(Array.from(now.querySelectorAll("a, button"), (element) => element.textContent)).toEqual(["Needs you", "PR #4512 ↗", "Earlier agent chat ↗", "Got it"]);
  fireEvent.click(within(now).getByRole("button", { name: "Earlier agent chat" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "agent-p", options: { split: true } });
  fireEvent.click(within(now).getByRole("button", { name: "Needs you" }));
  await waitFor(() => expect(slot.getByRole("radio", { name: /^Needs you/ }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(within(now).getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(dismissBecame).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
});

test("seen as it happens, the change is said once, by the stored notice", async () => {
  let review: Record<string, unknown> = local;
  const { slot } = await renderWorkspace({}, { getReviewBundle: vi.fn(() => ({ review, guide: structuredClone(guide), patch, revision: "r1" })) });
  review = { ...converted, became };
  await slot.emitRealtime(`review:${KEY}`, {});
  await slot.findByRole("status", { name: "Now a PR" });
  const more = slot.queryByRole("button", { name: /more notice/ });
  if (more) fireEvent.click(more);
  expect(slot.queryByText(/the PR’s\. It was/)).toBeNull();
  slot.lifecycle.unmount();
});

test("a converted review with no merge offers no agent chat", async () => {
  const { slot } = await renderWorkspace({ ...converted, became: { ...became, carried: 0, local: 0, outside: 0 } });
  const now = await slot.findByRole("status", { name: "Now a PR" });
  expect(now.textContent).toContain("Now PR #4512’s review, api#4512. It was api:snooze-checks, which still opens it.");
  expect(within(now).queryByRole("button", { name: "Earlier agent chat" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a folder's review whose PR has a review of its own says which stays, with Merge into one review, PR #4512’s review ↗ and Keep both", async () => {
  const mergeReviews = vi.fn(() => ({ ok: true, targetKey: KEY }));
  const offered = { ...local, prOffer: { key: "pr-x", number: 4512, url: URL, moves: { comments: 3, summary: true, sends: 0 } } };
  const { slot, rpc } = await renderWorkspace(offered, { mergeReviews });
  await slot.findByText("PR #4512 has its own review, with 3 comments and a summary. Merging keeps this one and archives that one.");
  const offer = notice("PR #4512 has its own review");
  expect(within(offer).getAllByRole("button").map((button) => button.textContent)).toEqual(["Merge into one review", "PR #4512’s review ↗", "Keep both"]);
  const merge = within(offer).getByRole("button", { name: "Merge into one review" });
  fireEvent.click(within(offer).getByRole("button", { name: "PR #4512’s review" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "pr-x" } });
  fireEvent.click(merge);
  await waitFor(() => expect(mergeReviews).toHaveBeenCalledWith({ targetKey: KEY }));
  await waitFor(() => expect(rpc.getReviewBundle.mock.calls.length).toBeGreaterThan(1));
  slot.lifecycle.unmount();
  cleanup();

  // Going into the PR's review, which began as another folder's, it says that one stays.
  const into = await renderWorkspace({ ...offered, prOffer: { ...offered.prOffer, intoPr: true } });
  await into.slot.findByText("PR #4512 has its own review, with 3 comments and a summary. Merging keeps that one and archives this one.");
  into.slot.lifecycle.unmount();
  cleanup();

  // Keep both: no offer, on either review, from then on.
  const keepBothReviews = vi.fn(() => ({ ok: true }));
  const keeping = await renderWorkspace(offered, { keepBothReviews });
  fireEvent.click(within(notice("PR #4512 has its own review")).getByRole("button", { name: "Keep both" }));
  await waitFor(() => expect(keepBothReviews).toHaveBeenCalledWith({ targetKey: KEY }));
  keeping.slot.lifecycle.unmount();
  cleanup();
  const kept = await renderWorkspace({ ...offered, mergeDeclined: "pr-x" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(kept.slot.queryByText(/has its own review/)).toBeNull();
  kept.slot.lifecycle.unmount();
});

test("under 440px wide, the merge offer's PR #4512’s review ↗ reads PR’s review ↗, as its sentence names the PR, so Keep both stays on the buttons' row", async () => {
  const offered = { ...local, prOffer: { key: "pr-x", number: 4512, url: URL, moves: { comments: 3, summary: true, sends: 0 } } };
  const { slot } = await renderWorkspace(offered);
  await slot.findByText(/^PR #4512 has its own review/);
  const link = within(notice("PR #4512 has its own review")).getByRole("button", { name: "PR #4512’s review" });
  expect(link.textContent).toBe("PR #4512’s review ↗");
  expect(link.querySelector("[class~='@max-[440px]/review:hidden']")?.textContent).toBe(" #4512");
  slot.lifecycle.unmount();
});

test("the PR's own review names its branch's local review and which stays, with Merge into one review, Local review ↗ and Keep both", async () => {
  const mergeReviews = vi.fn(() => ({ ok: true, targetKey: "br-2" }));
  const keepBothReviews = vi.fn(() => ({ ok: true }));
  const pr = { targetKey: KEY, kind: "pr", repo: "acme/api", number: 4512, url: URL, status: "ready", createdAt: 1, localReview: { targetKey: "br-2", id: "api:snooze-checks", comments: 1 } };
  const { slot } = await renderWorkspace(pr, { mergeReviews, keepBothReviews });
  await slot.findByText(/local review/);
  const offer = notice("This PR’s branch has a local review");
  expect(offer.textContent).toContain("This PR’s branch has a local review with 1 comment. Merging keeps that one and archives this one.");
  expect(within(offer).getAllByRole("button").map((button) => button.textContent)).toEqual(["Merge into one review", "Local review ↗", "Keep both"]);
  const open = within(offer).getByRole("button", { name: "Local review" });
  await waitFor(() => { act(() => { open.blur(); open.focus(); }); expect(slot.getByRole("tooltip").textContent).toContain("Go to api:snooze-checks"); });
  fireEvent.click(open);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: "br-2" } });
  fireEvent.click(within(offer).getByRole("button", { name: "Merge into one review" }));
  await waitFor(() => expect(mergeReviews).toHaveBeenCalledWith({ targetKey: KEY }));
  fireEvent.click(within(offer).getByRole("button", { name: "Keep both" }));
  await waitFor(() => expect(keepBothReviews).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
  cleanup();

  // The PR's review began as another folder's: this one stays.
  const into = await renderWorkspace({ ...pr, localReview: { ...pr.localReview, comments: 0, intoPr: true } });
  await into.slot.findByText("This PR’s branch has a local review. Merging keeps this one and archives that one.");
  into.slot.lifecycle.unmount();
  cleanup();

  // A local review of another branch, made this PR's with Make it PR #4512's review: named by its branch.
  const stacked = await renderWorkspace({ ...pr, localReview: { ...pr.localReview, branch: "part2" } });
  await stacked.slot.findByText(/is linked to this PR/);
  expect(notice("is linked to this PR").textContent).toContain("A local review of part2 with 1 comment is linked to this PR. Merging keeps that one and archives this one.");
  expect(stacked.slot.getByText("part2").className).toContain("font-mono");
  stacked.slot.lifecycle.unmount();
});

test("a PR opened before the review waits: Make it PR #12's review, or Not this one; one GitHub didn't answer for, Try again", async () => {
  const takePendingPr = vi.fn(() => ({ ok: true }));
  const dismissPendingPr = vi.fn(() => ({ ok: true }));
  const older = { number: 12, url: "https://github.com/acme/api/pull/12", why: "older", at: 1 };
  const { slot } = await renderWorkspace({ ...local, prPending: older }, { takePendingPr, dismissPendingPr });
  await slot.findByText("This branch has PR #12, opened before this review.");
  const pending = notice("This branch has PR #12, opened before this review.");
  fireEvent.click(within(pending).getByRole("button", { name: "Make it PR #12’s review" }));
  await waitFor(() => expect(takePendingPr).toHaveBeenCalledWith({ targetKey: KEY }));
  fireEvent.click(within(pending).getByRole("button", { name: "Not this one" }));
  await waitFor(() => expect(dismissPendingPr).toHaveBeenCalledWith({ targetKey: KEY }));
  slot.lifecycle.unmount();
  cleanup();

  // Declined, it says nothing more.
  const declined = await renderWorkspace({ ...local, prPending: { ...older, declined: true } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(declined.slot.queryByText(/opened before this review/)).toBeNull();
  declined.slot.lifecycle.unmount();
  cleanup();

  // From another branch, as a stacked branch's upstream: the same choice, naming that branch.
  const branch = await renderWorkspace({ ...local, prPending: { ...older, why: "branch", head: "part1" } }, { takePendingPr });
  await waitFor(() => expect(notice("PR #12 is from part1, not this branch.")).toBeTruthy());
  fireEvent.click(within(notice("PR #12 is from part1, not this branch.")).getByRole("button", { name: "Make it PR #12’s review" }));
  await waitFor(() => expect(takePendingPr).toHaveBeenCalledTimes(2));
  branch.slot.lifecycle.unmount();
  cleanup();

  const failing = vi.fn(() => ({ ok: false, error: "HTTP 502: Bad gateway" }));
  const error = await renderWorkspace({ ...local, prPending: { ...older, why: "error", error: "HTTP 502: Bad gateway" } }, { takePendingPr: failing });
  const alert = await error.slot.findByRole("alert");
  expect(alert.textContent).toContain("This branch has PR #12, but GitHub didn’t answer: HTTP 502: Bad gateway");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(failing).toHaveBeenCalledWith({ targetKey: KEY }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("HTTP 502: Bad gateway"));
  error.slot.lifecycle.unmount();
});

test("a review merged into another opens that one in its place, and says so", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pr-x" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: null, guide: null, patch: null, revision: "", mergedInto: { targetKey: KEY, id: "api#4512" } }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/api", account: "me" }),
  } as any });
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "review", options: { subPath: KEY, replace: true } }));
  expect(toast.info).toHaveBeenCalledWith("This review is part of api#4512 now.");
  slot.lifecycle.unmount();
});
