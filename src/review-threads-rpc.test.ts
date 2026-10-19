import { test, expect, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";
import { createStore } from "./store";

const node = (id: string) => ({ id, isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [{ id: `${id}-c`, databaseId: 1, author: { login: "alice" }, body: id }] } });
const page = (ids: string[], endCursor: string | null) =>
  ({ code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!endCursor, endCursor }, nodes: ids.map(node) } } } } }) });

async function setup() {
  runGh.mockReset();
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  createStore(bb).saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, createdAt: 1, status: "ready" });
  return (input: unknown) => harness.behavior.callRpc("getReviewThreads", input) as Promise<any>;
}

test("getReviewThreads reads every page of threads", async () => {
  const call = await setup();
  runGh.mockResolvedValueOnce(page(["t1", "t2"], "c1")).mockResolvedValueOnce(page(["t3"], null));
  const result = await call({ targetKey: "pr-1" });
  expect(result.threads.map((t: any) => t.id)).toEqual(["t1", "t2", "t3"]);
  expect(result.error).toBeUndefined();
  expect(runGh.mock.calls[1][0].slice(-2)).toEqual(["-f", "after=c1"]);
});

test("getReviewThreads says when GitHub couldn't be read, keeping the pages it got", async () => {
  const call = await setup();
  runGh.mockResolvedValueOnce({ code: 1, stderr: "HTTP 502: Bad Gateway", stdout: "" });
  expect(await call({ targetKey: "pr-1" })).toEqual({ threads: [], error: "HTTP 502: Bad Gateway" });
  runGh.mockResolvedValueOnce(page(["t1"], "c1")).mockResolvedValueOnce({ code: 1, stderr: "gh timed out after 120s", stdout: "" });
  const partial = await call({ targetKey: "pr-1" });
  expect(partial.threads.map((t: any) => t.id)).toEqual(["t1"]);
  expect(partial.error).toBe("gh timed out after 120s");
});

const at = (day: number) => `2026-10-0${day}T00:00:00Z`;

test("getReviewThreads reads where each thread was, who resolved it, and who wrote each comment when", async () => {
  const call = await setup();
  const nodes = [
    { id: "t1", isResolved: true, isOutdated: true, path: "a.ts", line: null, diffSide: "LEFT", originalLine: 7, startLine: null, subjectType: "LINE", resolvedBy: { login: "alice" },
      comments: { nodes: [
        { id: "c1", databaseId: 1, author: { __typename: "User", login: "me" }, body: "Why?", createdAt: at(1) },
        { id: "c2", databaseId: 2, author: { __typename: "Bot", login: "ci" }, body: "Build passed", createdAt: at(2) },
        { id: "c3", databaseId: 3, author: { __typename: "User", login: "dependabot[bot]" }, body: "Bumped", createdAt: at(3) },
      ] } },
    { id: "t2", isResolved: false, isOutdated: false, path: "b.ts", line: 9, diffSide: "RIGHT", originalLine: 9, startLine: 4, subjectType: "LINE", resolvedBy: null,
      comments: { nodes: [{ id: "c4", databaseId: 4, author: null, body: "These lines", createdAt: at(4) }] } },
    { id: "t3", isResolved: false, isOutdated: false, path: "c.ts", line: null, diffSide: "RIGHT", originalLine: null, startLine: null, subjectType: "FILE", resolvedBy: null,
      comments: { nodes: [{ id: "c5", databaseId: 5, author: { __typename: "User", login: "bob" }, body: "The whole file", createdAt: at(5) }] } },
  ];
  runGh.mockResolvedValueOnce({ code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }) });
  expect((await call({ targetKey: "pr-1" })).threads).toEqual([
    { id: "t1", isResolved: true, isOutdated: true, path: "a.ts", line: null, side: "LEFT", originalLine: 7, startLine: null, subjectType: "LINE", resolvedBy: "alice", comments: [
      { id: "c1", databaseId: 1, author: "me", body: "Why?", createdAt: Date.parse(at(1)), bot: false },
      { id: "c2", databaseId: 2, author: "ci", body: "Build passed", createdAt: Date.parse(at(2)), bot: true },
      { id: "c3", databaseId: 3, author: "dependabot[bot]", body: "Bumped", createdAt: Date.parse(at(3)), bot: true },
    ] },
    // A deleted account wrote it: GitHub sends no author.
    { id: "t2", isResolved: false, isOutdated: false, path: "b.ts", line: 9, side: "RIGHT", originalLine: 9, startLine: 4, subjectType: "LINE", resolvedBy: null, comments: [
      { id: "c4", databaseId: 4, author: "unknown", body: "These lines", createdAt: Date.parse(at(4)) },
    ] },
    { id: "t3", isResolved: false, isOutdated: false, path: "c.ts", line: null, side: "RIGHT", originalLine: null, startLine: null, subjectType: "FILE", resolvedBy: null, comments: [
      { id: "c5", databaseId: 5, author: "bob", body: "The whole file", createdAt: Date.parse(at(5)), bot: false },
    ] },
  ]);
});

