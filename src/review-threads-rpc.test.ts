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
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
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

test("re-reading your threads writes nothing for a review deleted while GitHub answered", async () => {
  runGh.mockReset();
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
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
