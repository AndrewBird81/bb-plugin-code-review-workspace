// Replies and resolves on GitHub: posted as the account the page verified, and only on the review's own PR's threads.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh }));

import plugin from "../server";
import { createStore } from "./store";
import type { FeedbackThread } from "./github/types";

const feedbackThread: FeedbackThread = {
  id: "t-mine", commentId: 11, reviewId: null, path: "a.ts", line: 2, originalLine: 2, startLine: null, side: "RIGHT", subjectType: "LINE",
  body: "Why?", createdAt: 1, isResolved: false, resolvedBy: null, isOutdated: false, replies: [], status: "open", replyAt: null,
};
/** The PR's threads on GitHub: everyone's, read through the review threads query. */
const prThreads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
  { id: "t-alice", isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [{ id: "c1", databaseId: 21, author: { login: "alice" }, body: "Hm" }] } },
] } } } } });

async function setup() {
  runGh.mockReset();
  // gh on the server is signed in as "me" only.
  runGh.mockImplementation(async (args: string[], opts?: { authToken?: string }) => {
    if (args[0] === "auth" && args[1] === "token") return args.at(-1) === "me" ? { code: 0, stderr: "", stdout: "tok-me\n" } : { code: 1, stderr: "no account", stdout: "" };
    if (args[0] === "api" && args[1] === "user") return opts?.authToken === "tok-me" ? { code: 0, stderr: "", stdout: "me\n" } : { code: 1, stderr: "", stdout: "" };
    if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("reviewThreads"))) return { code: 0, stderr: "", stdout: prThreads };
    return { code: 0, stderr: "", stdout: "{}" };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, createdAt: 1, status: "ready", headSha: "sha1" });
  store.setLifecycle("pr-1", { submittedVerdict: "COMMENT", submittedAt: 10, submittedHeadSha: "sha1" });
  store.saveFeedbackThreads("pr-1", [feedbackThread], 1);
  const call = (method: string, input: Record<string, unknown>) => harness.behavior.callRpc(method, { targetKey: "pr-1", ...input }) as Promise<{ ok: boolean; error?: string }>;
  /** The writes that reached GitHub, with the token each carried. */
  const writes = () => runGh.mock.calls
    .filter(([args]) => args.includes("POST") || args.some((a: string) => /resolveReviewThread/.test(a)))
    .map(([args, opts]) => ({ write: args.find((a: string) => /replies|resolveReviewThread/.test(a)), token: opts?.authToken }));
  return { store, call, writes };
}

const cases = [
  { method: "replyToThread", input: { inReplyTo: 21, body: "Thanks", threadId: "t-alice" }, write: "repos/acme/web/pulls/1/comments/21/replies", reload: "Reload this review to reply." },
  { method: "replyToFeedback", input: { threadId: "t-mine", body: "Thanks" }, write: "repos/acme/web/pulls/1/comments/11/replies", reload: "Reload this review to reply." },
  { method: "resolveThread", input: { threadId: "t-alice" }, write: "resolveReviewThread", reload: "Reload this review to update its threads." },
  { method: "unresolveThread", input: { threadId: "t-mine" }, write: "unresolveReviewThread", reload: "Reload this review to update its threads." },
];

for (const { method, input, write, reload } of cases) {
  test(`${method} posts as the verified account, and refuses another account or none`, async () => {
    const { call, writes } = await setup();
    expect(await call(method, { ...input, account: "me" })).toMatchObject({ ok: true });
    expect(writes()).toEqual([{ write: expect.stringContaining(write), token: "tok-me" }]);
    // An account gh isn't signed in as on this server.
    expect(await call(method, { ...input, account: "someone-else" })).toEqual({ ok: false, error: expect.stringContaining("Check authentication on the BB server") });
    // A page from 0.7.0, which sends none.
    expect(await call(method, input)).toEqual({ ok: false, error: expect.stringContaining(reload) });
    expect(writes()).toHaveLength(1);
  });
}

test("resolving or unresolving a thread that isn't on the review's PR is refused", async () => {
  const { call, writes } = await setup();
  for (const method of ["resolveThread", "unresolveThread"]) {
    expect(await call(method, { threadId: "t-other-pr", account: "me" })).toEqual({ ok: false, error: "That thread isn't part of this review anymore. Refresh and try again." });
  }
  expect(writes()).toEqual([]);
});