test("getReviewThreads still reads a response without those fields, as before", async () => {
  const call = await setup();
  runGh.mockResolvedValueOnce(page(["t1"], null));
  expect(await call({ targetKey: "pr-1" })).toEqual({ threads: [
    { id: "t1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, side: "RIGHT", comments: [{ id: "t1-c", databaseId: 1, author: "alice", body: "t1" }] },
  ] });
});

test("re-reading your threads writes nothing for a review deleted while GitHub answered", async () => {
  runGh.mockReset();
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, createdAt: 1, status: "ready" });
  store.setLifecycle("pr-1", { submittedVerdict: "COMMENT", submittedAt: 5, signals: { lastReviewAt: 5 } });
  runGh.mockImplementation(async (args: string[]) => {
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "me\n" };
    store.deleteReview("pr-1");
    return { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{
      id: "t1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, originalLine: 1, startLine: null, diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
      first: { nodes: [{ id: "c1", databaseId: 1, author: { login: "me" }, body: "Fix", createdAt: "2026-10-01T00:00:00Z", pullRequestReview: { id: "r1" } }] }, recent: { nodes: [] },
    }] } } } } }) };
  });
  await harness.behavior.callRpc("refreshFeedback", { targetKey: "pr-1" });
  expect(store.listFeedbackThreads("pr-1")).toEqual([]);
  expect(store.feedbackFetched("pr-1")).toBeNull();
});

test("re-reading your threads tells open review pages only when they changed", async () => {
  runGh.mockReset();
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, createdAt: 1, status: "ready" });
  store.setLifecycle("pr-1", { submittedVerdict: "COMMENT", submittedAt: 5, signals: { lastReviewAt: 5 } });
  let body = "Fix";
  runGh.mockImplementation(async (args: string[]) => args[1] === "user" ? { code: 0, stderr: "", stdout: "me\n" }
    : { code: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{
      id: "t1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, originalLine: 1, startLine: null, diffSide: "RIGHT", subjectType: "LINE", resolvedBy: null,
      first: { nodes: [{ id: "c1", databaseId: 1, author: { login: "me" }, body, createdAt: "2026-10-01T00:00:00Z", pullRequestReview: { id: "r1" } }] }, recent: { nodes: [] },
    }] } } } } }) });
  const told = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === "feedback:pr-1").length;
  const refreshed = await harness.behavior.callRpc("refreshFeedback", { targetKey: "pr-1" }) as any;
  expect(refreshed.feedback).toBeDefined();
  expect(store.listFeedbackThreads("pr-1")).toHaveLength(1);
  expect(told()).toBe(1);
  await harness.behavior.callRpc("refreshFeedback", { targetKey: "pr-1" });
  expect(told()).toBe(1);
  body = "Fix, please";
  await harness.behavior.callRpc("refreshFeedback", { targetKey: "pr-1" });
  expect(told()).toBe(2);
});
