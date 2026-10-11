// @vitest-environment jsdom
import { test, expect, afterEach } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
afterEach(() => { cleanup(); localStorage.clear(); });

const url = "https://github.com/acme/web/pull/42";
const guide = {
  title: "Guide", intent: "Serializes token refreshes.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Refresh", overview: "One in-flight refresh.", diffs: [{ file: "src/auth.ts", summary: "Lock" }] }],
};

function renderWorkspace(review: Record<string, unknown>, rpc: Record<string, (input: any) => unknown> = {}) {
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    ...rpc,
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, ...review }, guide, patch: "", revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getConversation: () => ({ threadId: null, legacy: [], defaults: null }),
  } }));
}

test("a PR review's title opens the pull request on GitHub, including in focus mode", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url });
  const link = await slot.findByRole("link", { name: "Fix token refresh race" });
  expect(link.getAttribute("href")).toBe(url);
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });

  fireEvent.click(slot.getByRole("button", { name: "Focus mode" }));
  expect(slot.queryByRole("heading", { name: "Fix token refresh race" })).toBeNull();
  expect(slot.getByRole("link", { name: "Fix token refresh race" }).getAttribute("href")).toBe(url);
  slot.lifecycle.unmount();
});

test("a local review's title stays plain text", async () => {
  const slot = await renderWorkspace({ kind: "ref", gitRef: "main...feature", title: "Local change" });
  await slot.findByRole("heading", { name: "Local change" });
  expect(slot.queryByRole("link", { name: "Local change" })).toBeNull();
  slot.lifecycle.unmount();
});

test("the header shows the PR's stack, opens or starts its neighbours, and says when the PR below wasn't reviewed", async () => {
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

test("the header totals the changed lines worth reading, with a rough reading time", async () => {
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
  const size = await slot.findByText("100 changed lines · about 15 min");
  expect(size.getAttribute("title")).toBe("Without lockfiles and generated files. Reading time at about 400 changed lines an hour.");
  slot.lifecycle.unmount();
});
