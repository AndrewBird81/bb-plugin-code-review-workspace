// bb review ask and bb review approve, as another of your threads runs them, and Dismiss on a Ready to approve row.
import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const runGh = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })));
vi.mock("./gh", async (orig) => ({ ...(await orig<any>()), runGh, runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) }));
vi.mock("./store-queue", async (original) => {
  const actual = await original<typeof import("./store-queue")>();
  return { ...actual, queueStore: vi.fn(actual.queueStore) };
});

import { startPlugin } from "./plugin-store.test-support";
import { agentChat, MARK_PART } from "./agent-chat.test-support";

async function setup() {
  const chat = agentChat("agent");
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    threads: { get: async () => ({ archivedAt: null, deletedAt: null, status: "idle", title: "Review agent: pr-1" }), ...chat.sdk },
  } as any });
  const store = await startPlugin(bb);
  const pr = async (number: number, extra: Record<string, unknown> = {}) => {
    await store.saveReview({ targetKey: `pr-${number}`, kind: "pr", repo: "acme/web", number, url: `https://github.com/acme/web/pull/${number}`, author: "alice", headSha: `sha${number}`, createdAt: 1, status: "ready", projectId: "p1" });
    await store.setLifecycle(`pr-${number}`, { prState: "OPEN", ownPr: false, ...extra });
  };
  const cli = (...argv: string[]) => harness.behavior.runCli(argv, { threadId: "thr_orchestrator", projectId: "p1" });
  return { store, chat, harness, pr, cli };
}

test("bb review approve says, a line each, what it lined up and what it couldn't, and why", async () => {
  const { store, pr, cli } = await setup();
  await pr(1);
  await pr(2, { ownPr: true });
  await pr(3, { prState: "MERGED" });
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...x", cwd: "/repo", status: "ready", createdAt: 1, projectId: "p1" });
  expect(await cli("approve", "pr-1", "acme/web#2", "pr-3", "ref-1", "pr-404")).toMatchObject({ exitCode: 1, stdout: [
    "web#1 (pr-1): Ready to approve in Needs review. Nothing posts until the reviewer approves it there.",
    "web#2 (pr-2): it's the reviewer's own PR, and GitHub allows only a Comment review on it.",
    "web#3 (pr-3): the PR is merged, so there's nothing to approve.",
    "repo:x (ref-1): a local review has nothing to approve on GitHub.",
    "pr-404: no saved review. Pass the PR's URL or the review's key.",
  ].join("\n") });
  expect((await store.getReview("pr-1"))?.readyToApprove).toMatchObject({ action: "approve", verdict: "APPROVE", body: "", headSha: "sha1", from: "thr_orchestrator" });
  expect(await cli("approve")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("usage: bb review approve") });
  expect(await cli("approve", "pr-1", "--body")).toMatchObject({ exitCode: 2, stderr: "--body needs text, given once." });
  expect(runGh).not.toHaveBeenCalledWith(expect.arrayContaining(["POST"]), expect.anything());
});

test("bb review ask relays the message to the review's agent, marked as from the thread that ran it, which it's told to answer", async () => {
  const { store, chat, pr, cli } = await setup();
  await pr(1);
  await store.setAssistantThread("pr-1", "agent");
  expect(await cli("ask", "pr-1", "is", "the", "retry", "safe?")).toMatchObject({ exitCode: 0, stdout: "Sent to the review agent of web#1 (pr-1). It answers this thread." });
  const request = chat.events.find((e) => e.type === "client/turn/requested")!;
  expect(request.data.input).toEqual([
    { type: "text", text: "is the retry safe?", mentions: [] },
    { type: "text", text: "Relayed with bb review ask from thread thr_orchestrator, one of the reviewer's. Answer that thread with `bb thread tell thr_orchestrator`.", mentions: [], visibility: "agent-only" },
    MARK_PART,
  ]);
  expect(await cli("ask", "pr-1")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("usage: bb review ask") });
  expect(await cli("ask", "pr-9", "hi")).toMatchObject({ exitCode: 1, stderr: "No saved review for pr-9. Pass the PR's URL or the review's key." });
});

test("from a thread a review's agent started, or one whose start bb can't say, nothing is lined up or relayed", async () => {
  const { store, chat, pr, cli } = await setup();
  await pr(1);
  await store.setAssistantThread("pr-1", "agent");
  chat.ancestors.thr_orchestrator = ["agent"];
  expect(await cli("approve", "pr-1")).toMatchObject({ exitCode: 2, stderr: "A review's own agent, or a thread it started, can't line up approvals." });
  expect(await cli("ask", "pr-1", "approve it")).toMatchObject({ exitCode: 2, stderr: "A review's own agent, or a thread it started, can't relay messages to a review's agent." });
  chat.ancestors.thr_orchestrator = null;
  expect(await cli("approve", "pr-1")).toMatchObject({ exitCode: 1, stderr: "bb couldn't say which threads this one was started from, so nothing was done. Try again in a moment." });
  expect((await store.getReview("pr-1"))?.readyToApprove).toBeFalsy();
  expect(chat.events).toEqual([]);
});

test("Dismiss takes the row out, only the one its token names", async () => {
  const { store, harness, pr, cli } = await setup();
  await pr(1);
  await cli("approve", "pr-1", "--body", "LGTM");
  const { token } = (await store.getReview("pr-1"))!.readyToApprove!;
  expect(await harness.behavior.callRpc("dismissReady", { targetKey: "pr-1", token: "other" })).toEqual({ ok: false, error: "This isn't waiting for your approval anymore." });
  expect(await harness.behavior.callRpc("dismissReady", { targetKey: "pr-1", token })).toEqual({ ok: true });
  expect((await store.getReview("pr-1"))?.readyToApprove).toBeNull();
  expect((await harness.behavior.callRpc("approveReady", { rows: [{ targetKey: "pr-1", token }] }) as any).results).toEqual([{ targetKey: "pr-1", outcome: "failed", error: "This isn't waiting for your approval anymore: it was approved, dismissed, or asked again." }]);
});
