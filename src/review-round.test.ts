import { expect, test, vi } from "vitest";
import { folderHost, type Folder } from "./env-diff.test-support";
import { toolFailed } from "./fake-host.test-support";
import { register } from "./review-round";
import { testStore } from "./test-store.test-support";

const key = "br-review-round";
const owner = "goal-orchestrator";
const assistant = "review-assistant";
const finding = { file: "src/app.ts", line: 1, severity: "should-fix", body: "The new value drops required behavior." };

async function setup() {
  const folder: Folder = { files: [{ path: "src/app.ts" }] };
  const send = vi.fn(async (_request: { threadId: string; input: { text: string }[] }) => ({ delivery: "sent" }));
  const { bb, harness } = folderHost(folder, { threads: { send, get: async () => ({ archivedAt: null, deletedAt: null }) } });
  const store = testStore(bb);
  const fromOwnAgent = vi.fn(async (threadId: string) => threadId === assistant || threadId === "assistant-child");
  const { commands } = register({ bb, store, changed: vi.fn(), fromOwnAgent, gh: { runGh: vi.fn(), runGit: vi.fn() } });
  await store.saveReview({ targetKey: key, kind: "ref", createdAt: 1, status: "ready", projectId: "proj_api" });
  await store.setLifecycle(key, {
    mainThread: { threadId: "worker", environmentId: "env1", since: 1, origin: "adopted" },
    feature: { environmentId: "env1", hostId: "host_max", path: "/Users/me/src/api", machine: "MaxBook", branch: "feat/qa", baseRef: "main", repo: "acme/api" },
  });
  await store.setAssistantThread(key, assistant);
  const cli = (args: string[], threadId = owner) => commands.round(args, { threadId }, undefined);
  const start = async (...args: string[]) => {
    const result = await cli(["start", key, ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout!) as { review: string; roundId: string; diffHash: string };
  };
  const read = async (roundId: string) => {
    const result = await cli(["result", key, roundId]);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout!);
  };
  const finish = (roundId: string, findings: unknown[] = [], outcome = "complete", threadId = assistant) => harness.behavior.callAgentTool(
    "finish_review_round", { roundId, summary: "Reviewed the changes.", findings, outcome }, { threadId },
  );
  return { cli, start, read, finish, folder, store, send };
}

test("hands the goal requester a single complete batch and re-reviews the updated worktree", async () => {
  const s = await setup();
  const first = await s.start();
  expect(await s.start()).toEqual({ ...first, reused: true });
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(await s.read(first.roundId)).toEqual({ ...first, state: "pending" });
  expect(toolFailed(await s.finish(first.roundId, [], "complete", "worker"))).toBe(true);
  expect(toolFailed(await s.finish(first.roundId, [finding]))).toBe(false);
  expect(await s.read(first.roundId)).toEqual({ ...first, state: "complete", summary: "Reviewed the changes.", findings: [{ id: `${first.roundId}:1`, ...finding }] });
  expect(toolFailed(await s.finish(first.roundId))).toBe(true);
  expect(s.send.mock.calls.map(([request]) => request.threadId)).toEqual([assistant, owner]);
  expect(s.send.mock.calls[1]![0].input[0]!.text).not.toContain(finding.body);
  expect((await s.store.getReview(key))?.mainThread?.threadId).toBe("worker");
  expect((await s.store.getDraft(key)).comments).toEqual([]);

  s.folder.files[0]!.body = "@@ -1 +1 @@\n-a\n+fixed\n";
  expect(await s.read(first.roundId)).toEqual({ ...first, state: "stale" });
  const next = await s.start();
  expect(next.diffHash).not.toBe(first.diffHash);
  expect(await s.store.patch(key)).toContain("+fixed");
  expect(s.send.mock.calls[2]![0].input.some((part) => part.text.includes(finding.body))).toBe(true);
  expect((await s.cli(["result", key, first.roundId])).exitCode).toBe(1);
  expect(toolFailed(await s.finish(next.roundId))).toBe(false);
  expect(await s.read(next.roundId)).toEqual({ ...next, state: "complete", summary: "Reviewed the changes.", findings: [] });
});

test("an incomplete or replaced round cannot be treated as clean", async () => {
  const s = await setup();
  const first = await s.start();
  expect(toolFailed(await s.finish(first.roundId, [], "incomplete"))).toBe(false);
  expect(await s.read(first.roundId)).toMatchObject({ state: "incomplete", findings: [] });
  const pending = await s.start("--retry");
  const next = await s.start("--retry");
  expect(next.roundId).not.toBe(pending.roundId);
  expect(toolFailed(await s.finish(pending.roundId))).toBe(true);
  expect(await s.read(next.roundId)).toEqual({ ...next, state: "pending" });
  await s.store.savePatch(key, "a different diff is in the review now");
  expect(toolFailed(await s.finish(next.roundId))).toBe(true);
  expect(await s.read(next.roundId)).toEqual({ ...next, state: "stale" });
});

test("fails closed for assistant descendants and allows retrying a failed send", async () => {
  const s = await setup();
  expect((await s.cli(["start", key], "assistant-child")).exitCode).toBe(2);
  expect(s.send).not.toHaveBeenCalled();
  s.send.mockRejectedValueOnce(new Error("agent unavailable"));
  expect(await s.cli(["start", key])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agent unavailable") });
  const failed = (await s.store.getReview(key))!.reviewRound!;
  expect(await s.read(failed.id)).toMatchObject({ state: "failed", error: "agent unavailable" });
  const retried = await s.start();
  expect(retried.roundId).not.toBe(failed.id);
  expect(await s.read(retried.roundId)).toMatchObject({ state: "pending" });
});
